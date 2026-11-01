/**
 * A live Agent whose public maintenance boundary the drain tests can drive.
 *
 * It follows the contract the coordinator relies on: `runMaintenance` claims
 * synchronously and throws when a turn or another maintenance task owns the
 * Agent; `whenIdle` resolves only when the Agent is genuinely idle. Turn and
 * maintenance transitions are manual so a test can hold a turn open across a
 * request and observe that no package command ran.
 */
export class FakeAgent {
  readonly id: string
  status: 'idle' | 'running'
  maintenanceCalls = 0
  cancelCalls = 0
  failClaims = 0
  /** Emulate a host that invokes the maintenance task with an aborted signal. */
  startAbortedOnce = false
  private maintenance: { controller: AbortController } | null = null
  private idleWaiters: Array<() => void> = []

  constructor(id: string, status: 'idle' | 'running' = 'idle') {
    this.id = id
    this.status = status
  }

  get held(): boolean {
    return this.maintenance !== null
  }

  whenIdle(): Promise<void> {
    if (this.status === 'idle' && this.maintenance === null) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.startAbortedOnce) {
      this.startAbortedOnce = false
      const controller = new AbortController()
      controller.abort()
      return Promise.resolve(task(controller.signal))
    }
    if (this.failClaims > 0) {
      this.failClaims -= 1
      throw new Error('another maintenance task owns this agent')
    }
    if (this.status === 'running' || this.maintenance !== null) {
      throw new Error('agent is not at a safe boundary')
    }
    this.maintenanceCalls += 1
    const controller = new AbortController()
    this.maintenance = { controller }
    const run = Promise.resolve(task(controller.signal))
    return run.finally(() => {
      this.maintenance = null
      this.resolveIdle()
    }) as Promise<T>
  }

  /** The test's `Agent.cancel()`. Drain mode must never call this. */
  cancel(): void {
    this.cancelCalls += 1
  }

  startTurn(): void {
    if (this.maintenance !== null) throw new Error('waking input must stay behind the hold')
    this.status = 'running'
  }

  finishTurn(): void {
    this.status = 'idle'
    this.resolveIdle()
  }

  abortMaintenance(): void {
    this.maintenance?.controller.abort()
  }

  private resolveIdle(): void {
    if (this.status !== 'idle' || this.maintenance !== null) return
    const waiters = this.idleWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }
}

/** The service shape the market reads from `ctx.get('agents')`. */
export function agentsService(agents: FakeAgent[]): { list(): FakeAgent[] } {
  return { list: () => agents }
}
