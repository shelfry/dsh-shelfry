/**
 * 品牌防护：把本地定制从「靠记忆维护」变成「靠测试守住」。
 *
 * 2026-11-07 同步上游 dsh-market v1.73.14 时，界面层整包覆盖了本地品牌文案，
 * 设置卡片标题退回上游措辞，e2e 断言随即 6/9 leg 变红。这里把身份、数据源、
 * 品牌文案、视觉几何、布局滚动、导航图标六组关键值钉住，随 `npm test` 运行，只读不写。
 *
 * 维护规则：新增品牌文案键时，同一次提交里补上对应断言；上游同步后若护栏
 * 变红，说明定制被覆盖，按清单逐项恢复。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { en, ja, zh } from '../src/client/locales.ts'
import {
  MARK_FRAME,
  MARK_PATH_D,
  MARK_STROKE_WIDTH,
  MARK_VIEW_BOX,
} from '../src/client/market-mark.ts'
import {
  NAV_ICON_MARKER,
  NAV_ICON_SIZE,
  NAV_ROW_SELECTOR,
  marketMaskSvg,
  navIconCss,
} from '../src/client/settings-nav-icon.ts'

/** 项目根目录下的文件，按相对路径读取。 */
function readRoot(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

/** 源码目录，末尾保留斜杠，保证相对路径按目录解析。 */
const SRC_DIR = new URL('../src/', import.meta.url)

/** 递归收集 src 下的 TypeScript 源码，返回相对路径。 */
function sourceFiles(): string[] {
  const entries = readdirSync(SRC_DIR, { recursive: true }) as string[]
  return entries.filter(entry => /\.(ts|tsx)$/u.test(entry))
}

/** 读取 src 下的某个文件。 */
function readSrc(relativePath: string): string {
  return readFileSync(new URL(relativePath, SRC_DIR), 'utf8')
}

/** 主版本号逐段比较：`version` 是否不低于 `floor`。 */
function versionAtLeast(version: string, floor: string): boolean {
  const left = version.split('-')[0]!.split('.').map(part => Number.parseInt(part, 10) || 0)
  const right = floor.split('-')[0]!.split('.').map(part => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < 3; index += 1) {
    const current = left[index] ?? 0
    const expected = right[index] ?? 0
    if (current !== expected) return current > expected
  }
  return true
}

const PKG = JSON.parse(readRoot('package.json')) as {
  name: string
  version: string
  icon: string
  homepage: string
  repository: { url: string }
  exports: Record<string, unknown>
  files: string[]
}

describe('A. 身份与升级', () => {
  it('1. 包名是 dsh-crate', () => {
    expect(PKG.name).toBe('dsh-crate')
  })

  it('2. 版本不低于 0.4.6', () => {
    expect(versionAtLeast(PKG.version, '0.4.6')).toBe(true)
  })

  it('3. 图标指向自家 logo', () => {
    expect(PKG.icon).toBe('assets/logo.svg')
  })

  it('4. 主页是 dshcrate.com', () => {
    expect(PKG.homepage).toBe('https://dshcrate.com')
  })

  it('5. 仓库指向 crate/dsh-crate', () => {
    expect(PKG.repository.url).toContain('github.com/dshcrate/dsh-crate')
  })

  it('6. 对外导出与发布清单包含客户端产物', () => {
    expect(PKG.exports['./client']).toBe('./client/client.js')
    expect(PKG.files).toEqual(expect.arrayContaining(['assets/logo.svg', 'locale', 'lib', 'client']))
  })

  it('7. 入口与客户端包名一致', () => {
    expect(readSrc('index.ts')).toMatch(/export const name = 'dsh-crate'/)
    expect(readSrc('client/index.ts')).toMatch(/const MARKET_PACKAGE_NAME = 'dsh-crate'/)
    expect(readSrc('client/index.ts')).toMatch(/export const name = 'dsh-crate'/)
  })

  it('8. 设置命名空间是 dsh-crate', () => {
    expect(readSrc('settings.ts')).toMatch(/MARKET_SETTINGS_NS = 'dsh-crate'/)
  })

  it('9. 四处自识别集合只认 dsh-crate', () => {
    expect(readSrc('presets.ts')).toMatch(/new Set\(\['dsh-crate'\]\)/)
    expect(readSrc('official-desktop.ts')).toMatch(/new Set\(\['dsh-crate'\]\)/)
    expect(readSrc('routes.ts')).toMatch(/new Set\(\['dsh-crate'\]\)/)
    expect(readSrc('install.ts')).toMatch(/lockedName !== 'dsh-crate'/)
  })
})

describe('B. 数据源', () => {
  it('10. 官方目录只指向 dshcrate.com，且没有上游目录残留', () => {
    expect(readSrc('regions.ts')).toMatch(/const CATALOG_OFFICIAL = 'https:\/\/dshcrate\.com\/data\/dsh-crate\.json'/)

    const offenders = sourceFiles().filter(file => {
      const text = readSrc(file)
      return text.includes('dsh-market.json') || text.includes('cdn.jsdelivr.net/npm/dsh-plugin-catalog')
    })
    expect(offenders).toEqual([])
  })
})

describe('C. 品牌文案', () => {
  it('11. 导航名保持三语品牌', () => {
    expect(zh.nav).toBe('插件箱子')
    expect(en.nav).toBe('Plugin Crate')
    expect(ja.nav).toBe('プラグインボックス')
  })

  it('12. 设置卡片描述保持三语品牌', () => {
    expect(zh.setCardDesc).toBe('查看插件箱子版本与设置。')
    expect(en.setCardDesc).toBe('View the Plugin Crate version and settings.')
    expect(ja.setCardDesc).toBe('プラグインボックスのバージョンと設定を確認します。')
  })

  it('13. 日志导出文件名是 dsh-crate-log.txt', () => {
    expect(zh.exportedLog).toContain('dsh-crate-log.txt')
    expect(en.exportedLog).toContain('dsh-crate-log.txt')
    expect(ja.exportedLog).toContain('dsh-crate-log.txt')
  })

  it('14. 索引源提示指向自家索引且不提官方上游目录', () => {
    for (const dictionary of [zh, en, ja]) {
      expect(dictionary.setIndexSourceHint).toContain('https://dshcrate.com/data/index.json')
      expect(dictionary.setIndexSourceHint).not.toContain('dsh-plugin-catalog')
    }
  })

  it('15. 中文 locale 元数据保持品牌', () => {
    const zhLocale = JSON.parse(readRoot('locale/zh.json')) as { meta: { title: string; description: string } }
    expect(zhLocale.meta.title).toBe('插件箱子')
    expect(zhLocale.meta.description.length).toBeGreaterThan(0)
    expect(zhLocale.meta.description).toContain('DeepSeek Harness')
  })

  it('16. 英文 locale 描述非空', () => {
    const enLocale = JSON.parse(readRoot('locale/en.json')) as { meta: { description: string } }
    expect(enLocale.meta.description.length).toBeGreaterThan(0)
  })

  it('17. 投稿入口指向 dshcrate.com', () => {
    expect(readSrc('client/MarketSection.tsx')).toMatch(/href="https:\/\/dshcrate\.com"/)
  })

  it('18. 品牌面文件没有上游品牌残留', () => {
    const brandFiles = ['src/client/locales.ts', 'locale/zh.json', 'locale/en.json', 'package.json']
    const banned = ['Plugin Market', '插件市场', 'dsh-plugin-catalog']
    const offenders = brandFiles.flatMap(file => {
      const text = readRoot(file)
      return banned.filter(word => text.includes(word)).map(word => `${file}: ${word}`)
    })
    expect(offenders).toEqual([])
  })

  it('19. e2e 设置卡片断言兼容当前与历史中英文案', () => {
    const spec = readRoot('tests/web/desktop-settings.e2e.ts')
    expect(spec).toContain('(Plugin Crate|plugin market)')
    expect(spec).toContain('(插件箱子的?|插件市场)')
  })
})

describe('D. 视觉与几何', () => {
  it('20. 箱子标记的几何常量未走样', () => {
    expect(MARK_VIEW_BOX).toBe(16)
    expect(MARK_STROKE_WIDTH).toBe(1.25)
    expect(MARK_FRAME).toEqual({ x: 0.5, y: 0.5, width: 15, height: 15 })
    expect(MARK_PATH_D).toBe(
      'M0.5 3.5H12.5M12.5 0.5V12.5M3.5 12.5H15.5M3.5 3.5V15.5M6.5 3.5V12.5M9.5 3.5V12.5',
    )
  })

  it('21. 内容页的扫光仍由样式表提供', () => {
    const css = readSrc('client/Market.module.css')
    expect(css).toContain('@keyframes dshmCrateSweep')
    expect(css).toContain('animation:dshmCrateSweep 3s linear infinite')
    // 减少动态效果时扫光直接隐藏，不留一个停住的亮条。
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\{[^}]*\.logoSweep\{display:none\}/u)
  })

  it('22. 设置导航图标的标记与尺寸未变', () => {
    expect(NAV_ICON_MARKER).toBe('data-dsh-crate-nav-icon')
    expect(NAV_ICON_SIZE).toBe(16)
  })

  it('23. 导航掩膜复用同一份几何，且 logo 文件存在', () => {
    expect(existsSync(new URL('../assets/logo.svg', import.meta.url))).toBe(true)

    const svg = marketMaskSvg()
    expect(svg).toContain(`viewBox="0 0 ${MARK_VIEW_BOX} ${MARK_VIEW_BOX}"`)
    expect(svg.match(/<rect/gu)).toHaveLength(1)
    expect(svg).toContain(`<rect x="${MARK_FRAME.x}" y="${MARK_FRAME.y}" width="${MARK_FRAME.width}" height="${MARK_FRAME.height}"/>`)
    expect(svg).toContain(`<path d="${MARK_PATH_D}"/>`)
    expect(svg).toContain(`stroke-width="${MARK_STROKE_WIDTH}"`)
  })
})

