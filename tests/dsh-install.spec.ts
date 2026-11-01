/**
 * Unit tests for host detection (src/dsh-install.ts). The CLI and Desktop
 * layouts are covered in tests/check.spec.ts; this file covers the launcher
 * install anchor, the one input the process entry itself cannot reveal.
 *
 * The anchor source is process-wide by design — every lookup in a process
 * answers the same host — so a test that installs one must put the default
 * back in `afterEach`, or it leaks into the next test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dshHostInfo,
  findDshInstallDir,
  hostInfoFromAnchor,
  setLauncherInstallAnchorSource,
} from '../src/dsh-install.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dsh-host-'))
})

afterEach(() => {
  setLauncherInstallAnchorSource(() => null)
  rmSync(tmp, { recursive: true, force: true })
})

/** Write a package manifest at `dir`, creating it, and return the directory. */
function writeManifest(dir: string, manifest: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  return dir
}

/** Write a dsh package at `dir`. */
function writeDsh(dir: string, version: string): string {
  return writeManifest(dir, { name: '@deepseek-ai/dsh', version })
}

/**
 * An app entry point no walk can turn into a dsh install — the embedded-host
 * shape: argv[1] is the app's own file, and there is no Electron resources
 * directory.
 */
function embeddedEntry(): string {
  const entry = join(tmp, 'app', 'resources', 'main.js')
  mkdirSync(join(tmp, 'app', 'resources'), { recursive: true })
  writeFileSync(entry, '')
  return entry
}

describe('the launcher install anchor (embedded hosts)', () => {
  it('locates the host through the anchor when the process entry reveals none', () => {
    const install = writeDsh(join(tmp, 'core', 'node_modules', '@deepseek-ai', 'dsh'), '0.2.1-rc.3')
    const entry = embeddedEntry()

    // Nothing to find without the anchor: this is the bug the anchor fixes.
    expect(dshHostInfo(entry)).toBeNull()

    setLauncherInstallAnchorSource(() => join(install, 'package.json'))

    expect(dshHostInfo(entry)).toEqual({ version: '0.2.1-rc.3', directory: install })
    expect(findDshInstallDir(entry)).toBe(install)
  })

  it('keeps every entry-based layout ahead of the anchor', () => {
    const cli = writeDsh(join(tmp, 'cli'), '0.1.1-rc.2')
    writeFileSync(join(cli, 'bin.js'), '')
    const anchored = writeDsh(join(tmp, 'other'), '9.9.9')
    setLauncherInstallAnchorSource(() => join(anchored, 'package.json'))

    // The entry walk resolves symlinks, and on macOS the temp directory is
    // reached through one (`/var` -> `/private/var`), so the expected
    // directory is the resolved spelling — Linux CI would not have caught it.
    expect(dshHostInfo(join(cli, 'bin.js'))).toEqual({ version: '0.1.1-rc.2', directory: realpathSync(cli) })
  })

  it('re-reads the source per lookup, so a launcher that publishes late still counts', () => {
    const install = writeDsh(join(tmp, 'core', 'node_modules', '@deepseek-ai', 'dsh'), '0.2.1-rc.3')
    const entry = embeddedEntry()
    let anchor: string | null = null
    setLauncherInstallAnchorSource(() => anchor)

    expect(dshHostInfo(entry)).toBeNull()

    anchor = join(install, 'package.json')

    expect(dshHostInfo(entry)).toEqual({ version: '0.2.1-rc.3', directory: install })
  })

  it('does not trust an anchor that names something else', () => {
    const impostor = writeManifest(join(tmp, 'core', 'node_modules', '@deepseek-ai', 'dsh'), {
      name: 'not-the-dsh-host',
      version: '9.9.9',
    })
    setLauncherInstallAnchorSource(() => join(impostor, 'package.json'))

    expect(dshHostInfo(embeddedEntry())).toBeNull()
  })

  it('ignores an anchor that is not an absolute path or names no host', () => {
    expect(hostInfoFromAnchor('core/node_modules/@deepseek-ai/dsh/package.json')).toBeNull()
    expect(hostInfoFromAnchor(join(tmp, 'missing', 'package.json'))).toBeNull()
    expect(hostInfoFromAnchor(null)).toBeNull()
    expect(hostInfoFromAnchor(undefined)).toBeNull()
  })

  it('resolves an anchor that names a flat Desktop root through the corroboration rule', () => {
    const app = writeManifest(join(tmp, 'desktop'), { name: '@deepseek-ai/dsh-desktop', version: '0.2.0-rc.2' })
    // Every in-box witness must agree; a missing one counts as disagreement.
    for (const name of ['dsh-base', 'dsh-web-app', 'dsh-web', 'dsh-settings']) {
      writeManifest(join(app, 'node_modules', '@deepseek-ai', name), {
        name: `@deepseek-ai/${name}`,
        version: '0.2.0-rc.2',
      })
    }

    expect(hostInfoFromAnchor(join(app, 'package.json'))).toEqual({ version: '0.2.0-rc.2', directory: app })
  })
})
