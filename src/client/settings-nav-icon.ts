/**
 * The market's block mark in the settings navigation.
 *
 * The settings shell picks nav glyphs from a closed list of section ids
 * (`models`, `agent-presets`, `plugins`) and falls back to its own gear for
 * every other id; `settings.section` projects only `id` / `order` / `label`,
 * so a registrant has no icon to pass — the slot contract in
 * `@deepseek-ai/dsh-client-ui-settings` and the runtime slot inventory both
 * list exactly those three options. Every third-party section therefore wears
 * the gear, the market included.
 *
 * 于是本模块在设置弹窗挂载后认领自己那一行，把兜底的齿轮换成
 * 方块标记——与分区内部 `MarketLogo` 画的标记同源（见 market-mark.ts），
 * 导航项与它打开的页面因此读起来是同一个东西。 `dsh-better-sidebar` and
 * `dsh-skill-mcp-panel` solve it the same way.
 *
 * Scope, deliberately narrow:
 *
 * - only the row whose visible text equals this plugin's own localized
 *   section label is marked; no shell structure is touched;
 * - the marker and the injected stylesheet belong to a `ctx.effect`, so they
 *   are removed with the fiber;
 * - a locale switch re-claims the row through the MutationObserver, so the
 *   label and the glyph never disagree.
 *
 * Delete this module (and its call in index.ts) the day `settings.section`
 * grows an `icon` field.
 */
import { MARK_CELL_RADIUS, MARK_CELL_SIZE, MARK_GRID_BLOCKS, MARK_PLUG_BLOCK, MARK_VIEW_BOX } from './market-mark.ts'

/** Marks the one nav row this plugin owns. */
export const NAV_ICON_MARKER = 'data-dsh-shelfry-nav-icon'

/**
 * The nav rows of the settings dialog. The shell renders each
 * `settings.section` entry as a `<button>` inside the panel's `<nav>`
 * (SettingsPanel in dsh-client-ui-settings-general).
 */
export const NAV_ROW_SELECTOR = '[role="dialog"] nav button'

/**
 * Glyph box in px. The shell renders every nav icon at this size and ships no
 * media query at all; the only thing that ever shrinks those icons is another
 * plugin's mobile stylesheet, which is not this module's business to
 * second-guess. So there is deliberately no narrow variant here.
 */
export const NAV_ICON_SIZE = 16

/**
 * 标记的独立 SVG，供 CSS `mask-image` 使用。
 *
 * 故意涂成纯黑：mask 只读取 alpha，可见颜色来自元素的
 * `background-color: currentColor`。
 */
export function marketMaskSvg(): string {
  // mask 是静态图片，动画不可见，所以飞块直接取落位坐标。
  const cells = [...MARK_GRID_BLOCKS, MARK_PLUG_BLOCK]
    .map(cell => `<rect x="${cell.x}" y="${cell.y}" width="${MARK_CELL_SIZE}" height="${MARK_CELL_SIZE}" rx="${MARK_CELL_RADIUS}"/>`)
    .join('')
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '
    + `${MARK_VIEW_BOX} ${MARK_VIEW_BOX}" fill="#000">`
    + `<g>${cells}</g>`
    + '</svg>'
}

/** The mask URL for the mark (encoded at runtime, never hand-escaped). */
export function marketMaskUrl(svg: string = marketMaskSvg()): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * Whether a nav row is this plugin's own.
 *
 * Pure, and the only decision this feature makes: the row whose visible text
 * is the section label the shell is currently projecting. An empty label
 * matches nothing — a locale that has not resolved yet must not mark the
 * whole nav.
 */
export function isOwnNavRow(rowText: string | null | undefined, wantedLabel: string | null | undefined): boolean {
  const wanted = String(wantedLabel ?? '').trim()
  if (wanted.length === 0) return false
  return String(rowText ?? '').trim() === wanted
}

/** Stylesheet for the marked row: hide the shell's gear, draw the mark. */
export function navIconCss(maskUrl: string): string {
  return [
    // 齿轮可能包在额外的容器里，不能只匹配直接子级 svg。
    `[${NAV_ICON_MARKER}] svg { display: none; }`,
    `[${NAV_ICON_MARKER}]::before {`,
    `  content: '';`,
    `  flex: none;`,
    `  width: ${NAV_ICON_SIZE}px;`,
    `  height: ${NAV_ICON_SIZE}px;`,
    `  background-color: currentColor;`,
    `  -webkit-mask-image: url("${maskUrl}");`,
    `  mask-image: url("${maskUrl}");`,
    `  -webkit-mask-repeat: no-repeat;`,
    `  mask-repeat: no-repeat;`,
    `  -webkit-mask-position: center;`,
    `  mask-position: center;`,
    `  -webkit-mask-size: ${NAV_ICON_SIZE}px ${NAV_ICON_SIZE}px;`,
    `  mask-size: ${NAV_ICON_SIZE}px ${NAV_ICON_SIZE}px;`,
    `}`,
  ].join('\n')
}

/** The slice of the client context this feature needs (matches index.ts's
 * structural MarketClientContext, so no monorepo-internal types are pulled in). */
export interface NavIconContext {
  effect(callback: () => unknown, label?: string): void
}

/**
 * Install the nav glyph.
 *
 * @param ctx - client context, for effect ownership.
 * @param resolveLabel - this plugin's current section label (the same thunk
 *   the `settings.section` registration passes), re-read on every sync so a
 *   locale switch is picked up without re-registering.
 */
export function installSettingsNavIcon(ctx: NavIconContext, resolveLabel: () => string): void {
  if (typeof document === 'undefined') return

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-shelfry'
    tag.dataset.pluginCss = 'dsh-shelfry/settings-nav-icon'
    tag.textContent = navIconCss(marketMaskUrl())
    document.head.appendChild(tag)

    let disposed = false
    let scheduled = false

    const sync = () => {
      scheduled = false
      if (disposed) return
      const wanted = resolveLabel()
      for (const row of document.querySelectorAll(NAV_ROW_SELECTOR)) {
        if (isOwnNavRow(row.textContent, wanted)) row.setAttribute(NAV_ICON_MARKER, '')
        else row.removeAttribute(NAV_ICON_MARKER)
      }
    }

    // Coalesce a burst of DOM mutations into one sync, and land it before the
    // next paint so the row never shows the gear first.
    const schedule = () => {
      if (scheduled || disposed) return
      scheduled = true
      queueMicrotask(sync)
    }

    sync()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    return () => {
      disposed = true
      observer.disconnect()
      for (const row of document.querySelectorAll(`[${NAV_ICON_MARKER}]`)) row.removeAttribute(NAV_ICON_MARKER)
      tag.remove()
    }
  }, 'dsh-shelfry: settings nav icon')
}
