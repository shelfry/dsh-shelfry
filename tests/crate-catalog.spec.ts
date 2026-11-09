/**
 * crate 目录适配层。
 *
 * 这一层是「外部 JSON → 内部 Registry」的唯一入口，所以三类用例都要有：
 * 正常字段映射、边界输入（缺字段 / 类型不对 / 脏条目）、异常载荷（结构不对
 * 或一条可用条目都没有）。取值全部贴近真实数据，避免夹具自己发明一套契约。
 */
import { describe, expect, it } from 'vitest'
import {
  asCratePlugin,
  asCrateRegistry,
  categoryOf,
  isCrateCatalog,
  npmFromCommand,
  stripSpecVersion,
} from '../src/crate-catalog.ts'

/** 一条完整的 crate 条目。 */
const FULL_ENTRY = {
  i: 'EthanYoQ/AI-Novel-Writer',
  n: 'AI-Novel-Writer',
  d: '安装专用 AI 小说创作预设与工作台',
  s: 1856,
  sc: 98.9,
  t: 'cordis-plugin',
  vr: '0.1.0',
  g: null,
  cmd: 'dsh plugin --profile web add @ethanyoq/dsh-ai-novel-writer',
}

/** 一份最小的 crate 载荷。 */
const CATALOG = {
  schemaVersion: 2,
  generatedAt: '2026-11-01T06:13:59.996Z',
  total: 2000,
  entries: [FULL_ENTRY],
}

describe('isCrateCatalog', () => {
  it('识别带 entries 的 crate 载荷', () => {
    expect(isCrateCatalog(CATALOG)).toBe(true)
  })

  it('不认识旧的 plugins 载荷', () => {
    expect(isCrateCatalog({ updated: 'x', count: 1, plugins: [] })).toBe(false)
  })

  it('同时带两种字段时按旧目录处理', () => {
    // 两个字段同时出现说明来源已经不认识了，交给旧适配器去报错，
    // 而不是在这里猜它想说什么。
    expect(isCrateCatalog({ entries: [], plugins: [] })).toBe(false)
  })

  it('对非对象输入返回 false', () => {
    for (const value of [null, undefined, 42, 'x', [], [FULL_ENTRY]]) {
      expect(isCrateCatalog(value)).toBe(false)
    }
  })
})

describe('asCrateRegistry', () => {
  it('把条目字段映射成内部 Registry', () => {
    const registry = asCrateRegistry(CATALOG)
    expect(registry.updated).toBe('2026-11-01T06:13:59.996Z')
    expect(registry.count).toBe(1)
    expect(registry.plugins[0]).toMatchObject({
      name: 'AI-Novel-Writer',
      owner: 'EthanYoQ',
      url: 'https://github.com/EthanYoQ/AI-Novel-Writer',
      category: 'plugin',
      npm: '@ethanyoq/dsh-ai-novel-writer',
      stars: 1856,
      version: '0.1.0',
      install: 'dsh plugin --profile web add @ethanyoq/dsh-ai-novel-writer',
    })
    // crate 只提供一份描述，中英两栏共用同一段文本。
    expect(registry.plugins[0]?.description).toEqual({
      zh: '安装专用 AI 小说创作预设与工作台',
      en: '安装专用 AI 小说创作预设与工作台',
    })
  })

  it('只声明实际出现过的分类，且顺序固定', () => {
    const registry = asCrateRegistry({
      ...CATALOG,
      entries: [
        { ...FULL_ENTRY, n: 'a', i: 'o/a', t: 'skill' },
        { ...FULL_ENTRY, n: 'b', i: 'o/b', t: 'unknown' },
        { ...FULL_ENTRY, n: 'c', i: 'o/c', t: 'cordis-plugin' },
        { ...FULL_ENTRY, n: 'd', i: 'o/d', t: 'theme' },
      ],
    })
    expect(Object.keys(registry.categories)).toEqual(['plugin', 'skill', 'theme', 'other'])
    expect(registry.categories.plugin).toEqual({ zh: '插件', en: 'Plugins' })
    expect(registry.categories.theme).toEqual({ zh: '主题', en: 'Themes' })
  })

  it('跳过脏条目但保留可用条目', () => {
    const registry = asCrateRegistry({
      ...CATALOG,
      entries: [
        { ...FULL_ENTRY, i: 'not-a-repo' },
        { ...FULL_ENTRY, n: '' },
        null,
        'x',
        { ...FULL_ENTRY, i: 'o/kept', n: 'kept' },
      ],
    })
    expect(registry.plugins.map(plugin => plugin.name)).toEqual(['kept'])
  })

  it('缺 generatedAt 时 updated 留空，不编造时间', () => {
    const registry = asCrateRegistry({ entries: [FULL_ENTRY] })
    expect(registry.updated).toBe('')
  })

  it('一条可用条目都没有时抛出', () => {
    expect(() => asCrateRegistry({ ...CATALOG, entries: [] })).toThrow(/没有一条可用条目/)
    expect(() => asCrateRegistry({ ...CATALOG, entries: [{ i: 'x' }, null] })).toThrow(/没有一条可用条目/)
  })

  it('载荷结构不对时抛出', () => {
    expect(() => asCrateRegistry(null)).toThrow(/不是对象/)
    expect(() => asCrateRegistry({ generatedAt: 'x' })).toThrow(/缺少 entries/)
    expect(() => asCrateRegistry({ entries: 'x' })).toThrow(/缺少 entries/)
  })
})

