// No CONTRACT_GAPs: the merge rules are specified in plan sections 3, 7 and 12
// (criteria 7, 23, 24, 31). Two or three simulated devices share one user on
// the real PGlite server; time is the fake system clock, so every edit has a
// known updatedAt.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { RateProvider, RateTable } from '@/lib/rates/types'
import type { SimDevice } from '@/test/sync/simDevice'
import type { SqlTestDb } from '@/test/sql/harness'
import { startDb } from '@/test/sql/harness'
import { cloudVaultOf, createSimDevice } from '@/test/sync/simDevice'
import { decryptSyncRecord, encryptSyncRecord } from '@/lib/cloud/recordCrypto'

vi.mock('idb-keyval', () => import('@/test/sync/memoryIdb'))
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const PW = 'convergence password'
const T0 = '2026-10-01T08:00:00.000Z'
const T1 = '2026-10-02T08:00:00.000Z'
const T2 = '2026-10-03T08:00:00.000Z'
const T3 = '2026-10-04T08:00:00.000Z'

let ctx: SqlTestDb
const devices: Array<SimDevice> = []

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(T0))
  ctx = await startDb()
}, 60_000)

afterEach(() => {
  for (const d of devices.splice(0)) d.dispose()
})

afterAll(async () => {
  vi.useRealTimers()
  await ctx.close()
})

function at(iso: string) {
  vi.setSystemTime(new Date(iso))
}

async function sync(d: SimDevice) {
  const result = await d.actions.syncNow()
  expect(result.status, d.name).toBe('synced')
  return result
}

async function settle(first: SimDevice, second: SimDevice) {
  await sync(first)
  await sync(second)
  await sync(first)
}

interface Pair {
  userId: string
  rpc: ReturnType<SqlTestDb['rpcAs']>
  a: SimDevice
  b: SimDevice
  categoryId: string
}

async function pair(): Promise<Pair> {
  at(T0)
  const userId = await ctx.createUser()
  const rpc = ctx.rpcAs(userId)
  const a = await createSimDevice({ name: 'A', rpc, userId })
  devices.push(a)
  await a.createAndUnlockVault(PW)
  const category = await a.localDb.addCategory({ name: 'Food' })
  await a.actions.turnOn()

  const b = await createSimDevice({ name: 'B', rpc, userId })
  devices.push(b)
  const cloud = await cloudVaultOf(b)
  await b.actions.restoreFromCloud(cloud, { password: PW })
  return { userId, rpc, a, b, categoryId: category.id }
}

async function oneExpense(p: Pair, createdAt = '2026-10-01T09:00:00.000Z') {
  at(T0)
  const e = await p.a.localDb.addExpense({
    amount: 100,
    currency: 'UAH',
    categoryId: p.categoryId,
    description: 'base',
    createdAt,
  })
  await settle(p.a, p.b)
  return e
}

async function amountsOf(d: SimDevice): Promise<Array<number>> {
  return (await d.localDb.getAllExpenses()).map((e) => e.amount)
}

describe('newest edit wins, in either sync order', () => {
  it.each([
    ['A syncs first', true],
    ['B syncs first', false],
  ])('%s', async (_name, aFirst) => {
    const p = await pair()
    const e = await oneExpense(p)

    at(T1)
    await p.b.localDb.updateExpense(e.id, e.createdAt, { amount: 200 })
    at(T2)
    await p.a.localDb.updateExpense(e.id, e.createdAt, { amount: 300 })

    const [first, second] = aFirst ? [p.a, p.b] : [p.b, p.a]
    await settle(first, second)

    expect(await amountsOf(p.a)).toEqual([300])
    expect(await amountsOf(p.b)).toEqual([300])
  })

  it('the older edit loses even when it reaches the server last', async () => {
    const p = await pair()
    const e = await oneExpense(p)
    at(T1)
    await p.b.localDb.updateExpense(e.id, e.createdAt, { amount: 200 })
    at(T2)
    await p.a.localDb.updateExpense(e.id, e.createdAt, { amount: 300 })

    await sync(p.a)
    await sync(p.b)

    expect(await amountsOf(p.b)).toEqual([300])
    await sync(p.a)
    expect(await amountsOf(p.a)).toEqual([300])
  })

  it('records edited on different devices are all kept', async () => {
    const p = await pair()
    const e1 = await oneExpense(p, '2026-10-01T09:00:00.000Z')
    const e2 = await oneExpense(p, '2026-10-01T10:00:00.000Z')
    at(T1)
    await p.a.localDb.updateExpense(e1.id, e1.createdAt, { amount: 111 })
    await p.b.localDb.updateExpense(e2.id, e2.createdAt, { amount: 222 })
    await settle(p.a, p.b)

    expect((await amountsOf(p.a)).sort()).toEqual([111, 222])
    expect(await p.a.snapshot()).toEqual(await p.b.snapshot())
  })
})

