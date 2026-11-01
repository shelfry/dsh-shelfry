/**
 * pnpm store hygiene: orphaned staging-dir reclamation. Real directory
 * fixtures under a temp root; pid liveness is checked against the current
 * process (alive) and a dead pid.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstallResult } from '../src/dsh-cli.ts'
import { cleanOrphanedIgnored, cleanOrphanedStore, cleanOrphanedStoreTmp } from '../src/store.ts'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dshm-store-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('cleanOrphanedStoreTmp', () => {
  it('removes only staging dirs whose owning pid is gone; keeps live and non-staging entries', () => {
    const store = join(root, 'store')
    const tmp = join(store, 'tmp')
    // Dead owner: this pid can never be alive.
    const dead = join(tmp, '_tmp_99999999_deadbeef')
    mkdirSync(dead, { recursive: true })
    writeFileSync(join(dead, 'payload.bin'), 'x')
    // Live owner: the current process.
    const live = join(tmp, `_tmp_${process.pid}_live`)
    mkdirSync(live, { recursive: true })
    // Non-staging shapes must survive untouched.
    mkdirSync(join(tmp, 'not-a-staging-dir'), { recursive: true })
    writeFileSync(join(tmp, 'plain-file.txt'), 'y')

    expect(cleanOrphanedStoreTmp(store)).toEqual(['_tmp_99999999_deadbeef'])
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(join(tmp, 'not-a-staging-dir'))).toBe(true)
    expect(existsSync(join(tmp, 'plain-file.txt'))).toBe(true)
  })

  it('returns empty for a store without a tmp dir or without staging entries', () => {
    expect(cleanOrphanedStoreTmp(join(root, 'empty-store'))).toEqual([])
    const store = join(root, 'store2')
    mkdirSync(join(store, 'tmp', 'some-other-dir'), { recursive: true })
    expect(cleanOrphanedStoreTmp(store)).toEqual([])
  })
})

describe('cleanOrphanedStore', () => {
  const ok = (stdout: string): InstallResult => ({ exitCode: 0, timedOut: false, stdout, stderr: '', cancelled: false })

  it('resolves the store root through the runner and reclaims orphans', async () => {
    const store = join(root, 'store')
    mkdirSync(join(store, 'tmp', '_tmp_99999999_orphan'), { recursive: true })
    const calls: string[][] = []
    const run = async (_profile: string, args: string[]): Promise<InstallResult> => {
      calls.push(args)
      return ok(`${store}\n`)
    }
    expect(await cleanOrphanedStore(run, 'web')).toEqual(['_tmp_99999999_orphan'])
    expect(calls).toEqual([['store', 'path']])
  })

  it('does nothing when the runner fails, is cancelled, or prints a non-absolute path', async () => {
    const store = join(root, 'store')
    mkdirSync(join(store, 'tmp', '_tmp_99999999_orphan'), { recursive: true })
    const failing = async (_p: string, args: string[]): Promise<InstallResult> =>
      ({ exitCode: 1, timedOut: false, stdout: '', stderr: 'boom', cancelled: false, ...(args[0] === 'store' ? { stdout: `${store}\n` } : {}) })
    expect(await cleanOrphanedStore(failing, 'web')).toEqual([])
    expect(existsSync(join(store, 'tmp', '_tmp_99999999_orphan'))).toBe(true)

    const relative = async (): Promise<InstallResult> => ok('relative/path\n')
    expect(await cleanOrphanedStore(relative, 'web')).toEqual([])
  })
})

describe('cleanOrphanedIgnored (#974)', () => {
  it('removes quarantine copies and keeps .bak leftovers', () => {
    // pnpm moves alien / interrupted packages into node_modules/.ignored
    // and never reclaims them. Staging dirs, whole scoped copies, and the
    // numbered `foo_1` rename all belong there; a `.bak` leftover does not.
    const profile = join(root, 'profile')
    const ignored = join(profile, 'node_modules', '.ignored')
    mkdirSync(join(ignored, 'dsh-shelfry_tmp_21960_12'), { recursive: true })
    writeFileSync(join(ignored, 'dsh-shelfry_tmp_21960_12', 'package.json'), '{}')
    mkdirSync(join(ignored, '@jimp', 'png'), { recursive: true })
    writeFileSync(join(ignored, '@jimp', 'png', 'package.json'), '{}')
    mkdirSync(join(ignored, 'dsh-mnemon-source-skills_1'), { recursive: true })
    writeFileSync(join(ignored, 'dsh-mnemon-source-skills_1', 'package.json'), '{}')
    mkdirSync(join(ignored, 'dsh-workbuddy-connect.bak-20261017T153851'), { recursive: true })
    writeFileSync(join(ignored, 'dsh-workbuddy-connect.bak-20261017T153851', 'package.json'), '{}')
    mkdirSync(join(ignored, '@other', 'pkg.bak-asm'), { recursive: true })
    writeFileSync(join(ignored, '@other', 'pkg.bak-asm', 'package.json'), '{}')

    expect(cleanOrphanedIgnored(profile).sort()).toEqual([
      '@jimp/png',
      'dsh-mnemon-source-skills_1',
      'dsh-shelfry_tmp_21960_12',
    ])
    expect(existsSync(join(ignored, 'dsh-shelfry_tmp_21960_12'))).toBe(false)
    expect(existsSync(join(ignored, '@jimp'))).toBe(false)
    expect(existsSync(join(ignored, 'dsh-mnemon-source-skills_1'))).toBe(false)
    expect(existsSync(join(ignored, 'dsh-workbuddy-connect.bak-20261017T153851'))).toBe(true)
    expect(existsSync(join(ignored, '@other', 'pkg.bak-asm'))).toBe(true)
  })

  it('is a no-op when .ignored is missing', () => {
    expect(cleanOrphanedIgnored(join(root, 'empty-profile'))).toEqual([])
  })
})
