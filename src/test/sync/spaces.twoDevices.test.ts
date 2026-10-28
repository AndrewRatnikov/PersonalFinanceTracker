// CONTRACT_GAP: that a personal spaceKey tombstone empties the other device's
//   list after the next personal sync is derived from decision D9 of the plan
//   (forgetLocalSpace tombstones the entry as a personal write).
// CONTRACT_GAP: Family data is NOT synced by the engine in this run, so device
//   two receives the Family records through applyIncomingRecords(spaceId, ...)
//   fed with the listing of device one (as run C's engine will do).
//
// Two simulated devices of one user (simDevice.ts) on the real PGlite server:
// the space key and the identity travel through personal sync, and the
// Family records are readable on the second device with that key.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SimDevice, SyncedPair } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import { startDb } from '@/test/sql/harness'
import { createSyncedPair } from '@/test/sync/simDevice'
import { isSpaceLockedError } from '@/lib/spaces/types'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const PW = 'two devices password'
const T0 = '2026-10-24T09:00:00.000Z'
const T1 = '2026-10-24T10:00:00.000Z'
const T2 = '2026-10-24T11:00:00.000Z'
const MARKER = 'Marker family dinner'
const CREATED = '2026-10-20T12:00:00.000Z'

let ctx: SqlTestDb
const pairs: Array<SyncedPair> = []

function at(iso: string) {
  vi.setSystemTime(new Date(iso))
}

async function sync(d: SimDevice) {
  const result = await d.actions.syncNow()
  expect(result.status, d.name).toBe('synced')
  return result
}

async function serverCount(userId: string): Promise<number> {
  const rows = await ctx.admin<{ n: number }>(
    'select count(*)::int as n from public.sync_records where user_id = $1',
    [userId],
  )
  return rows[0].n
}

async function newPair(): Promise<SyncedPair> {
  at(T0)
  const p = await createSyncedPair(ctx, PW, false)
  pairs.push(p)
  return p
}

async function familyExpense(d: SimDevice, spaceId: string, amount: number, description: string) {
  const fam = d.localDb.spaceDb(spaceId)
  const category = (await fam.getAllCategories())[0]
  return fam.addExpense({
    amount,
    currency: 'UAH',
    categoryId: category.id,
    description,
    createdAt: CREATED,
  })
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at(T0)
  ctx = await startDb()
}, 120_000)

afterAll(async () => {
  for (const p of pairs) {
    p.a.dispose()
    p.b.dispose()
  }
  vi.useRealTimers()
  await ctx.close()
})

describe('the space key reaches the second device through personal sync', () => {
  let p: SyncedPair
  let spaceId: string
  let expenseId: string
  let identityKey: JsonWebKey

  beforeAll(async () => {
    p = await newPair()
    identityKey = await p.a.localDb.getIdentityPublicKey()
    const space = await p.a.localDb.createLocalSpace({ name: 'Home', lang: 'en' })
    spaceId = space.id
    at(T1)
    expenseId = (await familyExpense(p.a, spaceId, 4242, MARKER)).id
    await sync(p.a)
    at(T2)
    await sync(p.b)
  }, 120_000)

  it('device two lists the space with its name, role and key version', async () => {
    const onA = await p.a.localDb.listLocalSpaces()
    const onB = await p.b.localDb.listLocalSpaces()

    expect(onA).toHaveLength(1)
    expect(onB).toEqual(onA)
    expect(onB[0]).toMatchObject({ id: spaceId, name: 'Home', role: 'owner', keyVersion: 1 })
  })

  it('device two has the same identity key pair', async () => {
    expect(await p.b.localDb.getIdentityPublicKey()).toEqual(identityKey)
    expect(await p.b.localDb.ensureIdentityKeyPair()).toEqual(
      await p.a.localDb.ensureIdentityKeyPair(),
    )
  })

  it('personal sync carries identity and the space key as personal records', async () => {
    const { records } = await p.b.localDb.listChangedRecords(-1)
    const types = records.map((r) => r.type)

    expect(types).toContain('identity')
    expect(types).toContain('spaceKey')
    expect(records.find((r) => r.type === 'spaceKey')?.id).toBe(spaceId)
  })

  it('device two decrypts the Family records applied with the space key', async () => {
    const { records } = await p.a.localDb.listChangedRecords(spaceId, -1)

    const result = await p.b.localDb.applyIncomingRecords(spaceId, records)

    expect(result.applied).toBe(records.length)
    const onB = await p.b.localDb.spaceDb(spaceId).getAllExpenses()
    expect(onB.map((e) => e.id)).toEqual([expenseId])
    expect(onB[0].amount).toBe(4242)
    expect(onB[0].description).toBe(MARKER)
    expect((await p.b.localDb.spaceDb(spaceId).getAllCategories()).length).toBeGreaterThan(3)
    expect((await p.b.localDb.getSpaceInfo(spaceId))?.name).toBe('Home')
  })

  it('device two can write to the space and device one reads it back', async () => {
    at(T2)
    const written = await familyExpense(p.b, spaceId, 17, 'from device two')

    const { records } = await p.b.localDb.listChangedRecords(spaceId, -1)
    await p.a.localDb.applyIncomingRecords(spaceId, records)

    const onA = await p.a.localDb.spaceDb(spaceId).getAllExpenses()
    expect(onA.map((e) => e.id).sort()).toEqual([expenseId, written.id].sort())
  })

  it('the personal data of the two devices is untouched by the Family records', async () => {
    expect(await p.a.localDb.getAllExpenses()).toEqual([])
    expect(await p.b.localDb.getAllExpenses()).toEqual([])
    const personalOnB = await p.b.localDb.listChangedRecords(-1)
    expect(personalOnB.records.some((r) => r.type === 'expense')).toBe(false)
  })

  it('no Family stream: the server holds only personal records, never the Family ones', async () => {
    const personal = await p.a.localDb.listChangedRecords(-1)
    const before = await serverCount(p.userId)

    at(T2)
    await familyExpense(p.a, spaceId, 99, 'another family expense')
    await sync(p.a)
    await sync(p.b)

    expect(before).toBe(personal.records.length)
    expect(await serverCount(p.userId)).toBe(before)
  })

  it('the server never sees the Family plaintext', async () => {
    const rows = await ctx.admin<{ ciphertext: string }>(
      'select ciphertext from public.sync_records where user_id = $1',
      [p.userId],
    )

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.ciphertext.includes(MARKER))).toBe(false)
    expect(JSON.stringify(rows)).not.toContain(MARKER)
  })
})

