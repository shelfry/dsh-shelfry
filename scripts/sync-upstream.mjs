/**
 * 上游同步体检：把 UPSTREAM.md 里的手工判断变成一条只读命令。
 *
 * 只做三件事：取上游版本区间、按提交列出改动文件、对照保护清单分类。
 * 不 cherry-pick、不写盘、不改工作区；真正的合并仍由人工执行。
 *
 * 用法：
 *   npm run sync:upstream
 *   npm run sync:upstream -- --to v1.73.20
 *   npm run sync:upstream -- --from v1.73.14 --to v1.73.20 --check
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录：本脚本位于 scripts/ 下。 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 保护清单路径。 */
const PROTECTED_PATH = fileURLToPath(new URL('../sync/protected.json', import.meta.url))

/** 同步记录路径，基线从这里读取。 */
const UPSTREAM_PATH = fileURLToPath(new URL('../UPSTREAM.md', import.meta.url))

/** 构建产物目录：只重建，不参与文本合并。 */
const GENERATED_PATHS = [/^lib\//u, /^client\//u]

/** 上游仓库元信息与锁定文件：不跟随。 */
const SKIP_RULES = [
  { pattern: /^(README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|LICENSE)/iu, reason: '上游仓库说明，非产品代码' },
  { pattern: /^\.github\//u, reason: '上游 CI 配置，与本仓库发布链路无关' },
  { pattern: /^docs\//u, reason: '上游文档' },
  { pattern: /^package-lock\.json$/u, reason: '依赖锁定文件，按本仓库依赖重新生成' },
  { pattern: /^\.gitignore$/u, reason: '版本管理配置，本仓库保留 lib/ 提交策略' },
]

/** 参数取值只允许版本号字符，避免命令注入。 */
const SAFE_REF = /^[A-Za-z0-9._-]+$/u

/** 帮助文本。 */
const HELP = `上游同步体检（只读，不改工作区）

用法：
  npm run sync:upstream
  npm run sync:upstream -- --to v1.73.20
  npm run sync:upstream -- --from v1.73.14 --to v1.73.20 --check

参数：
  --from <tag>   同步基线，默认读 UPSTREAM.md 同步记录的最后一行
  --to <tag>     目标版本，默认取上游远端最新的 vX.Y.Z 标签
  --check        报告后依次跑 test / typecheck / build:client 三道门
  -h, --help     显示本说明

分类含义：
  跟随   上游改了、本地未改，可整份跟随
  人工   命中保护清单或本地也改过，必须逐块合并
  重建   构建产物，改完源码后重新构建
  跳过   上游仓库元信息、CI 配置、锁定文件`

/**
 * 解析命令行参数。
 * @param {string[]} argv 不含 node 与脚本路径的参数
 * @returns {{ from: string, to: string, check: boolean, help: boolean, error?: string }}
 */
export function parseArgs(argv) {
  const result = { from: '', to: '', check: false, help: false }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--check') {
      result.check = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      result.help = true
      continue
    }
    if (arg === '--from' || arg === '--to') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) {
        return { ...result, error: `${arg} 缺少值` }
      }
      if (!SAFE_REF.test(value)) {
        return { ...result, error: `${arg} 的值不合法：${value}` }
      }
      if (arg === '--from') result.from = value
      else result.to = value
      index += 1
      continue
    }
    return { ...result, error: `未知参数：${arg}` }
  }

  return result
}

/**
 * 从 ls-remote 输出里挑出最大的上游版本标签。
 * @param {string} text `git ls-remote --tags --refs upstream` 的原始输出
 * @returns {string | null} 形如 `v1.73.20`；没有符合格式的标签时返回 null
 */
export function pickLatestTag(text) {
  const versions = []

  for (const line of text.split('\n')) {
    const match = /\trefs\/tags\/(v(\d+)\.(\d+)\.(\d+))\s*$/u.exec(line.trim())
    if (match === null) continue
    versions.push({
      tag: match[1],
      parts: [Number(match[2]), Number(match[3]), Number(match[4])],
    })
  }

  if (versions.length === 0) return null

  versions.sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      if (left.parts[index] !== right.parts[index]) return left.parts[index] - right.parts[index]
    }
    return 0
  })

  return versions[versions.length - 1].tag
}

/**
 * 从 UPSTREAM.md 的同步记录表里读取最后一次同步的目标版本。
 * @param {string} markdown 文档全文
 * @returns {string | null} 形如 `v1.73.14`；没有匹配行时返回 null
 */
export function readBaselineFromUpstreamMd(markdown) {
  const rowPattern = /\|\s*[^|\n]*\|\s*v\d+\.\d+\.\d+\s*(?:→|->)\s*(v\d+\.\d+\.\d+)\s*\|/gu
  let baseline = null

  for (const match of markdown.matchAll(rowPattern)) {
    baseline = match[1]
  }

  return baseline
}

/**
 * 读取并校验保护清单。
 * @param {unknown} json `sync/protected.json` 解析后的内容
 * @returns {Map<string, 'manual' | 'rebuild'>} 路径到合并策略
 */