describe('asCratePlugin', () => {
  it('缺 stars 与 version 时留 null，不写成 0', () => {
    const plugin = asCratePlugin({ i: 'o/a', n: 'a' })
    expect(plugin?.stars).toBeNull()
    expect(plugin?.version).toBeNull()
  })

  it('拒绝不带 owner/repo 的仓库路径', () => {
    expect(asCratePlugin({ i: 'owner', n: 'a' })).toBeNull()
    expect(asCratePlugin({ i: 'https://github.com/o/a', n: 'a' })).toBeNull()
    expect(asCratePlugin({ i: null, n: 'a' })).toBeNull()
  })

  it('缺安装命令时按 npm / GitHub 源补全', () => {
    const withNpm = asCratePlugin({ i: 'o/a', n: 'a', cmd: 'dsh plugin --profile web add a' })
    expect(withNpm?.install).toBe('dsh plugin --profile web add a')
    const withoutNpm = asCratePlugin({ i: 'o/a', n: 'a' })
    expect(withoutNpm?.install).toBe('dsh plugin --profile web add github:o/a')
  })
})

describe('categoryOf', () => {
  it('把三种已知类型映射成分类 id', () => {
    expect(categoryOf('cordis-plugin')).toBe('plugin')
    expect(categoryOf('skill')).toBe('skill')
    expect(categoryOf('theme')).toBe('theme')
    expect(categoryOf('unknown')).toBe('other')
  })

  it('未知或非字符串类型归入 other', () => {
    expect(categoryOf('skin')).toBe('other')
    expect(categoryOf(undefined)).toBe('other')
    expect(categoryOf(42)).toBe('other')
  })
})

describe('npmFromCommand', () => {
  it('取出去掉版本号的 npm 包名', () => {
    expect(npmFromCommand('dsh plugin --profile web add @scope/name@1.2.3')).toBe('@scope/name')
    expect(npmFromCommand('dsh plugin --profile web add name@latest')).toBe('name')
  })

  it('带变量的 GitHub 地址不算 npm 包名', () => {
    expect(npmFromCommand('dsh plugin --profile web add github:o/a#${DSH_PLUGIN_REF}')).toBeNull()
  })

  it('大写名字与本地绝对路径都不算 npm 包名', () => {
    expect(npmFromCommand('dsh plugin --profile web add Aegis')).toBeNull()
    expect(npmFromCommand('dsh plugin --profile web add /绝对路径/plugin')).toBeNull()
  })

  it('缺命令或命令里没有 add 时返回 null', () => {
    expect(npmFromCommand(undefined)).toBeNull()
    expect(npmFromCommand('dsh plugin list')).toBeNull()
  })
})

describe('stripSpecVersion', () => {
  it('只去掉第二个 @ 之后的部分', () => {
    expect(stripSpecVersion('@scope/name@1.2.3')).toBe('@scope/name')
    expect(stripSpecVersion('name@latest')).toBe('name')
    expect(stripSpecVersion('@scope/name')).toBe('@scope/name')
    expect(stripSpecVersion('github:o/a')).toBe('github:o/a')
  })
})