describe('equal timestamps', () => {
  it('both devices end with the server copy, not their own', async () => {
    const p = await pair()
    const e = await oneExpense(p)

    // The same millisecond on both devices; A (amount 200) reaches the server
    // first. The run 1 rule alone would keep B's larger 300 on B.
    at(T1)
    await p.a.localDb.updateExpense(e.id, e.createdAt, { amount: 200 })
    await p.b.localDb.updateExpense(e.id, e.createdAt, { amount: 300 })

    await sync(p.a)
    await sync(p.b)
    await sync(p.a)

    expect(await amountsOf(p.b)).toEqual([200])
    expect(await amountsOf(p.a)).toEqual([200])
  })

  it('the device that reaches the server first wins, here also the larger one', async () => {
    const p = await pair()
    const e = await oneExpense(p)
    at(T1)
    await p.a.localDb.updateExpense(e.id, e.createdAt, { amount: 200 })
    await p.b.localDb.updateExpense(e.id, e.createdAt, { amount: 300 })

    await sync(p.b)
    await sync(p.a)
    await sync(p.b)

    expect(await amountsOf(p.a)).toEqual([300])
    expect(await amountsOf(p.b)).toEqual([300])
  })
})

describe('delete against edit', () => {
  it.each([
    ['A syncs first', true],
    ['B syncs first', false],
  ])('a newer delete wins over an older edit (%s)', async (_name, aFirst) => {
    const p = await pair()
    const e = await oneExpense(p)
    at(T1)
    await p.a.localDb.updateExpense(e.id, e.createdAt, { amount: 555 })
    at(T2)
    await p.b.localDb.deleteExpense(e.id, e.createdAt)

    const [first, second] = aFirst ? [p.a, p.b] : [p.b, p.a]
    await settle(first, second)

    expect(await amountsOf(p.a)).toEqual([])
    expect(await amountsOf(p.b)).toEqual([])
  })

  it.each([
    ['A syncs first', true],
    ['B syncs first', false],
  ])('a newer edit beats an older delete (%s)', async (_name, aFirst) => {
    const p = await pair()
    const e = await oneExpense(p)
    at(T1)
    await p.b.localDb.deleteExpense(e.id, e.createdAt)
    at(T2)
    await p.a.localDb.updateExpense(e.id, e.createdAt, { amount: 777 })

    const [first, second] = aFirst ? [p.a, p.b] : [p.b, p.a]
    await settle(first, second)

    expect(await amountsOf(p.a)).toEqual([777])
    expect(await amountsOf(p.b)).toEqual([777])
  })

  it('a delete reaches a device that was offline', async () => {
    const p = await pair()
    const e = await oneExpense(p)
    at(T1)
    await p.a.localDb.deleteExpense(e.id, e.createdAt)
    await sync(p.a)
    await sync(p.b)
    expect(await amountsOf(p.b)).toEqual([])
    expect(await p.a.snapshot()).toEqual(await p.b.snapshot())
  })
})

