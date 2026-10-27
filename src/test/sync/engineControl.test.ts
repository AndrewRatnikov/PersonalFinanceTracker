// No CONTRACT_GAPs: triggers, the cross-tab lock, locking and backoff are
// specified in plan section 7 (criteria 3, 9, 10). The real engine runs on a
// simulated device with its own timers (SimClock, advanced by hand), a fake
// window/document event source and a fake navigator.locks. One cycle that
// reaches the server makes exactly one get_sync_status call, so that count is
// the number of cycles.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { RpcResponse } from '@/lib/cloud/api'
import type { SimDevice } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import { startDb } from '@/test/sql/harness'
import { createSyncedPair } from '@/test/sync/simDevice'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

const PW = 'engine control password'
const DEBOUNCE = 2000
const INTERVAL = 60_000

const NETWORK_DOWN: RpcResponse = {
  data: null,
  error: { message: 'Failed to fetch' },
  status: 0,
}

let ctx: SqlTestDb
const devices: Array<SimDevice> = []

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-24T09:00:00.000Z'))
  ctx = await startDb()
}, 60_000)

afterEach(() => {
  for (const d of devices.splice(0)) d.dispose()
})

afterAll(async () => {
  vi.useRealTimers()
  await ctx.close()
})

async function pair() {
  const p = await createSyncedPair(ctx, PW, true)
  devices.push(p.a, p.b)
  return p
}

const cycles = (d: SimDevice) => d.count('get_sync_status')

// Polls with real timers (Date is frozen).
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

async function quiet(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150))
}

async function addExpense(d: SimDevice, categoryId: string, n: number) {
  return d.localDb.addExpense({
    amount: 1000 + n,
    currency: 'UAH',
    categoryId,
    description: `edit ${n}`,
    createdAt: '2026-10-22T09:00:00.000Z',
  })
}

describe('triggers', () => {
  it('start() runs one cycle at once, even when called twice', async () => {
    const p = await pair()
    const base = cycles(p.a)

    p.a.engine.start()
    p.a.engine.start()
    await until(() => cycles(p.a) === base + 1 && p.a.engine.getState().status === 'synced', 'unlock cycle')
    await quiet()

    expect(cycles(p.a)).toBe(base + 1)
    expect(p.a.locks.requested).toContain('minima-sync')
  })

  it('five quick edits give one push cycle two seconds after the last one', async () => {
    const p = await pair()
    p.a.engine.start()
    await until(() => p.a.engine.getState().status === 'synced', 'first cycle')
    await quiet()
    const before = cycles(p.a)
    const pushesBefore = p.a.count('push_records')

    for (let n = 0; n < 5; n++) await addExpense(p.a, p.seed!.categoryId, n)

    expect(p.a.clock.pending()).toContain(DEBOUNCE)
    await p.a.clock.advance(DEBOUNCE - 1)
    await quiet()
    expect(cycles(p.a)).toBe(before)

    await p.a.clock.advance(1)
    await until(() => cycles(p.a) === before + 1 && p.a.engine.getState().status === 'synced', 'debounced cycle')
    await quiet()

    expect(cycles(p.a)).toBe(before + 1)
    expect(p.a.count('push_records')).toBe(pushesBefore + 1)
    const pushCall = p.a.calls.filter((c) => c.fn === 'push_records').at(-1)
    expect((pushCall?.args.p_records as Array<unknown>).length).toBe(5)

    await p.b.actions.syncNow()
    expect((await p.b.localDb.getAllExpenses()).length).toBe(7)
  })

  it('each new edit restarts the two seconds', async () => {
    const p = await pair()
    p.a.engine.start()
    await until(() => p.a.engine.getState().status === 'synced', 'first cycle')
    await quiet()
    const before = cycles(p.a)

    await addExpense(p.a, p.seed!.categoryId, 1)
    await p.a.clock.advance(DEBOUNCE - 500)
    await addExpense(p.a, p.seed!.categoryId, 2)
    await p.a.clock.advance(DEBOUNCE - 500)
    await quiet()
    expect(cycles(p.a)).toBe(before)

    await p.a.clock.advance(500)
    await until(() => cycles(p.a) === before + 1, 'cycle after the last edit')
  })

  it('the online event runs a cycle; offline makes no call at all', async () => {
    const p = await pair()
    p.a.engine.start()
    await until(() => p.a.engine.getState().status === 'synced', 'first cycle')
    await quiet()

    p.a.state.online = false
    const mark = p.a.calls.length
    p.a.engine.requestCycle('manual')
    await until(() => p.a.engine.getState().status === 'offline', 'offline state')
    expect(p.a.calls.length).toBe(mark)

    p.a.state.online = true
    p.a.env.fire('window', 'online')
    await until(() => p.a.engine.getState().status === 'synced' && p.a.calls.length > mark, 'back online')
    expect(p.a.calls[mark].fn).toBe('get_sync_status')
  })

  it('visibilitychange runs a cycle only when the tab is visible', async () => {
    const p = await pair()
    p.a.engine.start()
    await until(() => p.a.engine.getState().status === 'synced', 'first cycle')
    await quiet()
    const before = cycles(p.a)

    p.a.env.visible = false
    p.a.env.fire('document', 'visibilitychange')
    await quiet()
    expect(cycles(p.a)).toBe(before)

    p.a.env.visible = true
    p.a.env.fire('document', 'visibilitychange')
    await until(() => cycles(p.a) === before + 1, 'visible cycle')
  })

  it('runs every 60 seconds while visible and not while hidden', async () => {
    const p = await pair()
    p.a.engine.start()
    await until(() => p.a.engine.getState().status === 'synced', 'first cycle')
    await quiet()
    const before = cycles(p.a)

    await p.a.clock.advance(INTERVAL)
    await until(() => cycles(p.a) === before + 1, 'interval cycle')

    p.a.env.visible = false
    await p.a.clock.advance(INTERVAL)
    await quiet()
    expect(cycles(p.a)).toBe(before + 1)

    p.a.env.visible = true
    await p.a.clock.advance(INTERVAL)
    await until(() => cycles(p.a) === before + 2, 'interval cycle again')
  })

  it('Sync now runs immediately without a debounce', async () => {
    const p = await pair()
    const before = cycles(p.a)
    const result = await p.a.actions.syncNow()
    expect(result.ran).toBe(true)
    expect(cycles(p.a)).toBe(before + 1)
  })
})