describe('E. 布局与滚动定制', () => {
  it('24. 列表底部留白与滚动内边距保留', () => {
    const css = readSrc('client/Market.module.css')
    expect(css).toContain('padding:8px 4px 64px')
    expect(css).toContain('scroll-padding-bottom:64px')
  })

  it('25. 设置页头部吸顶并沿用导航背景色', () => {
    const css = readSrc('client/Market.module.css')
    expect(css).toContain('.head{position:sticky;top:0;z-index:6;background:var(--dsw-alias-bg-layer-2')
    expect(css).toContain('.stickyHead{top:calc(var(--dshm-head-h,0px) + 8px);background:var(--dsw-alias-bg-layer-2')
  })

  it('26. 设置页不再出现内层滚动条', () => {
    const css = readSrc('client/Market.module.css')
    expect(css).toContain('.body{overflow:visible;flex:none}')
  })

  it('27. 插件页签整页滚动与吸顶让位保留', () => {
    const css = readSrc('client/Market.module.css')
    expect(css).toContain('.stickyHead{display:contents}')
    expect(css).toContain('top:var(--dshm-host-sticky-top,0px)')
  })

  it('28. 全屏模式仍固定铺满视口', () => {
    const css = readSrc('client/Market.module.css')
    expect(css).toContain(
      '[data-dsh-crate-plugins-tab="true"][data-dsh-crate-fullscreen="true"]{position:fixed;inset:0;z-index:60;height:100vh!important',
    )
  })

  it('29. 吸顶偏移变量名未被改写', () => {
    const css = readSrc('client/Market.module.css')
    for (const name of ['--dshm-host-sticky-top', '--dshm-plugins-head-height', '--dshm-head-h']) {
      expect(css).toContain(name)
    }
  })
})

describe('F. 导航图标定制', () => {
  it('30. 导航行选择器未变', () => {
    expect(NAV_ROW_SELECTOR).toBe('[role="dialog"] nav button')
  })

  it('31. 导航图标尺寸与掩膜样式未变', () => {
    const css = navIconCss('url(mask)')
    expect(css).toContain('width: 16px')
    expect(css).toContain('height: 16px')
    expect(css).toContain('background-color: currentColor')
    expect(css).toContain('mask-size: 16px 16px')
  })

  it('32. 只给本插件行打标记，其余行清除', () => {
    const source = readSrc('client/settings-nav-icon.ts')
    expect(source).toContain("row.setAttribute(NAV_ICON_MARKER, '')")
    expect(source).toContain('row.removeAttribute(NAV_ICON_MARKER)')
  })
})
