/**
 * 品牌标记的几何定义，与 `assets/logo.svg` 的四格设计一致。
 *
 * 两个消费方共用同一份坐标，避免走样：
 *
 * - `MarketLogo`（MarketSection.tsx）渲染成普通 React SVG，颜色取 `currentColor`，
 *   动画版本再叠加波浪与飞块；
 * - `settings-nav-icon.ts` 序列化成 CSS mask，供设置导航图标使用（mask 不能取
 *   `currentColor`，所以需要独立的静态标记）。
 *
 * 标记是 2×2 四格：左上、左下、右下三格常驻，右上是待飞入的第四格。
 */

/** 单格边长与圆角。 */
export const MARK_BLOCK_SIZE = 4.95
export const MARK_BLOCK_RADIUS = 0.7875

/** 标记所在正方形的坐标系。 */
export const MARK_VIEW_BOX = 16

/**
 * 常驻的三个格子，按行优先排列。右上角留空，等第四块飞入。
 *
 * `wave` 是 2×2 网格里的对角线序号（行 + 列）。动画按它错开，让明暗沿对角线
 * 划过；空位是 `wave` 1，飞块的时序也按它对齐（见 `dshmMarkPlug`）。
 */
export const MARK_GRID_BLOCKS: readonly {
  readonly x: number
  readonly y: number
  readonly wave: number
}[] = [
  { x: 2.6, y: 2.6, wave: 0 },
  { x: 2.6, y: 8.45, wave: 1 },
  { x: 8.45, y: 8.45, wave: 2 },
]

/**
 * 第四块：静止时落在右上角，与 `assets/logo.svg` 的落位帧一致；
 * 飞入前的位移由 CSS 动画负责，所以静态标记（导航 mask、非动画渲染）
 * 就是完整的 2×2 四格。
 */
export const MARK_PLUG_BLOCK = {
  x: 8.45,
  y: 2.6,
  degrees: 0,
  /** 旋转原点：飞块自身中心。 */
  originX: 10.925,
  originY: 5.075,
} as const
