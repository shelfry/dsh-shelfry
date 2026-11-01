/**
 * Every surface that shows a plugin's comments shares one discussion only
 * while they agree on the repository ids and on the term. Nothing at runtime
 * notices when they stop agreeing: giscus happily opens a second, empty
 * thread and reports no error. These tests are the only place that
 * disagreement becomes visible.
 */

import { describe, expect, it } from 'vitest'
import { GISCUS, commentsDiscussionUrl, giscusLang, pluginSlug } from '../../src/client/comments.ts'

describe('giscus configuration', () => {
  it('names the repository and category the threads live in', () => {
    expect(GISCUS.repo).toBe('awesome-dsh-plugin/awesome-dsh-plugin')
    expect(GISCUS.repoId).not.toBe('')
    expect(GISCUS.category).toBe('Plugins')
    expect(GISCUS.categoryId).not.toBe('')
  })
})

describe('pluginSlug', () => {
  it('is the repository path for a whole-repo plugin', () => {
    expect(pluginSlug('https://github.com/owner/dsh-plugin-x')).toBe('owner/dsh-plugin-x')
  })

  it('qualifies a subdirectory entry so one repo can hold several plugins', () => {
    expect(pluginSlug('https://github.com/owner/repo/tree/main/packages/a')).toBe('owner/repo--packages-a')
    expect(pluginSlug('https://github.com/owner/repo/tree/main/packages/b')).toBe('owner/repo--packages-b')
  })

  it('ignores the ref, so a repo that renames its branch keeps its thread', () => {
    expect(pluginSlug('https://github.com/o/r/tree/master/p')).toBe(pluginSlug('https://github.com/o/r/tree/main/p'))
  })
})

describe('commentsDiscussionUrl', () => {
  it('searches GitHub for the exact shared discussion term', () => {
    const href = new URL(commentsDiscussionUrl('https://github.com/owner/repo/tree/main/packages/a'))
    expect(href.origin + href.pathname).toBe(
      'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/discussions',
    )
    expect(href.searchParams.get('discussions_q')).toBe('"plugin:owner/repo--packages-a"')
  })
})

describe('giscusLang', () => {
  it('maps this plugin\'s codes onto giscus\'s own', () => {
    expect(giscusLang('zh')).toBe('zh-CN')
    expect(giscusLang('en')).toBe('en')
    // Anything unrecognised gets a real locale rather than a blank widget.
    expect(giscusLang('de')).toBe('en')
  })
})
