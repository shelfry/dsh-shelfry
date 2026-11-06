/**
 * 市场品牌标记的几何定义：四个方块，右上那块会飞进落位。
 *
 * 两个使用方都从这里取值，不允许各自复制坐标：
 *
 * - `MarketLogo`（MarketSection.tsx）在分区内部用普通 React SVG 画它，
 *   颜色跟随 `currentColor`；
 * - `settings-nav-icon.ts` 把它序列化成 CSS mask，用作设置导航图标；
 *   mask 是一张独立图片，用不了 `currentColor`，所以需要独立标记。
 *
 * 品牌资产是 `assets/logo.svg`，本文件的坐标是它的 16×16 版本。
 */

/** 标记使用的正方形坐标空间。 */
export const MARK_VIEW_BOX = 16

/** 单个方块的边长与圆角，`assets/logo.svg` 是同一组数字放大 8 倍。 */
export const MARK_CELL_SIZE = 4.75
export const MARK_CELL_RADIUS = 0.75

/**
 * 网格里固定的三个方块，顺序按对角线的 `wave` 排。
 *
 * `wave` 是方块在对角线上的序数，波浪动画按它错开延迟，
 * 让变暗的那一下沿着对角线走，而不是从左往右扫。
 */
export const MARK_GRID_BLOCKS: readonly {
  readonly x: number
  readonly y: number
  readonly wave: number
}[] = [
  { x: 3, y: 3, wave: 0 },
  { x: 3, y: 8.375, wave: 1 },
  { x: 8.375, y: 8.375, wave: 2 },
]

/**
 * 从外侧飞进来的那一块：落位在网格右上角。
 *
 * 静态（含 `prefers-reduced-motion`、CSS mask）时它就在落位坐标上；
 * 动画期间会先偏到 `offset` 之外并倾斜 `degrees`，再飞回来。
 */
export const MARK_PLUG_BLOCK = {
  x: 8.375,
  y: 3,
  wave: 1,
  offsetX: 1.75,
  offsetY: -1.75,
  degrees: 9,
} as const
