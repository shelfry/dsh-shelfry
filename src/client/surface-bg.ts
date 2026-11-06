/**
 * 取宿主这一层实际绘制的不透明背景色。
 *
 * 吸顶的头部和搜索块要用不透明底色盖住滚过去的内容，这个颜色必须和宿主
 * 当前所在的那一层一致：浅色与深色主题下 bg-base、bg-layer-1 谁更接近
 * 对话框底色并不固定，写死任何一个都会在某种主题下露出色带。这里从起始
 * 元素向上找最近一层真正画了底色的祖先，取它计算后的 background-color。
 *
 * @param start 起始元素（通常传市场根节点）
 * @returns 最近的实色背景（如 `rgb(30, 30, 32)`）；一路透明时返回 null
 */
export function findSurfaceBackground(start: HTMLElement | null): string | null {
  for (let node = start; node !== null; node = node.parentElement) {
    const color = window.getComputedStyle(node).backgroundColor
    if (isOpaqueColor(color)) return color
  }
  return null
}

/**
 * 判断计算后的 background-color 是否真的会画出颜色。
 *
 * jsdom 与浏览器对未设置底色的元素分别返回空串和 `rgba(0, 0, 0, 0)`，
 * 两种都按透明处理。
 *
 * @param color getComputedStyle 返回的 backgroundColor
 * @returns 会画出颜色返回 true
 */
function isOpaqueColor(color: string): boolean {
  if (color === '' || color === 'transparent') return false
  const rgba = /^rgba\(([^)]+)\)$/i.exec(color)
  if (rgba === null) return true
  const alpha = Number.parseFloat(rgba[1].split(',')[3] ?? '')
  return Number.isFinite(alpha) ? alpha > 0 : true
}
