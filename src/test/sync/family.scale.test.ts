// CONTRACT_GAP: the 20,000 records are seeded with applyIncomingRecords (no
//   rev), so they leave the device only in a full-snapshot push; the removal's
//   re-encryption is that push. The progress phase name 'reencrypt' is from the
//   FamilyProgress type in the Interface Contract.
//
// Scale (criterion 25): rotation and re-encryption of 20,000 Family records
// completes within the (generous) timeout and emits progress events.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { FamilyProgress } from '@/lib/sync/types'
import type { SimDevice } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import type { SyncRecord } from '@/lib/syncRecords'
import { startFamilyDb } from '@/test/sql/familyHarness'
import {
  act,
  createFamilyOn,
  cycle,
  familyActionsOf,
  firstDevice,
  joinFamily,
  newUser,
  userIdOf,
} from '@/test/sync/familySim'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.mock('@/lib/accountSession', () => ({
  getAccountSession: () => {
    const id = (globalThis as Record<string, unknown>).__minimaActingUser
    return Promise.resolve(typeof id === 'string' ? { userId: id, email: null } : null)
  },
}))
vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 })

const COUNT = 20_000
const T0 = '2026-10-01T10:00:00.000Z'

let ctx: SqlTestDb
let o1: SimDevice
let b1: SimDevice
let spaceId: string
let progress: Array<FamilyProgress> = []

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
        data: { id, amount: i + 1, currency: 'UAH', categoryId, description: `bulk ${i}`, createdAt, updatedAt: T0 },
      })
    }
    await act(device, () => device.localDb.applyIncomingRecords(spaceId, slice))
  }
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T09:00:00.000Z'))
  ctx = await startFamilyDb()
  o1 = await firstDevice(await newUser(ctx), 'O1')
  b1 = await firstDevice(await newUser(ctx), 'B1')
  spaceId = await createFamilyOn(o1, 'Scale')
  await joinFamily(o1, b1)
  const [category] = await act(o1, () => o1.localDb.spaceDb(spaceId).getAllCategories())
  await seed(o1, category.id)

  await act(o1, () => familyActionsOf(o1).removeMember(userIdOf(b1)))
  await cycle(o1)
  progress = o1.familyEvents.flatMap((e) =>
    e.type === 'state' && e.state.progress?.phase === 'reencrypt' ? [e.state.progress] : [],
  )
}, 900_000)

afterAll(async () => {
  o1.dispose()
  b1.dispose()
  vi.useRealTimers()
  await ctx.close()
})

describe('rotating and re-encrypting 20,000 Family records', () => {
  it('leaves every row on key version 2', async () => {
    const rows = await ctx.admin<{ n: number; v: number }>(
      'select count(*)::int as n, count(distinct key_version)::int as v from public.space_records where space_id = $1',
      [spaceId],
    )
    const versions = await ctx.admin<{ key_version: number }>('select distinct key_version from public.space_records where space_id = $1', [spaceId])

    expect(rows[0].n).toBeGreaterThanOrEqual(COUNT)
    expect(rows[0].v).toBe(1)
    expect(versions[0].key_version).toBe(2)
  })

  it('emits several re-encrypt progress events that grow to the total', () => {
    expect(progress.length).toBeGreaterThan(2)
    const dones = progress.map((p) => p.done)
    expect([...dones].sort((a, b) => a - b)).toEqual(dones)
    expect(progress.at(-1)?.total ?? 0).toBeGreaterThanOrEqual(COUNT)
    expect(progress.at(-1)?.done ?? 0).toBeGreaterThan(COUNT / 2)
    expect(new Set(dones).size).toBeGreaterThan(1)
  })

  it('ends synced', () => {
    expect(o1.family?.getState().status).toBe('synced')
  })
})