describe('one cycle at a time across tabs', () => {
  it('a cycle that finds the lock held is skipped with no call', async () => {
    const p = await pair()
    p.a.locks.held = true
    const mark = p.a.calls.length

    const result = await p.a.actions.syncNow()

    expect(result.ran).toBe(false)
    expect(p.a.calls.length).toBe(mark)
    expect(p.a.locks.requested.at(-1)).toBe('minima-sync')

    p.a.locks.held = false
    const next = await p.a.actions.syncNow()
    expect(next.ran).toBe(true)
    expect(p.a.calls.length).toBeGreaterThan(mark)
  })

  it('a second cycle requested during a running one does not run in parallel', async () => {
    const p = await pair()
    let waiting = false
    let release: () => void = () => undefined
    p.a.intercept = (call) => {
      if (call.fn !== 'get_sync_status') return undefined
      p.a.intercept = null
      waiting = true
      return new Promise<undefined>((resolve) => {
        release = () => resolve(undefined)
      })
    }

    const first = p.a.actions.syncNow()
    await until(() => waiting, 'first cycle waiting')
    const second = await p.a.actions.syncNow()
    expect(second.ran).toBe(false)

    release()
    expect((await first).ran).toBe(true)
  })
})

describe('locking and stopping', () => {
  it('locking the vault during a cycle stops it after the current request: nothing is pushed', async () => {
    const p = await pair()
    const edit = await addExpense(p.a, p.seed!.categoryId, 99)
    const pushes = p.a.count('push_records')
    const records = (await ctx.admin<{ n: number }>(
      'select count(*)::int as n from public.sync_records where user_id = $1',
      [p.userId],
    ))[0].n

    p.a.intercept = (call) => {
      if (call.fn === 'pull_records') {
        p.a.intercept = null
        p.a.vault.lockVault()
      }
      return undefined
    }
    await p.a.actions.syncNow()

    expect(p.a.count('push_records')).toBe(pushes)
    expect(
      (await ctx.admin<{ n: number }>('select count(*)::int as n from public.sync_records where user_id = $1', [p.userId]))[0].n,
    ).toBe(records)
    expect(p.a.engine.getState().status).not.toBe('syncing')

    // Locked: later cycles do nothing at all.
    const mark = p.a.calls.length
    await p.a.actions.syncNow()
    expect(p.a.calls.length).toBe(mark)

    // Unlocked again, the edit goes out.
    await p.a.vault.unlockWithPassword(PW)
    const resumed = await p.a.actions.syncNow()
    expect(resumed.status).toBe('synced')
    await p.b.actions.syncNow()
    expect((await p.b.localDb.getAllExpenses()).map((e) => e.id)).toContain(edit.id)
  })

  it('stop() removes every listener and timer, so nothing runs afterwards (sign-out)', async () => {
    const p = await pair()
    p.a.engine.start()
    await until(() => p.a.engine.getState().status === 'synced', 'first cycle')
    await quiet()
    expect(p.a.env.listenerCount()).toBeGreaterThan(0)

    p.a.engine.stop()
    p.a.engine.stop()

    expect(p.a.env.listenerCount()).toBe(0)
    expect(p.a.clock.pending()).toEqual([])
    const before = cycles(p.a)
    await addExpense(p.a, p.seed!.categoryId, 1)
    await p.a.clock.advance(10 * INTERVAL)
    p.a.env.fire('window', 'online')
    p.a.env.fire('document', 'visibilitychange')
    await quiet()
    expect(cycles(p.a)).toBe(before)
    expect(p.a.clock.pending()).toEqual([])
  })

  it('starting again after a stop works like the first time', async () => {
    const p = await pair()
    p.a.engine.start()
    await until(() => p.a.engine.getState().status === 'synced', 'first cycle')
    p.a.engine.stop()
    const before = cycles(p.a)

    p.a.engine.start()
    await until(() => cycles(p.a) === before + 1, 'cycle after restart')
    expect(p.a.env.listenerCount()).toBeGreaterThan(0)
  })
})

