// @vitest-environment jsdom
/**
 * The market's own glyph in the settings navigation.
 *
 * The shell chooses nav icons from its own built-in ids and falls back to the
 * gear for every other section, and a `settings.section` registration has no
 * icon to pass — so this module claims the market's row once the dialog is
 * mounted. What the tests pin is the set of failures that are quiet rather
 * than loud: claiming a row that belongs to another section (which would take
 * that section's icon away), keeping a stale claim after a locale switch, and
 * leaving the marker or the stylesheet behind when the fiber goes away.
 *
 * The visual half — does the masked glyph actually look like the mark — is
 * covered by keeping one source of geometry for both renderings, which the
 * last two tests hold in place.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  NAV_ICON_MARKER,
  installSettingsNavIcon,
  marketMaskUrl,
  navIconCss,
} from '../../src/client/settings-nav-icon.ts'
import { MARK_CELL_RADIUS, MARK_CELL_SIZE, MARK_GRID_BLOCKS, MARK_PLUG_BLOCK } from '../../src/client/market-mark.ts'

/** The shell's own fallback glyph, as the row receives it. */
const GEAR = '<svg class="VOzbGW_navIcon" viewBox="0 0 16 16"></svg>'

const STYLESHEET_SELECTOR = 'style[data-plugin-css="dsh-shelfry/settings-nav-icon"]'

/** Let the MutationObserver's queued sync run. */
const flush = () => new Promise<void>(resolve => { setTimeout(resolve, 0) })

let label = '插件箱子'
let disposers: (() => void)[] = []

/** The shell's panel: role="dialog" > nav > one <button> per section. */
function mountDialog(...sections: string[]): void {
  document.querySelector('[role="dialog"]')?.remove()
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  const nav = document.createElement('nav')
  for (const section of sections) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'VOzbGW_navCell'
    row.innerHTML = `${GEAR}<span class="VOzbGW_navLabel">${section}</span>`
    nav.append(row)
  }
  dialog.append(nav)
  document.body.append(dialog)
}

const marked = (): string[] =>
  [...document.querySelectorAll(`[${NAV_ICON_MARKER}]`)].map(row => row.textContent?.trim() ?? '')

const stylesheet = (): HTMLStyleElement | null => document.head.querySelector(STYLESHEET_SELECTOR)

beforeEach(() => {
  label = '插件箱子'
  disposers = []
  // The market boots with the client, before any settings dialog exists.
  installSettingsNavIcon({ effect: (callback) => { disposers.push(callback() as () => void) } }, () => label)
})

afterEach(() => {
  for (const dispose of disposers) dispose()
  disposers = []
  document.body.innerHTML = ''
  document.querySelectorAll(STYLESHEET_SELECTOR).forEach(tag => tag.remove())
})

describe('settings nav glyph', () => {
  it('claims its own row and nobody else\'s', async () => {
    mountDialog('通用设置', '手机访问', '插件箱子', '模型')
    await flush()

    // "手机访问" belongs to dsh-pocket, "模型"/"通用设置" to the shell: a
    // marker on any of them would replace an icon this plugin does not own.
    expect(marked()).toEqual(['插件箱子'])
  })

  it('claims nothing while the section label has not resolved', async () => {
    label = ''
    mountDialog('通用设置', '插件箱子')
    await flush()

    expect(marked()).toEqual([])
  })

  it('moves the claim when the locale switches', async () => {
    mountDialog('General', '手机访问', 'Plugin Shelfry')
    await flush()
    expect(marked()).toEqual([])

    // The shell re-renders its nav on a locale change, which is what the
    // observer sees; the module must not need a second registration for it.
    label = 'Plugin Shelfry'
    mountDialog('General', '手机访问', 'Plugin Shelfry')
    await flush()

    expect(marked()).toEqual(['Plugin Shelfry'])
  })

  it('hides the shell gear and paints the mark through a mask', async () => {
    mountDialog('插件箱子')
    await flush()

    const row = document.querySelector('[role="dialog"] nav button')
    expect(row?.querySelector('svg'), 'the row must carry a gear for the stylesheet to hide').not.toBeNull()

    const css = stylesheet()?.textContent ?? ''
    expect(css).toContain(`[${NAV_ICON_MARKER}] svg { display: none; }`)
    // 只藏 svg 会留下占位的空壳，图标后会多出一段空档。
    expect(css).toContain(`[${NAV_ICON_MARKER}] *:has(> svg) { display: none; }`)
    // currentColor, so the glyph follows the row's colour in either theme and
    // in the active state.
    expect(css).toContain('background-color: currentColor')
    expect(css).toContain('-webkit-mask-image: url("data:image/svg+xml,')
    expect(css).toContain('mask-image: url("data:image/svg+xml,')
    // A mask is an independent image: currentColor inside it would not resolve.
    expect(css).not.toContain('currentColor);')
  })

  it('masks the mark the section draws, from the one source of geometry', async () => {
    mountDialog('插件箱子')
    await flush()

    const svg = decodeURIComponent(marketMaskUrl().replace('data:image/svg+xml,', ''))
    const cells = [...MARK_GRID_BLOCKS, MARK_PLUG_BLOCK]
    expect(svg.match(/<rect/g)).toHaveLength(cells.length)
    for (const cell of cells) {
      expect(svg).toContain(`<rect x="${cell.x}" y="${cell.y}" width="${MARK_CELL_SIZE}" height="${MARK_CELL_SIZE}" rx="${MARK_CELL_RADIUS}"/>`)
    }

    // And the section must not have gone back to carrying its own copy of the
    // numbers: a second copy is how the nav entry and the page it opens drift.
    const section = readFileSync(resolve('src/client/MarketSection.tsx'), 'utf8')
    expect(section).toContain('MARK_PLUG_BLOCK')
    expect(section).not.toContain('x="6.3"')
  })

  it('leaves no marker and no stylesheet behind when the fiber goes away', async () => {
    mountDialog('通用设置', '插件箱子')
    await flush()
    expect(marked()).toEqual(['插件箱子'])
    expect(stylesheet()).not.toBeNull()

    for (const dispose of disposers) dispose()
    await flush()

    expect(marked()).toEqual([])
    expect(stylesheet()).toBeNull()
  })
})