describe('an expense moved to another month', () => {
  it('appears only in the new month on the other device', async () => {
    const p = await pair()
    const e = await oneExpense(p, '2026-10-05T09:00:00.000Z')

    at(T1)
    const moved = await p.a.localDb.updateExpense(e.id, e.createdAt, {
      createdAt: '2026-11-10T09:00:00.000Z',
    })
    await settle(p.a, p.b)

    for (const d of [p.a, p.b]) {
      expect(await d.localDb.getExpensesForRange('2026-10-01T00:00:00.000Z', '2026-10-31T23:59:59.999Z')).toEqual([])
      const november = await d.localDb.getExpensesForRange('2026-11-01T00:00:00.000Z', '2026-11-30T23:59:59.999Z')
      expect(november.map((x) => x.id)).toEqual([e.id])
      expect(november[0].createdAt).toBe(moved.createdAt)
    }
    const records = (await p.b.localDb.listChangedRecords(-1)).records.filter((r) => r.id === e.id)
    expect(records).toHaveLength(1)
  })

  it('a move on one device against a newer amount edit on the other: the newer whole record wins everywhere', async () => {
    const p = await pair()
    const e = await oneExpense(p, '2026-10-05T09:00:00.000Z')
    at(T1)
    await p.a.localDb.updateExpense(e.id, e.createdAt, { createdAt: '2026-11-10T09:00:00.000Z' })
    at(T2)
    await p.b.localDb.updateExpense(e.id, e.createdAt, { amount: 999 })
    await settle(p.a, p.b)

    expect(await p.a.snapshot()).toEqual(await p.b.snapshot())
    const all = await p.a.localDb.getAllExpenses()
    expect(all).toHaveLength(1)
    expect(all[0].amount).toBe(999)
  })
})

describe('recurring occurrences', () => {
  it('two devices generating the same occurrence offline end with exactly one live record', async () => {
    const p = await pair()
    at(T0)
    const item = await p.a.localDb.addRecurring(
      {
        kind: 'expense',
        amount: 5000,
        currency: 'UAH',
        categoryId: p.categoryId,
        description: 'rent',
        frequency: { unit: 'month', interval: 1 },
        startDate: '2026-10-01',
        end: { type: 'never' },
        mode: 'auto',
      },
      // Before the start date: no occurrence is handled yet.
      { createThroughToday: false, today: '2026-09-01' },
    )
    await settle(p.a, p.b)
    expect(await p.b.localDb.getAllRecurring()).toHaveLength(1)

    at(T1)
    await p.a.localDb.processDueRecurring('2026-10-24')
    at(T2)
    await p.b.localDb.processDueRecurring('2026-10-24')
    expect((await p.a.localDb.getAllExpenses()).length).toBeGreaterThan(0)
    await settle(p.a, p.b)

    const a = await p.a.localDb.getAllExpenses()
    const b = await p.b.localDb.getAllExpenses()
    const ofItem = (list: typeof a) => list.filter((e) => e.recurringId === item.id)
    const dates = ofItem(a).map((e) => e.occurrenceDate)
    expect(new Set(dates).size).toBe(dates.length)
    expect(ofItem(a).length).toBeGreaterThan(0)
    expect(await p.a.snapshot()).toEqual(await p.b.snapshot())
    expect(ofItem(b).map((e) => e.id).sort()).toEqual(ofItem(a).map((e) => e.id).sort())
  })

  it('legacy duplicates (same recurringId and date, random ids) are reduced to one on every device', async () => {
    const p = await pair()
    at(T1)
    const keys = await p.a.vault.getSyncKeys()
    const header = await p.a.vault.getVaultHeader()
    const legacyDevice = crypto.randomUUID()
    await p.rpc('register_device', { p_device_id: legacyDevice, p_label: 'Legacy phone' })

    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    const records = ids.map((id) => ({
      type: 'expense' as const,
      id,
      updatedAt: T1,
      data: {
        id,
        amount: 4200,
        currency: 'UAH',
        categoryId: p.categoryId,
        description: 'legacy rent',
        createdAt: '2026-10-10T09:00:00.000Z',
        updatedAt: T1,
        recurringId: 'legacy-recurring',
        occurrenceDate: '2026-10-10',
      },
    }))
    const wire = await Promise.all(records.map((r) => encryptSyncRecord(keys, r)))
    const pushed = await p.rpc('push_records', {
      p_device_id: legacyDevice,
      p_vault_id: header.vaultId,
      p_records: wire,
    })
    expect(pushed.error).toBeNull()

    at(T2)
    await settle(p.a, p.b)

    const live = (d: SimDevice) =>
      d.localDb.getAllExpenses().then((l) => l.filter((e) => e.recurringId === 'legacy-recurring'))
    const keptA = await live(p.a)
    const keptB = await live(p.b)
    expect(keptA).toHaveLength(1)
    expect(keptB).toHaveLength(1)
    expect(keptA[0].id).toBe(keptB[0].id)
    expect(keptA[0].id).toBe([...ids].sort()[0])

    // The cleanup is a user write, so it reached the server as tombstones.
    const tombstones = (await p.a.localDb.listChangedRecords(-1)).records.filter(
      (r) => r.deletedAt && ids.includes(r.id),
    )
    expect(tombstones).toHaveLength(2)
    const serverRows = await ctx.admin<{ record_key: string }>(
      'select record_key from public.sync_records where user_id = $1',
      [p.userId],
    )
    expect(serverRows.length).toBeGreaterThanOrEqual(3)
  })

  it('cleanup runs once per cycle and a second cycle finds nothing more to do', async () => {
    const p = await pair()
    at(T1)
    const keys = await p.a.vault.getSyncKeys()
    const header = await p.a.vault.getVaultHeader()
    const legacyDevice = crypto.randomUUID()
    await p.rpc('register_device', { p_device_id: legacyDevice, p_label: 'Legacy phone' })
    const ids = [crypto.randomUUID(), crypto.randomUUID()]
    const wire = await Promise.all(
      ids.map((id) =>
        encryptSyncRecord(keys, {
          type: 'expense',
          id,
          updatedAt: T1,
          data: {
            id,
            amount: 1,
            currency: 'UAH',
            categoryId: p.categoryId,
            createdAt: '2026-10-10T09:00:00.000Z',
            updatedAt: T1,
            recurringId: 'r',
            occurrenceDate: '2026-10-10',
          },
        }),
      ),
    )
    await p.rpc('push_records', { p_device_id: legacyDevice, p_vault_id: header.vaultId, p_records: wire })

    const first = await p.a.actions.syncNow()
    expect(first.deduped).toBe(1)
    const second = await p.a.actions.syncNow()
    expect(second.deduped).toBe(0)
  })
})

