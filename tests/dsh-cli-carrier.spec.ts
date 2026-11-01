/** Real child processes testing identity preservation, not the #975 startup failure. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nodeExecutable, runDshPlugin } from '../src/dsh-cli.ts'

const originalArgv = process.argv
const originalExecArgv = process.execArgv
let home: string | undefined

afterEach(() => {
  process.argv = originalArgv
  process.execArgv = originalExecArgv
  vi.unstubAllEnvs()
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
})

it('keeps the bundled carrier when PATH selects a different CLI', async () => {
  home = mkdtempSync(join(tmpdir(), 'dshm-carrier-'))
  writeFileSync(join(home, 'package.json'), '{"type":"module"}')
  const entry = join(home, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  mkdirSync(dirname(entry), { recursive: true })
  // The official entry path is established by the upstream launch scripts.
  // This fixture only records the command it receives; it does not model DSH.
  writeFileSync(entry, `
    console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))
  `)
  const pathBin = join(home, 'bin')
  mkdirSync(pathBin)
  const node = nodeExecutable()
  const otherEntry = join(home, 'other-cli.mjs')
  writeFileSync(otherEntry, 'console.error("different PATH CLI selected"); process.exit(23)')
  // An unrelated CLI on PATH must not replace the carrier serving this host.
  const shim = join(pathBin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  writeFileSync(shim, process.platform === 'win32'
    ? `@echo off\r\n"${node}" "${otherEntry}" %*\r\n`
    : `#!/bin/sh\nexec '${node.replaceAll("'", "'\\''")}' '${otherEntry.replaceAll("'", "'\\''")}' "$@"\n`,
  { mode: 0o755 })
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('PATH', `${pathBin}${delimiter}${process.env.PATH ?? ''}`)
  process.argv = [node, entry, 'web']
  process.execArgv = ['--no-warnings']
  const manual = spawnSync(node, [entry, 'plugin', '--profile', 'web', 'install'], {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  })
  expect(manual.status).toBe(0)
  const fallback = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'dsh plugin --profile web install'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true })
    : spawnSync('dsh', ['plugin', '--profile', 'web', 'install'],
      { encoding: 'utf8', timeout: 5000 })
  expect(fallback.status).toBe(23)
  expect(fallback.stderr).toContain('different PATH CLI selected')
  const inheritedCwd = realpathSync(process.cwd())
  for (const args of [['add', 'fixture@1.0.0'], ['add', '--force', 'fixture@2.0.0'], ['remove', 'fixture'], ['install']]) {
    const result = await runDshPlugin('web', args)
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false, stderr: '' })
    // Compare canonical paths: macOS may spell /var as /private/var in a child.
    // The bundled CLI inherits the parent's cwd, not the entry's directory.
    expect(JSON.parse(result.stdout)).toEqual({
      args: ['plugin', '--profile', 'web', ...args, '--reporter=ndjson'], cwd: inheritedCwd,
    })
  }
})
