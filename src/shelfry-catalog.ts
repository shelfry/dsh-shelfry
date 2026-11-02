/**
 * shelfry 目录适配层。
 *
 * shelfry 的 dsh-shelfry.json 与市场内部使用的 Registry 是两份不同的契约：
 * 前者用单字母字段（i/n/d/s/t/vr/cmd）描述条目，后者要求 category、owner、
 * description 等结构化字段。本模块只做一次单向映射，并把外部输入的校验收在
 * 这里；抓取、重试与缓存仍留在 registry.ts。
 *
 * 字段对应关系：
 * - `i`  owner/repo，同时决定展示页与兜底安装源
 * - `n`  展示名（市场内部作为 name 使用）
 * - `d`  描述（shelfry 只提供一份文本，中英两栏共用）
 * - `s`  star 数
 * - `vr` 最新版本号
 * - `t`  条目类型，映射成市场分类 id
 * - `cmd` 源站给出的安装命令；其中若是普通 npm 包名，同时作为 npm 字段
 */
import { NPM_NAME_RE } from './sources.ts'
import type { Registry, RegistryPlugin } from './registry.ts'

/** shelfry 条目类型到市场分类 id 的映射；未知类型一律归入 other。 */
const TYPE_TO_CATEGORY: Record<string, string> = {
  'cordis-plugin': 'plugin',
  skill: 'skill',
}

/** 分类的本地化标签，只声明 shelfry 真正会产出的三个分类。 */
const CATEGORY_LABELS: Record<string, Record<string, string>> = {
  plugin: { zh: '插件', en: 'Plugins' },
  skill: { zh: '技能', en: 'Skills' },
  other: { zh: '其他', en: 'Other' },
}

/** 分类字典的输出顺序：插件、技能、其他。 */
const CATEGORY_ORDER = ['plugin', 'skill', 'other'] as const

/** `i` 字段的唯一合法形态：owner/repo。 */
const REPO_PATH_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u

/** 安装命令的前缀，源站与本地补全都按它拼接。 */
const INSTALL_PREFIX = 'dsh plugin --profile web add '

/** 安装命令里分隔「参数」与「安装源」的词。 */
const ADD_TOKEN = ' add '

/**
 * 判断一份 JSON 是否为 shelfry 目录。
 *
 * 只用结构特征，不依赖某个版本号：带 `entries` 数组且没有 `plugins` 数组的
 * 就是 shelfry 形态，旧目录照常走 `asRegistry`，两套夹具互不干扰。
 */
export function isShelfryCatalog(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const data = value as { entries?: unknown; plugins?: unknown }
  return Array.isArray(data.entries) && !Array.isArray(data.plugins)
}

/**
 * 把 shelfry 目录映射成市场内部的 Registry。
 *
 * @param value - 已经 `JSON.parse` 过的载荷。
 * @returns 条目已校验、分类已归一化的目录。
 * @throws 载荷不是对象、缺少 entries、或没有一条可用条目时抛出。
 */
export function asShelfryRegistry(value: unknown): Registry {
  if (typeof value !== 'object' || value === null) throw new Error('shelfry 目录不是对象')
  const data = value as { generatedAt?: unknown; entries?: unknown }
  if (!Array.isArray(data.entries)) throw new Error('shelfry 目录缺少 entries 数组')
  const plugins: RegistryPlugin[] = []
  for (const entry of data.entries) {
    const plugin = asShelfryPlugin(entry)
    if (plugin !== null) plugins.push(plugin)
  }
  if (plugins.length === 0) throw new Error('shelfry 目录里没有一条可用条目')
  return {
    updated: typeof data.generatedAt === 'string' ? data.generatedAt : '',
    count: plugins.length,
    categories: categoriesOf(plugins),
    plugins,
  }
}

/**
 * 单条 shelfry 条目转成 RegistryPlugin。
 *
 * @param entry - entries 数组里的一项，来源不可信，逐字段校验。
 * @returns 映射结果；缺少仓库路径或展示名时返回 null，由调用方跳过。
 */
export function asShelfryPlugin(entry: unknown): RegistryPlugin | null {
  if (typeof entry !== 'object' || entry === null) return null
  const row = entry as Record<string, unknown>
  const repo = typeof row.i === 'string' ? row.i.trim() : ''
  if (!REPO_PATH_RE.test(repo)) return null
  const name = typeof row.n === 'string' ? row.n.trim() : ''
  if (name === '') return null
  const npm = npmFromCommand(row.cmd)
  const text = typeof row.d === 'string' ? row.d.trim() : ''
  return {
    name,
    owner: repo.slice(0, repo.indexOf('/')),
    url: `https://github.com/${repo}`,
    category: categoryOf(row.t),
    description: { zh: text, en: text },
    npm,
    stars: starCountOf(row.s),
    version: typeof row.vr === 'string' && row.vr.trim() !== '' ? row.vr.trim() : null,
    icon: null,
    install: installCommandOf(row.cmd, npm, repo),
    added: '',
  }
}

/**
 * 条目类型转分类 id。
 *
 * @param type - shelfry 的 `t` 字段，可能是任何类型。
 */
export function categoryOf(type: unknown): string {
  if (typeof type !== 'string') return 'other'
  return TYPE_TO_CATEGORY[type] ?? 'other'
}

/**
 * 从安装命令里取出 npm 包名。
 *
 * 命令形如 `dsh plugin --profile web add @scope/name@1.2.3`；版本号与 tag 都要
 * 去掉，带变量的地址（`github:...#${DSH_PLUGIN_REF}`）和本地绝对路径都不是
 * npm 包名，返回 null 让安装回落到 GitHub 源。
 *
 * @param command - shelfry 的 `cmd` 字段，可能是任何类型。
 * @returns 合法 npm 包名，或 null。
 */
export function npmFromCommand(command: unknown): string | null {
  if (typeof command !== 'string') return null
  const index = command.indexOf(ADD_TOKEN)
  if (index < 0) return null
  const spec = stripSpecVersion(command.slice(index + ADD_TOKEN.length).trim())
  return NPM_NAME_RE.test(spec) ? spec : null
}

/**
 * 去掉安装源末尾的 `@版本` 或 `@tag`。
 *
 * 从下标 1 开始查找，避免把作用域包名开头的 `@` 当成版本分隔符。
 *
 * @param spec - 安装源，例如 `@scope/name@1.2.3`。
 */
export function stripSpecVersion(spec: string): string {
  const at = spec.indexOf('@', 1)
  return at === -1 ? spec : spec.slice(0, at)
}

/** 卡片上展示的安装命令：优先用源站给的，缺省时按 npm / GitHub 源补全。 */
function installCommandOf(command: unknown, npm: string | null, repo: string): string {
  if (typeof command === 'string' && command.trim() !== '') return command.trim()
  return `${INSTALL_PREFIX}${npm ?? `github:${repo}`}`
}

/** star 数只接受有限数字，其余一律当作「未知」而不是 0。 */
function starCountOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 按固定顺序收集实际出现过的分类，供筛选栏渲染。 */
function categoriesOf(plugins: readonly RegistryPlugin[]): Record<string, Record<string, string>> {
  const used = new Set<string>()
  for (const plugin of plugins) {
    const category = plugin.category
    if (typeof category === 'string') used.add(category)
    else for (const id of category) used.add(id)
  }
  const categories: Record<string, Record<string, string>> = {}
  for (const id of CATEGORY_ORDER) {
    if (used.has(id)) categories[id] = CATEGORY_LABELS[id]!
  }
  return categories
}
