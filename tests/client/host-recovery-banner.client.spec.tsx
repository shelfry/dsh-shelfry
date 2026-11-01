// @vitest-environment jsdom
/**
 * #875, from the browser's side.
 *
 * Three things matter about this banner and nothing else does: it must be
 * ABSENT for every profile the host's recovery never touched (it sits above
 * the plugin list, and a standing alarm there is the thing this project's
 * own rules forbid); it must say how much is recoverable, in a number a
 * person can check against their own memory; and the one click must actually
 * name the backup — the server restores a file it just read off the
 * directory, so the request has to carry that exact name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement as h } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { formatBytes, hostRecoveryOf, HostRecoveryBanner } from '../../src/client/HostRecoveryBanner.tsx'

const t = (key: string): string => key

/**
 * The real dictionary hands this component templates (`备份：{0}，{1}`), and
 * the substitution is the component's job — so the test that cares about the
 * numbers uses templates instead of keys.
 */
const TEMPLATES: Record<string, string> = {
  hostRecoveryBody: 'lost {0}',
  hostRecoverySource: '{0} / {1}',
  hostRecoveryRestored: 'restored {0}',
}
const tpl = (key: string): string => TEMPLATES[key] ?? key

/** One backup of the size #875 lost, stamped the way the host stamps them. */
const VIEW = {
  patchName: 'cordis.patch.yml',
  currentBytes: 18,
  backups: [{ name: 'cordis.patch.yml.bak-1792065596554', stamp: 1_792_065_596_554, bytes: 22_679, rowIds: ['llm-pi-ai', 'llm-deepseek'] }],
  lostRowIds: ['llm-pi-ai', 'llm-deepseek'],
  offerRestore: true,
}

let calls: Array<{ url: string; method: string; body: unknown }> = []
let respond: (url: string) => { ok: boolean; body: unknown }

beforeEach(() => {
  calls = []
  respond = url => (url.includes('/host-recovery/restore')
    ? { ok: true, body: { ok: true, restored: { name: VIEW.backups[0].name, bytes: 22_679, rows: 2 } } }
    : { ok: true, body: VIEW })
  vi.stubGlobal('fetch', async (input: string, init?: { method?: string; body?: string }) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    const answer = respond(url)
    return { ok: answer.ok, json: async () => answer.body }
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

describe('hostRecoveryOf', () => {
  it('accepts the server payload and drops what it cannot read', () => {
    const view = hostRecoveryOf({ ...VIEW, backups: [...VIEW.backups, { name: 42 }, null] })
    expect(view?.backups.map(entry => entry.name)).toEqual([VIEW.backups[0].name])
  })

  it('refuses a payload that does not carry the decision', () => {
    expect(hostRecoveryOf({})).toBeNull()
    expect(hostRecoveryOf(null)).toBeNull()
  })

  it('formats the size the way the backup file would read', () => {
    expect(formatBytes(22_679)).toBe('22.1 KB')
    expect(formatBytes(746)).toBe('746 B')
    expect(formatBytes(2_500_000)).toBe('2.4 MB')
  })
})

describe('HostRecoveryBanner', () => {
  it('says nothing when the profile was never touched', async () => {
    respond = () => ({ ok: true, body: { ...VIEW, backups: [], lostRowIds: [], offerRestore: false } })
    const { container } = render(h(HostRecoveryBanner, { t, bootId: 'boot-1' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(container.textContent).toBe('')
  })

  it('names what is recoverable and how big it is', async () => {
    // `t` is the identity here, so the assertions read the KEYS and the parts
    // this component itself formats: the row count, the size, the stamp.
    const { container } = render(h(HostRecoveryBanner, { t: tpl, bootId: 'boot-1' }))
    await waitFor(() => expect(screen.getByText('hostRecoveryTitle')).toBeTruthy())
    const text = container.textContent ?? ''
    // The count is the number of rows the live patch no longer has — the one
    // figure the user can check against what they remember.
    expect(text).toContain('lost 2')
    expect(text).toContain('22.1 KB')
    expect(text).toContain(new Date(VIEW.backups[0].stamp).toLocaleString())
    expect(text).toContain('hostRecoveryNote')
  })

  it('restores the backup it is showing, and says how much came back', async () => {
    render(h(HostRecoveryBanner, { t: tpl, bootId: 'boot-1' }))
    await waitFor(() => expect(screen.getByText('hostRecoveryRestore')).toBeTruthy())
    fireEvent.click(screen.getByText('hostRecoveryRestore'))
    await waitFor(() => expect(screen.getByText(/restored/)).toBeTruthy())
    expect(screen.getByText('restored 2')).toBeTruthy()
    const restore = calls.find(call => call.url.includes('/host-recovery/restore'))
    expect(restore?.method).toBe('POST')
    expect(restore?.body).toEqual({ name: VIEW.backups[0].name })
  })

  it('shows the server\'s reason when the restore is refused', async () => {
    respond = url => (url.includes('/host-recovery/restore')
      ? { ok: false, body: { ok: false, error: 'refused to write without a snapshot' } }
      : { ok: true, body: VIEW })
    render(h(HostRecoveryBanner, { t, bootId: 'boot-1' }))
    await waitFor(() => expect(screen.getByText('hostRecoveryRestore')).toBeTruthy())
    fireEvent.click(screen.getByText('hostRecoveryRestore'))
    await waitFor(() => expect(screen.getByText(/refused to write without a snapshot/)).toBeTruthy())
  })

  it('stays dismissed for this boot only', async () => {
    const { unmount } = render(h(HostRecoveryBanner, { t, bootId: 'boot-1' }))
    await waitFor(() => expect(screen.getByText('hostRecoveryTitle')).toBeTruthy())
    fireEvent.click(screen.getByText('dismiss'))
    expect(screen.queryByText('hostRecoveryTitle')).toBeNull()
    unmount()
    // A new boot asks again: the backup is still there, and the loss is still
    // there, unless the user restored it.
    render(h(HostRecoveryBanner, { t, bootId: 'boot-2' }))
    await waitFor(() => expect(screen.getByText('hostRecoveryTitle')).toBeTruthy())
  })
})
