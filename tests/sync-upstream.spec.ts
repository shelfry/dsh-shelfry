/**
 * 上游同步体检脚本的单元测试。
 *
 * 脚本只读，真正风险在判断逻辑：基线取错会把整段历史当成新提交，保护清单
 * 判定错会把定制文件当成可整份跟随。这里覆盖分类函数、参数解析与报告渲染，
 * git 调用本身不做 mock。
 */

import { describe, expect, it } from 'vitest'
// @ts-expect-error -- 纯 .mjs 脚本，无类型声明
import {
  classifyCommit,
  classifyFile,
  formatReport,
  loadProtected,
  parseArgs,
  pickLatestTag,
  readBaselineFromUpstreamMd,
} from '../scripts/sync-upstream.mjs'

/** 保护清单构造：路径到合并策略。 */
function protectedMap(entries: Array<[string, 'manual' | 'rebuild']>): Map<string, string> {
  return new Map(entries)
}

describe('parseArgs', () => {
  it('无参数时全部取默认值', () => {
    expect(parseArgs([])).toEqual({ from: '', to: '', check: false, help: false })
  })

  it('解析 --from / --to / --check', () => {
    expect(parseArgs(['--from', 'v1.73.14', '--to', 'v1.73.20', '--check'])).toEqual({
      from: 'v1.73.14',
      to: 'v1.73.20',
      check: true,
      help: false,
    })
  })

  it('拒绝未知参数', () => {
    expect(parseArgs(['--apply']).error).toContain('未知参数')
  })

  it('缺少取值时返回错误', () => {
    expect(parseArgs(['--to']).error).toContain('缺少值')
    // 下一个参数是另一个开关时，不能被当成取值吞掉。
    expect(parseArgs(['--to', '--check']).error).toContain('缺少值')
  })

  it('拒绝含特殊字符的引用，避免命令注入', () => {
    expect(parseArgs(['--to', 'v1.73.20;rm']).error).toContain('不合法')
    expect(parseArgs(['--to', 'v1.73.20 && ls']).error).toContain('不合法')
  })
})

describe('pickLatestTag', () => {
  it('按数字比较大小，而不是字符串顺序', () => {
    const output = [
      'abc\trefs/tags/v1.73.9',
      'def\trefs/tags/v1.73.16',
      'ghi\trefs/tags/v1.73.14',
    ].join('\n')
    expect(pickLatestTag(output)).toBe('v1.73.16')
  })

  it('忽略非版本号标签与缺段的标签', () => {
    const output = [
      'abc\trefs/tags/v1.74.0',
      'def\trefs/tags/nightly',
      'ghi\trefs/tags/v1.73',
      'jkl\trefs/tags/v1.73.20-rc.1',
    ].join('\n')
    expect(pickLatestTag(output)).toBe('v1.74.0')
  })

  it('没有版本标签时返回 null', () => {
    expect(pickLatestTag('')).toBeNull()
    expect(pickLatestTag('abc\trefs/tags/latest')).toBeNull()
  })
})

describe('readBaselineFromUpstreamMd', () => {
  it('取同步记录表最后一行的目标版本', () => {
    const markdown = [
      '| 日期 | 上游范围 | 采纳提交 |',
      '|---|---|---|',
      '| 2026-11-07 | v1.73.7 → v1.73.14 | a,b |',
      '| 2026-11-20 | v1.73.14 -> v1.73.20 | c |',
    ].join('\n')
    expect(readBaselineFromUpstreamMd(markdown)).toBe('v1.73.20')
  })

  it('没有同步记录时返回 null', () => {
    expect(readBaselineFromUpstreamMd('# 上游同步规则\n\n暂无记录')).toBeNull()
    // 只有区间命令、没有表格行时也不能误判。
    expect(readBaselineFromUpstreamMd('git log v1.73.14..v1.73.20')).toBeNull()
  })
})

describe('loadProtected', () => {
  it('读取路径与合并策略', () => {
    const map = loadProtected({
      files: [
        { path: 'src/client/Market.module.css', merge: 'manual' },
        { path: 'client/client.js', merge: 'rebuild' },
      ],
    })
    expect(map.get('src/client/Market.module.css')).toBe('manual')
    expect(map.get('client/client.js')).toBe('rebuild')
    expect(map.size).toBe(2)
  })

  it('未知策略按人工合并处理', () => {
    const map = loadProtected({ files: [{ path: 'a.ts', merge: 'anything' }] })
    expect(map.get('a.ts')).toBe('manual')
  })

  it('格式不合法时抛出明确错误', () => {
    expect(() => loadProtected(null)).toThrow('缺少 files 数组')
    expect(() => loadProtected({})).toThrow('缺少 files 数组')
    expect(() => loadProtected({ files: 'x' })).toThrow('缺少 files 数组')
    expect(() => loadProtected({ files: [{}] })).toThrow('缺少 path')
    expect(() => loadProtected({ files: [{ path: '' }] })).toThrow('缺少 path')
  })
})

