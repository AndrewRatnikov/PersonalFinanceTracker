// No CONTRACT_GAPs: the 20,000-record first upload and download with progress
// are specified in plan sections 7 and 12 (criterion 33). The records are seeded
// with applyIncomingRecords (no rev, so the first push is the whole snapshot);
// the PGlite push and pull of 20k wire rows takes several seconds, hence the
// long timeout.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SyncProgress } from '@/lib/sync/types'
import type { SyncRecord } from '@/lib/syncRecords'
import type { SimDevice } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import { startDb } from '@/test/sql/harness'
import { createSimDevice } from '@/test/sync/simDevice'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

const PW = 'scale password'
const COUNT = 20_000
const T0 = '2026-10-01T10:00:00.000Z'

let ctx: SqlTestDb

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-24T09:00:00.000Z'))
  ctx = await startDb()
}, 60_000)

afterAll(async () => {
  vi.useRealTimers()
  await ctx.close()
})

function progressOf(device: SimDevice, phase: 'push' | 'pull'): Array<SyncProgress> {
  return device.events.flatMap((e) =>
    e.type === 'state' && e.state.status === 'syncing' && e.state.progress?.phase === phase
      ? [e.state.progress]
      : [],
  )
}

async function seed(device: SimDevice, categoryId: string) {
  for (let from = 0; from < COUNT; from += 2000) {
    const slice: Array<SyncRecord> = []
    for (let i = from; i < Math.min(from + 2000, COUNT); i++) {
      const id = crypto.randomUUID()
      const month = String((i % 12) + 1).padStart(2, '0')
      const createdAt = `2026-${month}-${String((i % 27) + 1).padStart(2, '0')}T09:00:00.000Z`
      slice.push({
        type: 'expense',
        id,
        updatedAt: T0,
        data: {
          id,
          amount: i + 1,
          currency: 'UAH',
          categoryId,
          description: `bulk ${i}`,
          createdAt,
          updatedAt: T0,
        },
      })
    }
    await device.localDb.applyIncomingRecords(slice)
  }
}

function sum(amounts: Array<number>): number {
  return amounts.reduce((a, b) => a + b, 0)
}

describe('20,000 records', () => {
  it('upload from the first device and download on the second complete with progress', async () => {
    const userId = await ctx.createUser()
    const rpc = ctx.rpcAs(userId)

    const a = await createSimDevice({ name: 'A', rpc, userId })
    await a.createAndUnlockVault(PW)
    const category = await a.localDb.addCategory({ name: 'Food' })
    await seed(a, category.id)
    expect((await a.localDb.getAllExpenses()).length).toBe(COUNT)

    // ── First upload ──────────────────────────────────────────────────────────
    const started = await a.actions.turnOn()
    expect(started.kind).toBe('created')
    expect(a.engine.getState().status).toBe('synced')

    const total = (await a.localDb.listChangedRecords(-1)).records.length
    expect(total).toBeGreaterThanOrEqual(COUNT)
    expect(started.kind === 'created' ? started.pushed : 0).toBe(total)
    const rows = await ctx.admin<{ n: number }>(
      'select count(*)::int as n from public.sync_records where user_id = $1',
      [userId],
    )
    expect(rows[0].n).toBe(total)
    expect(a.count('push_records')).toBe(Math.ceil(total / 500))

    const pushProgress = progressOf(a, 'push')
    expect(pushProgress.length).toBeGreaterThanOrEqual(10)
    const pushed = pushProgress.map((p) => p.done)
    expect([...pushed].sort((x, y) => x - y)).toEqual(pushed)
    expect(pushProgress.at(-1)).toEqual({ phase: 'push', done: total, total })
    expect(new Set(pushed).size).toBeGreaterThan(5)

    // ── Download on a fresh device ────────────────────────────────────────────
    const b = await createSimDevice({ name: 'B', rpc, userId })
    const cloud = await b.actions.fetchCloudVault()
    const restored = await b.actions.restoreFromCloud(cloud, { password: PW })

    expect(restored.status).toBe('synced')
    expect(restored.pulled).toBe(total)
    expect(b.count('pull_records')).toBeGreaterThanOrEqual(Math.ceil(total / 500))

    const pullProgress = progressOf(b, 'pull')
    expect(pullProgress.length).toBeGreaterThanOrEqual(10)
    const pulled = pullProgress.map((p) => p.done)
    expect([...pulled].sort((x, y) => x - y)).toEqual(pulled)
    expect(pullProgress.at(-1)?.done).toBe(total)
    expect(pullProgress.at(-1)?.total).toBe(total)

    const onA = await a.localDb.getAllExpenses()
    const onB = await b.localDb.getAllExpenses()
    expect(onB.length).toBe(COUNT)
    expect(new Set(onB.map((e) => e.id)).size).toBe(COUNT)
    expect(sum(onB.map((e) => e.amount))).toBe(sum(onA.map((e) => e.amount)))
    expect(sum(onB.map((e) => e.amount))).toBe((COUNT * (COUNT + 1)) / 2)
    expect(onB.map((e) => e.id).sort()).toEqual(onA.map((e) => e.id).sort())

    a.dispose()
    b.dispose()
  })
})