describe('before the key arrives', () => {
  it('device two cannot read or apply Family records, then can after personal sync', async () => {
    const p = await newPair()
    const space = await p.a.localDb.createLocalSpace({ name: 'Cabin', lang: 'en' })
    at(T1)
    await familyExpense(p.a, space.id, 55, 'cabin supplies')
    const { records } = await p.a.localDb.listChangedRecords(space.id, -1)

    await expect(p.b.localDb.applyIncomingRecords(space.id, records)).rejects.toSatisfy(
      isSpaceLockedError,
    )
    await expect(p.b.localDb.spaceDb(space.id).getAllExpenses()).rejects.toSatisfy(
      isSpaceLockedError,
    )
    expect(await p.b.localDb.listLocalSpaces()).toEqual([])

    await sync(p.a)
    await sync(p.b)
    await p.b.localDb.applyIncomingRecords(space.id, records)

    const onB = await p.b.localDb.spaceDb(space.id).getAllExpenses()
    expect(onB.map((e) => e.amount)).toEqual([55])
  })
})

describe('leaving the space on one device', () => {
  it('forgetLocalSpace reaches the other device with the next personal sync', async () => {
    const p = await newPair()
    const space = await p.a.localDb.createLocalSpace({ name: 'Flat', lang: 'en' })
    at(T1)
    await sync(p.a)
    await sync(p.b)
    expect((await p.b.localDb.listLocalSpaces()).map((s) => s.id)).toEqual([space.id])

    at(T2)
    await p.a.localDb.forgetLocalSpace(space.id)
    await sync(p.a)
    await sync(p.b)

    expect(await p.a.localDb.listLocalSpaces()).toEqual([])
    expect(await p.b.localDb.listLocalSpaces()).toEqual([])
    await expect(p.b.localDb.spaceDb(space.id).getAllExpenses()).rejects.toSatisfy(
      isSpaceLockedError,
    )
  })
})

describe('a device with no Family space', () => {
  it('keeps syncing its personal data exactly as before', async () => {
    const p = await newPair()
    const category = await p.a.localDb.addCategory({ name: 'Marker Groceries' })
    await p.a.localDb.addExpense({
      amount: 321,
      currency: 'UAH',
      categoryId: category.id,
      description: 'personal only',
      createdAt: CREATED,
    })
    at(T1)

    await sync(p.a)
    await sync(p.b)

    expect((await p.b.localDb.getAllExpenses()).map((e) => e.amount)).toEqual([321])
    const types = (await p.b.localDb.listChangedRecords(-1)).records.map((r) => r.type)
    expect(types).not.toContain('spaceKey')
    expect(types).not.toContain('identity')
    expect(await p.b.localDb.listLocalSpaces()).toEqual([])
  })
})
