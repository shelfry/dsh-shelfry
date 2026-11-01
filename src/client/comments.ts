/**
 * giscus wiring for the in-market comment thread.
 *
 * A plugin has ONE discussion, whether the reader reached it from the
 * repository's own page or from inside the market itself. That is only true
 * as long as two things agree: the repository ids below and the
 * `plugin:<slug>` term built from pluginSlug. A silent disagreement does not
 * fail — it forks the conversation in half and nobody notices until someone
 * asks why their comment vanished.
 */

export const GISCUS = Object.freeze({
  repo: 'awesome-dsh-plugin/awesome-dsh-plugin',
  repoId: 'R_kgDOT3ajCQ',
  category: 'Plugins',
  categoryId: 'DIC_kwDOT3ajCc4DES8_',
})

/**
 * The plugin's slug, derived from its GitHub URL exactly as the two site
 * builders derive it. Entries that live in a subdirectory of a monorepo
 * (`.../tree/<ref>/packages/x`) get the `owner/repo--packages-x` form, so two
 * plugins from one repository do not share a thread.
 */
export function pluginSlug(url: string): string {
  const repoPath = url.replace('https://github.com/', '')
  const repo = repoPath.split('/').slice(0, 2).join('/')
  const sub = repoPath.includes('/tree/')
    ? repoPath.split('/tree/')[1]!.replace(/^[^/]+\//, '')
    : null
  return sub ? `${repo}--${sub.replaceAll('/', '-')}` : repo
}

/** The giscus discussion term for a plugin. */
export const commentsTerm = (url: string): string => `plugin:${pluginSlug(url)}`

/**
 * GitHub's discussion search narrowed to this plugin's exact shared term.
 *
 * This is deliberately composed from constants and the catalog URL only.
 * In particular it never copies the current page URL: a local dsh web page
 * may carry its one-time host token there, and sending that to GitHub would
 * trade a comment-login inconvenience for credential disclosure.
 */
export function commentsDiscussionUrl(url: string): string {
  const term = `"${commentsTerm(url)}"`
  return `https://github.com/${GISCUS.repo}/discussions?discussions_q=${encodeURIComponent(term)}`
}

/** giscus's own locale codes, which are not the ones this plugin uses. */
export const giscusLang = (lang: string): string => (lang === 'zh' ? 'zh-CN' : 'en')
