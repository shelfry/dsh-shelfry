/**
 * 市场品牌标记的几何定义：一只「箱子」。
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

/**
 * 箱子的三个部件，自上而下：提手、箱盖、箱体。
 * 宽高与圆角都用 viewBox 单位，`assets/logo.svg` 是同一组数字放大 8 倍。
 */
export const MARK_BOX_PARTS: readonly {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly radius: number
}[] = [
  { x: 6.3, y: 1.2, width: 3.4, height: 2.6, radius: 1.3 },
  { x: 1.1, y: 3.8, width: 13.8, height: 2.4, radius: 1 },
  { x: 2, y: 6.4, width: 12, height: 7.4, radius: 1.2 },
]
