// @vitest-environment jsdom
/**
 * 吸顶条的底色取色。
 *
 * 吸顶的头部与搜索块必须用不透明底色盖住滚过去的内容，这个颜色要和宿主
 * 当前那一层一致。测试盯的是三件事：取最近一层实色而不是最外层、跳过
 * 透明中间层、整条链路都透明时返回 null（让 CSS 回退到主题变量）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { findSurfaceBackground } from '../../src/client/surface-bg.ts'

const mounted: HTMLElement[] = []

/**
 * 造一条祖先链并挂到文档上，返回链尾（起始元素）。
 *
 * @param colors 从外到内的背景色，空串表示不设置
 * @returns 链尾元素
 */
function chain(colors: string[]): HTMLElement {
  const outer = document.createElement('div')
  document.body.appendChild(outer)
  mounted.push(outer)
  let current = outer
  for (const color of colors) {
    if (color !== '') current.style.backgroundColor = color
    const child = document.createElement('div')
    current.appendChild(child)
    current = child
  }
  return current
}

afterEach(() => {
  for (const node of mounted.splice(0)) node.remove()
})

describe('findSurfaceBackground', () => {
  it('取最近一层实色，而不是最外层', () => {
    const start = chain(['rgb(12, 12, 14)', '', 'rgb(30, 30, 32)'])
    expect(findSurfaceBackground(start)).toBe('rgb(30, 30, 32)')
  })

  it('跳过透明中间层继续向上找', () => {
    const start = chain(['rgb(12, 12, 14)', 'rgba(0, 0, 0, 0)', 'transparent'])
    expect(findSurfaceBackground(start)).toBe('rgb(12, 12, 14)')
  })

  it('整条链路都透明时返回 null', () => {
    const start = chain(['', 'transparent', 'rgba(0, 0, 0, 0)'])
    expect(findSurfaceBackground(start)).toBeNull()
  })

  it('起始元素为 null 时返回 null', () => {
    expect(findSurfaceBackground(null)).toBeNull()
  })
})
