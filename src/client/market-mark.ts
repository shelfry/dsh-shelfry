/**
 * 品牌标记的几何定义，与 `assets/logo.svg` 的箱子设计一致。
 *
 * 两个消费方共用同一份坐标，避免走样：
 *
 * - `MarketLogo`（MarketSection.tsx）渲染成普通 React SVG，颜色取 `currentColor`；
 *   内容页标题与加载态再叠加一条扫光；
 * - `settings-nav-icon.ts` 序列化成 CSS mask，供设置导航图标使用（mask 不能取
 *   `currentColor`，所以需要独立的静态标记）。
 *
 * 标记是一个 16 视口的线条箱体：外框 + 一组内缩的横档/竖档 + 两块竖板。
 */

/** 标记所在正方形的坐标系。 */
export const MARK_VIEW_BOX = 16

/**
 * 描边宽度。坐标都落在 0.5 的偏移上，1.25 在 16px 下是一条实心线加一点边缘过渡；
 * 放大到 18–26px 时仍保持同样的视觉重量。
 */
export const MARK_STROKE_WIDTH = 1.25

/** 外框：0.5 偏移，15 边长。 */
export const MARK_FRAME = { x: 0.5, y: 0.5, width: 15, height: 15 } as const

/**
 * 箱体其余线条：上横档、右竖档、下横档、左竖档，以及两块竖板。
 * 合并成一条路径，React 与 mask 序列化共用同一个字符串。
 */
export const MARK_PATH_D
  = 'M0.5 3.5H12.5M12.5 0.5V12.5M3.5 12.5H15.5M3.5 3.5V15.5M6.5 3.5V12.5M9.5 3.5V12.5'