describe('retry with backoff', () => {
  function failGate(d: SimDevice, on: boolean) {
    d.intercept = on ? (call) => (call.fn === 'get_sync_status' ? NETWORK_DOWN : undefined) : null
  }

  it('retries after 5 s, 10 s, 20 s and starts again at 5 s after a success', async () => {
    const p = await pair()
    const base = cycles(p.a)
    failGate(p.a, true)

    p.a.engine.start()
    await until(() => cycles(p.a) === base + 1 && p.a.engine.getState().status === 'error', 'first failure')
    expect(p.a.engine.getState().errorCode).toBe('network')
    expect(p.a.clock.pending()).toContain(5000)

    await p.a.clock.advance(5000)
    await until(() => cycles(p.a) === base + 2, 'second attempt')
    await until(() => p.a.clock.pending().includes(10_000), 'ten second timer')

    await p.a.clock.advance(10_000)
    await until(() => cycles(p.a) === base + 3, 'third attempt')
    await until(() => p.a.clock.pending().includes(20_000), 'twenty second timer')

    failGate(p.a, false)
    await p.a.clock.advance(20_000)
    await until(() => cycles(p.a) === base + 4 && p.a.engine.getState().status === 'synced', 'recovery')

    failGate(p.a, true)
    p.a.engine.requestCycle('manual')
    await until(() => cycles(p.a) === base + 5 && p.a.engine.getState().status === 'error', 'new failure')
    expect(p.a.clock.pending()).toContain(5000)
    expect(p.a.clock.pending()).not.toContain(40_000)
  })

  it('the error is kept in meta:sync as the last error', async () => {
    const p = await pair()
    failGate(p.a, true)
    await p.a.actions.syncNow()
    const meta = await p.a.syncMeta.readSyncMeta()
    expect(meta.lastError).toMatchObject({ code: 'network' })
    failGate(p.a, false)
    await p.a.actions.syncNow()
    expect((await p.a.syncMeta.readSyncMeta()).lastError).toBeNull()
  })

  it('a failure that is not worth retrying schedules no retry', async () => {
    const p = await pair()
    p.a.engine.start()
    await until(() => p.a.engine.getState().status === 'synced', 'first cycle')
    await quiet()
    const pending = p.a.clock.pending().length

    p.a.intercept = (call) =>
      call.fn === 'push_records'
        ? { data: null, error: { message: 'MINIMA:quota_exceeded' }, status: 400 }
        : undefined
    await addExpense(p.a, p.seed!.categoryId, 5)
    await p.a.actions.syncNow()

    expect(p.a.engine.getState()).toMatchObject({ status: 'error', errorCode: 'quota_exceeded' })
    expect(p.a.clock.pending()).not.toContain(5000)
    expect(p.a.clock.pending().length).toBeLessThanOrEqual(pending + 1)
  })
})