export function loadProtected(json) {
  if (json === null || typeof json !== 'object' || !Array.isArray(json.files)) {
    throw new Error('保护清单格式不合法：缺少 files 数组')
  }

  const map = new Map()

  for (const entry of json.files) {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new Error('保护清单格式不合法：存在缺少 path 的条目')
    }
    map.set(entry.path, entry.merge === 'rebuild' ? 'rebuild' : 'manual')
  }

  return map
}

/**
 * 判断路径是否属于上游元信息类文件。
 * @param {string} path 仓库相对路径
 * @returns {string | null} 跳过原因；不需要跳过时返回 null
 */
export function skipReason(path) {
  for (const rule of SKIP_RULES) {
    if (rule.pattern.test(path)) return rule.reason
  }
  return null
}

/**
 * 给单个文件定行动作。
 * @param {string} path 仓库相对路径
 * @param {Map<string, 'manual' | 'rebuild'>} protectedMap 保护清单
 * @param {boolean} localChanged 本地相对基线是否改过该文件
 * @returns {{ action: 'follow' | 'manual' | 'rebuild' | 'skip', reason: string }}
 */
export function classifyFile(path, protectedMap, localChanged = false) {
  const generated = GENERATED_PATHS.some(pattern => pattern.test(path))
  if (generated) return { action: 'rebuild', reason: '构建产物，改完源码后重新构建' }

  const policy = protectedMap.get(path)
  if (policy === 'rebuild') return { action: 'rebuild', reason: '构建产物，改完源码后重新构建' }
  if (policy === 'manual') return { action: 'manual', reason: '命中保护清单，禁止整文件覆盖' }

  const reason = skipReason(path)
  if (reason !== null) return { action: 'skip', reason }
  if (localChanged) return { action: 'manual', reason: '本地也改过该文件，逐块核对后再合并' }

  return { action: 'follow', reason: '本地未改，可整份跟随' }
}

/**
 * 按文件动作汇总出一个提交的处理建议。
 * @param {Array<{ action: string }>} files 该提交涉及的每个文件的分类结果
 * @returns {{ category: 'follow' | 'manual' | 'rebuild' | 'skip', label: string }}
 */
export function classifyCommit(files) {
  if (files.length === 0) return { category: 'skip', label: '空提交，跳过' }
  if (files.some(file => file.action === 'manual')) return { category: 'manual', label: '需人工逐块合并' }
  if (files.some(file => file.action === 'rebuild')) return { category: 'rebuild', label: '改后重建' }
  if (files.every(file => file.action === 'skip')) return { category: 'skip', label: '跳过' }
  return { category: 'follow', label: '建议直接 cherry-pick' }
}

/** 动作名到报告里中文标签的映射。 */
const ACTION_LABEL = { follow: '跟随', manual: '人工', rebuild: '重建', skip: '跳过' }

/**
 * 渲染单个提交的报告片段。
 *
 * 需要人工或重建的文件逐个列出；跟随与跳过的文件数量多，按数量汇总，
 * 只预览前三个路径，避免一次发布几百个文件刷屏。
 * @param {{ short: string, subject: string, label: string, files: Array<{ path: string, action: string, reason: string }> }} commit 提交模型
 * @returns {string[]} 报告行
 */
function formatCommit(commit) {
  const lines = [`${commit.short}  ${commit.subject}`, `  结论：${commit.label}`]
  const grouped = { follow: [], skip: [] }

  for (const file of commit.files) {
    if (file.action === 'follow' || file.action === 'skip') {
      grouped[file.action].push(file.path)
      continue
    }
    lines.push(`  ${ACTION_LABEL[file.action] ?? file.action}  ${file.path}（${file.reason}）`)
  }

  for (const action of ['follow', 'skip']) {
    const paths = grouped[action]
    if (paths.length === 0) continue
    const preview = paths.slice(0, 3).join('、') + (paths.length > 3 ? ' 等' : '')
    lines.push(`  ${ACTION_LABEL[action]}  ${paths.length} 个文件：${preview}`)
  }

  lines.push('')
  return lines
}

/**
 * 渲染整份报告。
 * @param {{ from: string, to: string, baselineSource: string, localDetection: string, commits: Array<object> }} model 报告模型
 * @returns {string} 可直接打印的文本
 */
export function formatReport(model) {
  const heading = `上游同步体检：${model.from} → ${model.to}`
  const baseline = `同步基线：${model.from}（来源：${model.baselineSource}；本地改动检测：${model.localDetection}）`
  const total = `提交 ${model.commits.length} 个，涉及文件 ${model.commits.reduce((sum, commit) => sum + commit.files.length, 0)} 个`
  const lines = [heading, baseline, total, '']

  for (const commit of model.commits) lines.push(...formatCommit(commit))

  lines.push(
    '提醒：合并后跑三道门 —— npm test（含 32 项品牌防护）、npm run typecheck、npm run build:client。',
    '冲突时禁止 --theirs 或整份 checkout，必须逐块合并。',
  )

  return lines.join('\n')
}

