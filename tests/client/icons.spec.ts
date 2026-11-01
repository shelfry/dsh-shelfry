/**
 * Icon alias resolution for host 0.1.7's …14/…16 → weight rename (#670/#671).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ICON_ALIASES,
  fromHost,
  isIconComponent,
  missingIcons,
  resolveIcon,
} from '../../src/client/icons.ts'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function loadIconFixture(version: string): Set<string> {
  const raw = JSON.parse(readFileSync(join(fixturesDir, `primitives-icons-${version}.json`), 'utf8')) as {
    icons: string[]
  }
  return new Set(raw.icons)
}

/** Build a primitives-shaped module whose Icon* keys are stub components. */
function moduleFromNames(names: Set<string>): Record<string, unknown> {
  const mod: Record<string, unknown> = {}
  for (const name of names) mod[name] = () => null
  return mod
}

describe('resolveIcon (#671)', () => {
  it('prefers the 0.1.7 Regular name when both spellings exist', () => {
    const newer = (): null => null
    const older = (): null => null
    expect(resolveIcon({
      IconWarningOutlineRegular: newer,
      IconWarningOutline16: older,
    }, 'IconWarningOutlineRegular', 'IconWarningOutline16')).toBe(newer)
  })

  it('falls back to the pre-0.1.7 size name on older hosts', () => {
    const older = (): null => null
    expect(resolveIcon({
      IconWarningOutline16: older,
    }, 'IconWarningOutlineRegular', 'IconWarningOutline16')).toBe(older)
  })

  it('accepts a host that only ships the new names', () => {
    const newer = (): null => null
    expect(resolveIcon({
      IconChevronDownOutlineRegular: newer,
    }, 'IconChevronDownOutlineRegular', 'IconChevronDownOutline14')).toBe(newer)
  })

  it('returns null when neither spelling exists', () => {
    expect(resolveIcon({}, 'IconWarningOutlineRegular', 'IconWarningOutline16')).toBeNull()
    expect(resolveIcon({ IconWarningOutline16: 1 }, 'IconWarningOutlineRegular', 'IconWarningOutline16')).toBeNull()
  })

  it('accepts memo / forwardRef-shaped exports, not only plain functions', () => {
    const memoLike = { $$typeof: Symbol.for('react.memo'), type: () => null }
    const forwardLike = { $$typeof: Symbol.for('react.forward_ref'), render: () => null }
    expect(isIconComponent(memoLike)).toBe(true)
    expect(isIconComponent(forwardLike)).toBe(true)
    expect(resolveIcon({
      IconWarningOutlineRegular: memoLike,
    }, 'IconWarningOutlineRegular', 'IconWarningOutline16')).toBe(memoLike)
    expect(resolveIcon({
      IconWarningOutline16: forwardLike,
    }, 'IconWarningOutlineRegular', 'IconWarningOutline16')).toBe(forwardLike)
  })

  it('does not throw when the host table refuses an unknown key', () => {
    const mod = new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === 'IconWarningOutlineRegular' || prop === 'IconWarningOutline16') {
          throw new Error('refused')
        }
        return undefined
      },
    })
    expect(fromHost(mod, 'IconWarningOutlineRegular')).toBeUndefined()
    expect(resolveIcon(mod, 'IconWarningOutlineRegular', 'IconWarningOutline16')).toBeNull()
  })
})

describe('missingIcons (#671)', () => {
  it('reports nothing when every alias resolves via the new name', () => {
    const mod: Record<string, unknown> = {}
    for (const [, newer] of ICON_ALIASES) mod[newer] = () => null
    expect(missingIcons(mod)).toEqual([])
  })

  it('reports nothing when every alias resolves via the old name', () => {
    const mod: Record<string, unknown> = {}
    for (const [, , older] of ICON_ALIASES) mod[older] = () => null
    expect(missingIcons(mod)).toEqual([])
  })

  it('names icons that exist under neither spelling', () => {
    const mod: Record<string, unknown> = {}
    for (const [, newer] of ICON_ALIASES) {
      if (newer === 'IconWarningOutlineRegular') continue
      mod[newer] = () => null
    }
    expect(missingIcons(mod)).toEqual(['IconWarningOutline16'])
  })
})

describe('real package export tables (#671)', () => {
  it('resolves every market icon against the 0.1.6-alpha.2 export list', () => {
    const names = loadIconFixture('0.1.6-alpha.2')
    for (const [, newer, older] of ICON_ALIASES) {
      expect(names.has(older), `pre-0.1.7 export missing: ${older}`).toBe(true)
      expect(names.has(newer), `0.1.6 must not yet ship ${newer}`).toBe(false)
    }
    expect(missingIcons(moduleFromNames(names))).toEqual([])
  })

  it('resolves every market icon against the 0.1.7-alpha.1 Regular exports', () => {
    const names = loadIconFixture('0.1.7-alpha.1')
    for (const [, newer, older] of ICON_ALIASES) {
      expect(names.has(newer), `0.1.7 Regular export missing: ${newer}`).toBe(true)
      expect(names.has(older), `0.1.7 must not keep ${older}`).toBe(false)
    }
    expect(missingIcons(moduleFromNames(names))).toEqual([])
  })

  it('resolves every market icon against the 0.2.0-rc.2 exports (#877)', () => {
    // The table the reports crashed on: 0.2.0-rc.2 dropped every size-suffixed
    // spelling, so an icon read straight off the module is `undefined` and the
    // market section dies on React #130.
    const names = loadIconFixture('0.2.0-rc.2')
    for (const [, newer, older] of ICON_ALIASES) {
      expect(names.has(newer), `0.2.0-rc.2 export missing: ${newer}`).toBe(true)
      expect(names.has(older), `0.2.0 must not keep ${older}`).toBe(false)
    }
    expect(missingIcons(moduleFromNames(names))).toEqual([])
  })
})

/**
 * #877 / #881 / #893: the alias table only saves the page if every call site
 * goes through it. HostRecoveryBanner imported `IconWarningOutline16` straight
 * off the primitives module, so on 0.2.0-rc.2 it rendered `undefined` — React
 * #130, the error boundary in place of the market, and the one banner that can
 * undo DSH's own patch wipe taken down by its own icon.
 */
describe('every icon call site goes through the alias table (#877)', () => {
  const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'client')
  const sources = readdirSync(clientDir).filter(name => /\.tsx?$/.test(name))

  it('imports no Icon* from the host primitives package', () => {
    const offenders: string[] = []
    for (const file of sources) {
      const source = readFileSync(join(clientDir, file), 'utf8')
      const imports = source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@deepseek-ai\/dsh-client-ui-primitives'/g)
      for (const match of imports) {
        for (const raw of match[1]!.split(',')) {
          const name = (raw.trim().split(/\s+as\s+/)[0] ?? '').trim()
          // Any icon, not just the aliased ones: a glyph the table does not
          // know yet still has to be added to it before a call site uses it.
          if (/^Icon/.test(name)) offenders.push(`${file}: ${name}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('reads a directory that actually holds the call sites', () => {
    // A rename of src/client would otherwise turn the guard above into a test
    // over an empty list.
    expect(sources.filter(name => name.endsWith('.tsx')).length).toBeGreaterThan(8)
    expect(readFileSync(join(clientDir, 'icons.ts'), 'utf8')).toContain('@deepseek-ai/dsh-client-ui-primitives')
  })
})