describe('conversion is never synced (criterion 23)', () => {
  function provider(usd: number): RateProvider {
    const table = (date: string): RateTable => ({
      base: 'UAH',
      effectiveDate: date,
      perBase: { UAH: 1, USD: usd, EUR: 45.1 },
    })
    return { id: 'nbu', getRates: (date: string) => Promise.resolve(table(date)) }
  }

  it('no conversion field leaves a device; each device converts with its own rates', async () => {
    const p = await pair()
    at(T1)
    const usd = await p.a.localDb.addExpense({
      amount: 10,
      currency: 'USD',
      categoryId: p.categoryId,
      description: 'dollars',
      createdAt: '2026-10-01T12:00:00.000Z',
    })
    await p.a.conversion.convertPending({ provider: provider(40), today: '2026-10-24' })
    const onA = (await p.a.localDb.getAllExpenses()).find((e) => e.id === usd.id)
    expect(onA?.conversion?.rate).toBeDefined()

    await settle(p.a, p.b)

    // Not on the server.
    const keys = await p.a.vault.getSyncKeys()
    const header = await p.a.vault.getVaultHeader()
    const pulled = await p.rpc('pull_records', {
      p_device_id: p.a.deviceIds.id(),
      p_vault_id: header.vaultId,
      p_since: 0,
      p_limit: 500,
    })
    const rows = (pulled.data as { records: Array<{ record_key: string; ciphertext: string; iv: string; enc_v: number }> }).records
    const decoded = await Promise.all(rows.map((r) => decryptSyncRecord(keys, r)))
    expect(decoded.length).toBeGreaterThan(0)
    expect(JSON.stringify(decoded)).not.toContain('conversion')
    expect(JSON.stringify(decoded)).not.toContain('mainAmount')

    // Not on B until B converts it itself, with its own rate.
    const onB = (await p.b.localDb.getAllExpenses()).find((e) => e.id === usd.id)
    expect(onB?.amount).toBe(10)
    expect(onB?.conversion).toBeUndefined()
    await p.b.conversion.convertPending({ provider: provider(50), today: '2026-10-24' })
    const converted = (await p.b.localDb.getAllExpenses()).find((e) => e.id === usd.id)
    expect(converted?.conversion?.mainCurrency).toBe('UAH')
    expect(converted?.conversion?.rate).not.toBe(onA?.conversion?.rate)
  })

  it('a main-currency change arrives as settings, entries are reconverted and budgets arrive converted', async () => {
    const p = await pair()
    at(T1)
    await p.a.localDb.addExpense({
      amount: 400,
      currency: 'UAH',
      categoryId: p.categoryId,
      description: 'hryvnias',
      createdAt: '2026-10-01T12:00:00.000Z',
    })
    await p.a.localDb.upsertBudget({ categoryId: p.categoryId, monthlyLimit: 4000, currency: 'UAH' })
    await settle(p.a, p.b)
    await p.b.conversion.convertPending({ provider: provider(41.5), today: '2026-10-24' })
    expect((await p.b.conversion.getConversionStatus()).pendingEntries).toBe(0)
    expect((await p.b.conversion.getConversionStatus()).mainCurrency).toBe('UAH')

    at(T2)
    await p.a.conversion.changeMainCurrency('USD', { provider: provider(41.5), today: '2026-10-24' })
    await settle(p.a, p.b)

    const settings = await p.b.localDb.readSyncedSettings()
    expect(settings.mainCurrency).toBe('USD')
    const status = await p.b.conversion.getConversionStatus()
    expect(status.mainCurrency).toBe('USD')
    expect(status.pendingEntries).toBeGreaterThan(0)

    await p.b.conversion.convertPending({ provider: provider(41.5), today: '2026-10-24' })
    expect((await p.b.conversion.getConversionStatus()).pendingEntries).toBe(0)
    const entry = (await p.b.localDb.getAllExpenses())[0]
    expect(entry.conversion?.mainCurrency).toBe('USD')

    const budgetsA = await p.a.localDb.getAllBudgets()
    const budgetsB = await p.b.localDb.getAllBudgets()
    expect(budgetsB[0].currency).toBe('USD')
    expect(budgetsB[0].monthlyLimit).toBe(budgetsA[0].monthlyLimit)
    expect(budgetsB[0].monthlyLimit).not.toBe(4000)
  })
})

describe('three devices', () => {
  it('all converge after edits on each while offline', async () => {
    const p = await pair()
    const c = await createSimDevice({ name: 'C', rpc: p.rpc, userId: p.userId })
    devices.push(c)
    await c.actions.restoreFromCloud((await cloudVaultOf(c)), { password: PW })

    at(T1)
    const ea = await p.a.localDb.addExpense({ amount: 1, currency: 'UAH', categoryId: p.categoryId, description: 'from A', createdAt: T1 })
    at(T2)
    const eb = await p.b.localDb.addExpense({ amount: 2, currency: 'UAH', categoryId: p.categoryId, description: 'from B', createdAt: T2 })
    at(T3)
    const ec = await c.localDb.addExpense({ amount: 3, currency: 'UAH', categoryId: p.categoryId, description: 'from C', createdAt: T3 })

    for (const d of [p.a, p.b, c, p.a, p.b]) await sync(d)

    const ids = (await p.a.localDb.getAllExpenses()).map((e) => e.id).sort()
    expect(ids).toEqual([ea.id, eb.id, ec.id].sort())
    expect(await p.b.snapshot()).toEqual(await p.a.snapshot())
    expect(await c.snapshot()).toEqual(await p.a.snapshot())
  })
})