/**
 * 执行 git 命令并返回标准输出。
 * @param {string[]} args git 参数
 * @returns {string} 命令输出
 */
function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
}

/**
 * 判断 git 引用是否存在。
 * @param {string} ref 引用名
 * @returns {boolean} 存在为 true
 */
function refExists(ref) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  })
  return result.status === 0
}

/**
 * 列出区间内每个提交的 sha、短 sha 与标题。
 * @param {string} from 基线引用
 * @param {string} to 目标引用
 * @returns {Array<{ sha: string, short: string, subject: string }>} 提交列表
 */
function listCommits(from, to) {
  const output = git(['log', '--no-merges', '--format=%H%x09%h%x09%s', `${from}..${to}`])
  if (output === '') return []

  return output.split('\n').map(line => {
    const [sha, short, ...subjectParts] = line.split('\t')
    return { sha, short, subject: subjectParts.join('\t') }
  })
}

/**
 * 列出单个提交改动的文件。
 * @param {string} sha 提交 sha
 * @returns {string[]} 仓库相对路径
 */
function filesOfCommit(sha) {
  const output = git(['show', '--name-only', '--format=', sha])
  return output.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/**
 * 检测候选文件里哪些在本地相对基线被改过。
 *
 * 本仓库与上游没有共同 Git 历史（上游提交是 cherry-pick 过来的），拿不到
 * merge-base，所以改用内容哈希：基线里存在该文件、且内容与 HEAD 不同，
 * 即视为本地改过。基线里没有的新文件不算本地改动。
 * @param {string} from 基线引用
 * @param {string[]} paths 待检测的仓库相对路径
 * @returns {Set<string>} 本地改动过的路径集合
 */
function detectLocalChanges(from, paths) {
  const changed = new Set()

  for (const path of paths) {
    const base = spawnSync('git', ['rev-parse', '--quiet', '--verify', `${from}:${path}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    if (base.status !== 0) continue

    const head = spawnSync('git', ['rev-parse', '--quiet', '--verify', `HEAD:${path}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    if (head.status !== 0 || base.stdout.trim() !== head.stdout.trim()) changed.add(path)
  }

  return changed
}

/**
 * 依次跑三道门。
 * @returns {boolean} 全部通过为 true
 */
function runGates() {
  for (const command of ['test', 'run typecheck', 'run build:client']) {
    const result = spawnSync('npm', command.split(' '), { cwd: REPO_ROOT, stdio: 'inherit' })
    if (result.status !== 0) {
      console.error(`[sync-upstream] 门禁未通过：npm ${command}`)
      return false
    }
  }
  return true
}

/** 主流程：解析参数、取区间、分类、打印报告。 */
function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.error !== undefined) {
    console.error(`[sync-upstream] ${args.error}`)
    process.exitCode = 2
    return
  }
  if (args.help) {
    console.log(HELP)
    return
  }

  const protectedMap = loadProtected(JSON.parse(readFileSync(PROTECTED_PATH, 'utf8')))
  const upstreamMd = readFileSync(UPSTREAM_PATH, 'utf8')

  const baselineSource = args.from === '' ? 'UPSTREAM.md 同步记录' : '命令行 --from'
  const from = args.from === '' ? readBaselineFromUpstreamMd(upstreamMd) : args.from
  if (from === null) {
    console.error('[sync-upstream] 无法确定同步基线：请在 UPSTREAM.md 同步记录里补一行，或用 --from 指定')
    process.exitCode = 2
    return
  }

  if (!refExists(from)) {
    console.error(`[sync-upstream] 本地没有 ${from}，先执行 git fetch upstream --tags`)
    process.exitCode = 2
    return
  }

  git(['fetch', 'upstream', '--tags', '--quiet'])
  const to = args.to === '' ? pickLatestTag(git(['ls-remote', '--tags', '--refs', 'upstream'])) : args.to
  if (to === null) {
    console.error('[sync-upstream] 上游没有找到形如 vX.Y.Z 的标签')
    process.exitCode = 2
    return
  }
  if (!refExists(to)) {
    console.error(`[sync-upstream] 本地没有 ${to}，先执行 git fetch upstream --tags`)
    process.exitCode = 2
    return
  }

  const commits = listCommits(from, to).map(commit => ({
    ...commit,
    paths: filesOfCommit(commit.sha),
  }))
  const candidates = [...new Set(commits.flatMap(commit => commit.paths))]
  const localChanged = detectLocalChanges(from, candidates)
  const modeled = commits.map(commit => {
    const files = commit.paths.map(path => ({
      path,
      ...classifyFile(path, protectedMap, localChanged.has(path)),
    }))
    return { ...commit, files, ...classifyCommit(files) }
  })

  console.log(
    formatReport({
      from,
      to,
      baselineSource,
      localDetection: '基线内容哈希比对',
      commits: modeled,
    }),
  )

  if (args.check && !runGates()) process.exitCode = 1
}

// 仅在被直接执行时跑主流程，供测试导入纯函数。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
