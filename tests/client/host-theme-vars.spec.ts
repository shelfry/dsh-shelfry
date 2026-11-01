/**
 * Every CSS variable the market's client reads must exist (#805).
 *
 * `var(--name, fallback)` never fails loudly: a name the host does not define
 * silently becomes its fallback, on every host, forever. That is how #805's
 * fix shipped doing nothing. It pointed eleven monospace rules at
 * `--dsw-alias-font-mono`, a name the host's theme has never defined, so
 * Windows kept falling back to SimSun — while the theme's real code-font
 * token, `--ds-font-family-code`, was there all along (the reporter named it in
 * the issue). `--dsw-alias-border-default` was the same mistake: undefined, so
 * three borders stayed light grey in dark mode.
 *
 * The list of names the host defines is generated from the published
 * `@deepseek-ai/dsh-client-ui-theme` (see the fixture's header). A name the
 * market defines for itself (`--fold-*`) is fine too.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLIENT = join(__dirname, '..', '..', 'src', 'client')
const sources = readdirSync(CLIENT)
  .filter(name => /\.(css|tsx?)$/.test(name))
  .map(name => ({ name, text: readFileSync(join(CLIENT, name), 'utf8') }))

const hostDefined = new Set(
  readFileSync(join(__dirname, '..', 'fixtures', 'host-theme-custom-properties.txt'), 'utf8')
    .split('\n').map(line => line.trim()).filter(line => line.startsWith('--')),
)
/**
 * Published by the host's layout frame rather than its theme, so the theme
 * fixture cannot list them. Each is documented in `dsh-client-ui-layout`'s
 * README and read the same way by the host's own pages.
 */
const layoutDefined = new Set(['--dsh-frame-top-clearance'])
for (const name of layoutDefined) hostDefined.add(name)
const marketDefined = new Set(sources.flatMap(({ text }) => [...text.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map(match => match[1]!)))

describe('the CSS variables the market reads', () => {
  it('are all defined — by the host theme or by the market itself', () => {
    const undefinedUses = sources.flatMap(({ name, text }) =>
      [...text.matchAll(/var\((--[a-zA-Z0-9-]+)/g)]
        .map(match => match[1]!)
        .filter(variable => !hostDefined.has(variable) && !marketDefined.has(variable))
        .map(variable => `${name}: ${variable}`))

    expect([...new Set(undefinedUses)]).toEqual([])
  })

  it('reads the host theme\'s own code font for every monospace rule', () => {
    const css = readFileSync(join(CLIENT, 'Market.module.css'), 'utf8')
    const stacks = [...css.matchAll(/font-family:([^;}]*)/g)].map(match => match[1]!)
    const monospace = stacks.filter(stack => /monospace/.test(stack))

    expect(monospace.length).toBeGreaterThan(0)
    for (const stack of monospace) {
      expect(stack).toContain('var(--ds-font-family-code')
      // A host without the theme still gets a Windows monospace font before
      // the generic one, which on Simplified-Chinese Windows is SimSun.
      expect(stack).toMatch(/Consolas[^)]*monospace\)$/)
    }
  })
})