describe('classifyFile', () => {
  const empty = protectedMap([])

  it('上游仓库元信息跳过', () => {
    expect(classifyFile('README.md', empty).action).toBe('skip')
    expect(classifyFile('.github/workflows/release.yml', empty).action).toBe('skip')
    expect(classifyFile('package-lock.json', empty).action).toBe('skip')
    expect(classifyFile('.gitignore', empty).action).toBe('skip')
  })

  it('构建产物只重建，不参与文本合并', () => {
    expect(classifyFile('lib/index.js', empty).action).toBe('rebuild')
    expect(classifyFile('client/client.js', protectedMap([['client/client.js', 'rebuild']])).action).toBe('rebuild')
  })

  it('命中保护清单时禁止整文件覆盖', () => {
    const result = classifyFile('src/client/Market.module.css', protectedMap([['src/client/Market.module.css', 'manual']]))
    expect(result.action).toBe('manual')
    expect(result.reason).toContain('禁止整文件覆盖')
  })

  it('未列入清单但本地也改过时，保守判定为人工', () => {
    const result = classifyFile('src/install.ts', empty, true)
    expect(result.action).toBe('manual')
    expect(result.reason).toContain('本地也改过')
  })

  it('本地未改的普通文件可以整份跟随', () => {
    expect(classifyFile('src/install.ts', empty, false)).toEqual({
      action: 'follow',
      reason: '本地未改，可整份跟随',
    })
  })
})

describe('classifyCommit', () => {
  it('全部跟随建议直接 cherry-pick', () => {
    expect(classifyCommit([{ action: 'follow' }, { action: 'follow' }]).category).toBe('follow')
  })

  it('有任一人工文件就整体转人工，不能被跟随掩盖', () => {
    const result = classifyCommit([{ action: 'follow' }, { action: 'manual' }, { action: 'skip' }])
    expect(result.category).toBe('manual')
    expect(result.label).toContain('逐块合并')
  })

  it('只有构建产物时标记改后重建', () => {
    expect(classifyCommit([{ action: 'rebuild' }]).category).toBe('rebuild')
  })

  it('全部跳过或空提交都标记跳过', () => {
    expect(classifyCommit([{ action: 'skip' }]).category).toBe('skip')
    expect(classifyCommit([]).category).toBe('skip')
  })
})

describe('formatReport', () => {
  it('渲染区间、基线与逐文件结论', () => {
    const report = formatReport({
      from: 'v1.73.14',
      to: 'v1.73.20',
      baselineSource: 'UPSTREAM.md 同步记录',
      localDetection: '基线内容哈希比对',
      commits: [
        {
          short: 'abc1234',
          subject: 'fix: 设置页吸顶',
          label: '需人工逐块合并',
          files: [{ path: 'src/client/Market.module.css', action: 'manual', reason: '命中保护清单' }],
        },
      ],
    })

    expect(report).toContain('v1.73.14 → v1.73.20')
    expect(report).toContain('abc1234  fix: 设置页吸顶')
    expect(report).toContain('人工  src/client/Market.module.css')
    expect(report).toContain('32 项')
  })

  it('报告里标明本地改动检测方式', () => {
    const report = formatReport({
      from: 'v1.73.14',
      to: 'v1.73.15',
      baselineSource: '命令行 --from',
      localDetection: '基线内容哈希比对',
      commits: [],
    })
    expect(report).toContain('基线内容哈希比对')
    expect(report).toContain('提交 0 个')
  })

  it('跟随文件过多时按数量汇总，避免刷屏', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map(path => ({
      path,
      action: 'follow',
      reason: '本地未改，可整份跟随',
    }))
    const report = formatReport({
      from: 'v1.73.14',
      to: 'v1.73.15',
      baselineSource: '命令行 --from',
      localDetection: '基线内容哈希比对',
      commits: [{ short: 'abc1234', subject: 'fix: 通用修复', label: '建议直接 cherry-pick', files }],
    })
    expect(report).toContain('跟随  5 个文件：a.ts、b.ts、c.ts 等')
    // 折叠后不应再逐个列出每个跟随文件。
    expect(report).not.toContain('跟随  a.ts')
  })
})
