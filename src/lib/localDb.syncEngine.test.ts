// CONTRACT_GAP: the exact value of RekeyResult.records (whether the settings
//   record counts) is not fixed by the plan; only "localRev - startRev ===
//   records" (one fresh rev per kept record) is asserted.
// CONTRACT_GAP: the order in which dedupeOccurrences / rekeyLiveData stamp revs
//   is not specified; only that the revs are distinct and above startRev.
//
// Integration style as localDb.rev.test.ts: real crypto, real vault and
// localDb, idb-keyval backed by a Map with a switch that makes setMany reject.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncRecord } from '@/lib/syncRecords'
import { createBackup, restoreBackup, serializeBackup } from '@/lib/backup'
import { decryptValue } from '@/lib/crypto'
import {
  SYNC_META_KEY,
  addCategory,
  addExpense,
  addIncome,
  applyIncomingRecords,
  compactTombstones,
  dedupeOccurrences,
  deleteExpense,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getLocalDbKey,
  getLocalRev,
  listChangedRecords,
  notifyLocalChange,
  onLocalChange,
  rekeyLiveData,
} from '@/lib/localDb'
import { occurrenceRecordId } from '@/lib/occurrenceId'
import { createVault, lockVault } from '@/lib/vault'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: { failSetMany: false },
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: (key: string, value: unknown) => {
    mockStore.set(key, value)
    return Promise.resolve()
  },
  setMany: (entries: Array<[string, unknown]>) => {
    if (ctl.failSetMany) return Promise.reject(new Error('transaction aborted'))
    for (const [key, value] of entries) mockStore.set(key, value)
    return Promise.resolve()
  },
  del: (key: string) => {
    mockStore.delete(key)
    return Promise.resolve()
  },
  clear: () => {
    mockStore.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(mockStore.keys())),
}))

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const PW = 'correct horse battery'
const T0 = '2026-10-10T10:00:00.000Z'
const T1 = '2026-10-11T10:00:00.000Z'
const OLD = '2026-01-05T08:00:00.000Z'
const LATER = '2026-08-01T08:00:00.000Z'

function setNow(iso: string) {
  vi.setSystemTime(new Date(iso))
}

// Listeners live in the module, so every test removes the ones it added.
const unsubscribers: Array<() => void> = []

function listen(listener: () => void): () => void {
  const off = onLocalChange(listener)
  unsubscribers.push(off)
  return off
}

function expenseRecord(
  id: string,
  data: Record<string, unknown> = {},
  updatedAt = T0,
): SyncRecord {
  return {
    type: 'expense',
    id,
    updatedAt,
    data: {
      id,
      amount: 100,
      currency: 'UAH',
      categoryId: 'c1',
      description: 'coffee',
      createdAt: '2026-10-10T09:00:00.000Z',
      updatedAt,
      ...data,
    },
  }
}

function occurrence(
  id: string,
  recurringId: string,
  occurrenceDate: string,
  createdAt = '2026-10-10T09:00:00.000Z',
): SyncRecord {
  return expenseRecord(id, { recurringId, occurrenceDate, createdAt })
}

function dump(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of mockStore) {
    out[k] = v instanceof Uint8Array ? Array.from(v) : JSON.parse(JSON.stringify(v))
  }
  return out
}

async function liveExpenseIds(): Promise<Array<string>> {
  return (await getAllExpenses()).map((e) => e.id).sort()
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  setNow(T0)
  mockStore.clear()
  localStorage.clear()
  ctl.failSetMany = false
  lockVault()
  await createVault(PW)
})

afterEach(() => {
  for (const off of unsubscribers.splice(0)) off()
  vi.useRealTimers()
  vi.restoreAllMocks()
  lockVault()
})

describe('applyIncomingRecords with preferIncomingOnTie', () => {
  it('without the option a same-time conflict is decided by the run 1 rule (the larger content wins)', async () => {
    await applyIncomingRecords([expenseRecord('e1', { amount: 500 })])
    const result = await applyIncomingRecords([expenseRecord('e1', { amount: 100 })])

    expect(result).toMatchObject({ applied: 0, kept: 1, conflicts: 1 })
    expect((await getAllExpenses())[0].amount).toBe(500)
  })

  it('with the option the incoming record wins the same-time conflict and is still counted', async () => {
    await applyIncomingRecords([expenseRecord('e1', { amount: 500 })])
    const result = await applyIncomingRecords(
      [expenseRecord('e1', { amount: 100 })],
      { preferIncomingOnTie: true },
    )

    expect(result).toMatchObject({ applied: 1, conflicts: 1 })
    expect((await getAllExpenses())[0].amount).toBe(100)
  })

  it('the option changes nothing when the incoming record would win anyway', async () => {
    await applyIncomingRecords([expenseRecord('e1', { amount: 100 })])
    const result = await applyIncomingRecords(
      [expenseRecord('e1', { amount: 500 })],
      { preferIncomingOnTie: true },
    )
    expect(result).toMatchObject({ applied: 1, conflicts: 1 })
    expect((await getAllExpenses())[0].amount).toBe(500)
  })

  it('equal time and identical content stays with the local record', async () => {
    await applyIncomingRecords([expenseRecord('e1')])
    const result = await applyIncomingRecords([expenseRecord('e1')], { preferIncomingOnTie: true })
    expect(result).toEqual({ applied: 0, kept: 1, conflicts: 0 })
  })

  it('an older incoming record still loses with the option', async () => {
    await applyIncomingRecords([expenseRecord('e1', { amount: 500 }, T1)])
    const result = await applyIncomingRecords(
      [expenseRecord('e1', { amount: 100 }, T0)],
      { preferIncomingOnTie: true },
    )
    expect(result).toMatchObject({ applied: 0, kept: 1, conflicts: 0 })
    expect((await getAllExpenses())[0].amount).toBe(500)
  })

  it('a newer incoming record wins as before', async () => {
    await applyIncomingRecords([expenseRecord('e1', { amount: 500 }, T0)])
    const result = await applyIncomingRecords([expenseRecord('e1', { amount: 100 }, T1)])
    expect(result.applied).toBe(1)
    expect((await getAllExpenses())[0].amount).toBe(100)
  })

  it('does not stamp a rev or bump localRev', async () => {
    await applyIncomingRecords([expenseRecord('e1', { amount: 500 })])
    await applyIncomingRecords([expenseRecord('e1', { amount: 100 })], { preferIncomingOnTie: true })
    expect(await getLocalRev()).toBe(0)
  })
})

describe('compactTombstones with maxRev', () => {
  async function twoTombstones() {
    setNow(OLD)
    const a = await addExpense({ amount: 100, currency: 'UAH', categoryId: 'c1', createdAt: OLD })
    const b = await addExpense({ amount: 200, currency: 'UAH', categoryId: 'c1', createdAt: OLD })
    await deleteExpense(a.id, a.createdAt)
    await deleteExpense(b.id, b.createdAt)
    setNow(LATER)
    return { a, b }
  }

  async function tombstoneIds(): Promise<Array<string>> {
    const { records } = await listChangedRecords(-1)
    return records.filter((r) => r.deletedAt).map((r) => r.id)
  }

  it('removes only the tombstones whose rev is at or below maxRev', async () => {
    const { a, b } = await twoTombstones()
    // add a, add b, delete a (rev 3), delete b (rev 4)
    const removed = await compactTombstones('2026-06-01T00:00:00.000Z', { maxRev: 3 })

    expect(removed).toBe(1)
    expect(await tombstoneIds()).toEqual([b.id])
    expect(await tombstoneIds()).not.toContain(a.id)
  })

  it('a higher maxRev removes both', async () => {
    await twoTombstones()
    expect(await compactTombstones('2026-06-01T00:00:00.000Z', { maxRev: 4 })).toBe(2)
    expect(await tombstoneIds()).toEqual([])
  })

  it('a lower maxRev removes none', async () => {
    await twoTombstones()
    expect(await compactTombstones('2026-06-01T00:00:00.000Z', { maxRev: 2 })).toBe(0)
    expect(await tombstoneIds()).toHaveLength(2)
  })

  it('without maxRev nothing changes: every old tombstone goes', async () => {
    await twoTombstones()
    expect(await compactTombstones('2026-06-01T00:00:00.000Z')).toBe(2)
  })

  it('still keeps tombstones that are not old enough, whatever maxRev says', async () => {
    await twoTombstones()
    expect(await compactTombstones('2026-01-01T00:00:00.000Z', { maxRev: 100 })).toBe(0)
  })
})

describe('dedupeOccurrences', () => {
  const RID = 'recurring-1'
  const DATE = '2026-10-10'

  it('keeps the record whose id is the deterministic occurrence id and tombstones the other', async () => {
    const canonical = await occurrenceRecordId(RID, DATE)
    // A rival that always sorts before the canonical id, so the smallest-id
    // rule alone would keep the wrong record.
    const rival = '!-smaller-than-any-uuid'
    expect(rival < canonical).toBe(true)
    await applyIncomingRecords([
      occurrence(rival, RID, DATE),
      occurrence(canonical, RID, DATE),
    ])
    expect(await liveExpenseIds()).toHaveLength(2)

    const removed = await dedupeOccurrences([RID])

    expect(removed).toBe(1)
    expect(await liveExpenseIds()).toEqual([canonical])
  })

  it('keeps the smallest id when none is the deterministic one', async () => {
    await applyIncomingRecords([
      occurrence('zzz', RID, DATE),
      occurrence('bbb', RID, DATE),
      occurrence('mmm', RID, DATE),
    ])
    expect(await dedupeOccurrences([RID])).toBe(2)
    expect(await liveExpenseIds()).toEqual(['bbb'])
  })

  it('writes the tombstone as a user write: deletedAt, updatedAt and a fresh rev that syncs', async () => {
    await applyIncomingRecords([occurrence('zzz', RID, DATE), occurrence('bbb', RID, DATE)])
    expect(await getLocalRev()).toBe(0)
    setNow(T1)
    await dedupeOccurrences([RID])

    expect(await getLocalRev()).toBe(1)
    const { records } = await listChangedRecords(0)
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe('zzz')
    expect(records[0].deletedAt).toBe(T1)
    expect(records[0].updatedAt).toBe(T1)
  })

  it('does not touch another occurrence date or another recurring item', async () => {
    await applyIncomingRecords([
      occurrence('a1', RID, '2026-10-10'),
      occurrence('a2', RID, '2026-10-11'),
      occurrence('b1', 'other', '2026-10-10'),
      occurrence('b2', 'other', '2026-10-10'),
    ])
    expect(await dedupeOccurrences([RID])).toBe(0)
    expect(await liveExpenseIds()).toEqual(['a1', 'a2', 'b1', 'b2'])
    expect(await dedupeOccurrences(['other'])).toBe(1)
    expect(await liveExpenseIds()).toEqual(['a1', 'a2', 'b1'])
  })

  it('finds duplicates that sit in different month chunks', async () => {
    await applyIncomingRecords([
      occurrence('x1', RID, DATE, '2026-10-10T09:00:00.000Z'),
      occurrence('x2', RID, DATE, '2026-09-30T09:00:00.000Z'),
    ])
    expect(await dedupeOccurrences([RID])).toBe(1)
    expect(await liveExpenseIds()).toEqual(['x1'])
  })

  it('also dedupes income', async () => {
    const income = (id: string): SyncRecord => ({
      type: 'income',
      id,
      updatedAt: T0,
      data: {
        id,
        categoryId: 'ic1',
        amount: 1000,
        currency: 'UAH',
        createdAt: '2026-10-10T09:00:00.000Z',
        updatedAt: T0,
        recurringId: RID,
        occurrenceDate: DATE,
      },
    })
    await applyIncomingRecords([income('i-z'), income('i-a')])
    expect(await dedupeOccurrences([RID])).toBe(1)
    expect((await getAllIncome()).map((i) => i.id)).toEqual(['i-a'])
  })

  it('does nothing and writes nothing for [] or when there are no duplicates', async () => {
    await applyIncomingRecords([occurrence('only', RID, DATE)])
    const before = dump()

    expect(await dedupeOccurrences([])).toBe(0)
    expect(await dedupeOccurrences([RID])).toBe(0)
    expect(dump()).toEqual(before)
    expect(await getLocalRev()).toBe(0)
  })

  it('ignores records that are already tombstones', async () => {
    await applyIncomingRecords([
      occurrence('a', RID, DATE),
      { ...occurrence('b', RID, DATE), deletedAt: T0 },
    ])
    expect(await dedupeOccurrences([RID])).toBe(0)
    expect(await liveExpenseIds()).toEqual(['a'])
  })
})

describe('rekeyLiveData', () => {
  const SYNC_PATCH = {
    enabled: true,
    userId: 'user-1',
    vaultId: 'cloud-vault',
    deviceId: 'device-1',
    pullCursor: 0,
    headerRev: 3,
    lastSyncAt: null,
    lastError: null,
    headerPending: false,
  }

  async function newKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])
  }

  async function seed() {
    const keep1 = await addExpense({ amount: 100, currency: 'UAH', categoryId: 'c1', description: 'one' })
    setNow(T1)
    const keep2 = await addExpense({ amount: 250, currency: 'UAH', categoryId: 'c1', description: 'two', createdAt: '2026-09-02T10:00:00.000Z' })
    const gone = await addExpense({ amount: 999, currency: 'UAH', categoryId: 'c1', description: 'gone' })
    await deleteExpense(gone.id, gone.createdAt)
    await addCategory({ name: 'Food' })
    await addIncome({ categoryId: 'ic1', amount: 5000, currency: 'UAH', description: 'pay' })
    return { keep1, keep2, gone }
  }

  it('re-encrypts the live records under the new key in one step and switches the key', async () => {
    const { keep1, keep2 } = await seed()
    const oldKey = getLocalDbKey()
    const key = await newKey()
    const startRev = await getLocalRev()

    const result = await rekeyLiveData(key, {
      plain: [['meta:test-plain', { hello: 'world' }]],
      syncPatch: SYNC_PATCH,
    })

    expect(getLocalDbKey()).toBe(key)
    expect(getLocalDbKey()).not.toBe(oldKey)
    expect(result.startRev).toBe(startRev)
    expect(result.records).toBeGreaterThanOrEqual(4)
    expect(result.localRev - result.startRev).toBe(result.records)
    expect(await getLocalRev()).toBe(result.localRev)

    // The data reads back with the new key, same ids, updatedAt and createdAt.
    const expenses = await getAllExpenses()
    expect(expenses.map((e) => e.id).sort()).toEqual([keep1.id, keep2.id].sort())
    const byId = new Map(expenses.map((e) => [e.id, e]))
    expect(byId.get(keep1.id)?.updatedAt).toBe(keep1.updatedAt)
    expect(byId.get(keep2.id)?.createdAt).toBe('2026-09-02T10:00:00.000Z')
    expect(byId.get(keep2.id)?.updatedAt).toBe(T1)
    expect((await getAllCategories()).some((c) => c.name === 'Food')).toBe(true)
    expect((await getAllIncome()).map((i) => i.amount)).toEqual([5000])

    // The old key no longer opens the data.
    const raw = mockStore.get('categories') as Uint8Array
    await expect(decryptValue(oldKey as CryptoKey, raw)).rejects.toBeTruthy()
    await expect(decryptValue(key, raw)).resolves.toBeTruthy()
  })

  it('drops tombstones, re-stamps every kept record above startRev and keeps meta:sync fields', async () => {
    const { gone } = await seed()
    const startRev = await getLocalRev()
    const result = await rekeyLiveData(await newKey(), { syncPatch: SYNC_PATCH })

    const { records } = await listChangedRecords(-1)
    expect(records.some((r) => r.id === gone.id)).toBe(false)
    expect(records.some((r) => r.deletedAt)).toBe(false)
    const changed = await listChangedRecords(startRev)
    expect(changed.records.length).toBe(result.records)
    expect(changed.maxRev).toBe(result.localRev)

    const meta = mockStore.get(SYNC_META_KEY) as Record<string, unknown>
    expect(meta).toMatchObject(SYNC_PATCH)
    expect(meta.localRev).toBe(result.localRev)
  })

  it('writes pushedRev = startRev when the patch enables sync', async () => {
    await seed()
    const startRev = await getLocalRev()
    await rekeyLiveData(await newKey(), { syncPatch: SYNC_PATCH })
    expect((mockStore.get(SYNC_META_KEY) as Record<string, unknown>).pushedRev).toBe(startRev)
  })

  it('writes no pushedRev when the patch does not enable sync', async () => {
    await seed()
    await rekeyLiveData(await newKey(), { syncPatch: { vaultId: 'x' } })
    const meta = mockStore.get(SYNC_META_KEY) as Record<string, unknown>
    expect(meta.vaultId).toBe('x')
    expect('pushedRev' in meta).toBe(false)
  })

  it('writes the plain entries verbatim', async () => {
    await seed()
    await rekeyLiveData(await newKey(), {
      plain: [
        ['meta:test-plain', { hello: 'world' }],
        ['meta:test-two', { n: 2 }],
      ],
    })
    expect(mockStore.get('meta:test-plain')).toEqual({ hello: 'world' })
    expect(mockStore.get('meta:test-two')).toEqual({ n: 2 })
  })

  it('moves an expense list into month chunks by createdAt and keeps an emptied chunk readable', async () => {
    const e = await addExpense({ amount: 1, currency: 'UAH', categoryId: 'c1', createdAt: '2026-03-02T10:00:00.000Z' })
    await deleteExpense(e.id, e.createdAt)
    await addExpense({ amount: 2, currency: 'UAH', categoryId: 'c1', createdAt: '2026-04-02T10:00:00.000Z' })
    const key = await newKey()
    await rekeyLiveData(key)

    expect((await getAllExpenses()).map((x) => x.amount)).toEqual([2])
    const march = mockStore.get('expenses_2026_03') as Uint8Array
    expect(await decryptValue(key, march)).toEqual([])
  })

  it('a failed commit leaves the store and the key exactly as they were', async () => {
    await seed()
    const oldKey = getLocalDbKey()
    const before = dump()
    ctl.failSetMany = true

    await expect(rekeyLiveData(await newKey(), { syncPatch: SYNC_PATCH })).rejects.toThrow()

    expect(getLocalDbKey()).toBe(oldKey)
    expect(dump()).toEqual(before)
    ctl.failSetMany = false
    expect((await getAllExpenses()).length).toBe(2)
  })

  it('unreadable local data rejects with a DecryptError and writes nothing', async () => {
    await seed()
    const before = dump()
    mockStore.set('categories', new Uint8Array(40).fill(7))
    const withCorrupt = dump()

    const err = await rekeyLiveData(await newKey()).then(
      () => null,
      (e: unknown) => e,
    )
    expect((err as Error).name).toBe('DecryptError')
    expect(dump()).toEqual(withCorrupt)
    expect(dump()).not.toEqual(before)
  })

  it('notifies local-change listeners once after the commit', async () => {
    await seed()
    const listener = vi.fn()
    listen(listener)
    await rekeyLiveData(await newKey())
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('onLocalChange / notifyLocalChange', () => {
  it('every user write notifies once, synchronously after the commit', async () => {
    const listener = vi.fn()
    listen(listener)

    const e = await addExpense({ amount: 1, currency: 'UAH', categoryId: 'c1' })
    expect(listener).toHaveBeenCalledTimes(1)
    await addCategory({ name: 'Food' })
    expect(listener).toHaveBeenCalledTimes(2)
    await deleteExpense(e.id, e.createdAt)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('a write that does nothing does not notify', async () => {
    const e = await addExpense({ amount: 1, currency: 'UAH', categoryId: 'c1' })
    await deleteExpense(e.id, e.createdAt)
    const listener = vi.fn()
    listen(listener)
    await deleteExpense(e.id, e.createdAt)
    expect(listener).not.toHaveBeenCalled()
  })

  it('applyIncomingRecords and compactTombstones never notify', async () => {
    const listener = vi.fn()
    listen(listener)
    await applyIncomingRecords([expenseRecord('e1'), { ...expenseRecord('e2'), deletedAt: OLD }])
    await compactTombstones('2026-12-01T00:00:00.000Z')
    expect(listener).not.toHaveBeenCalled()
  })

  it('a failed write does not notify', async () => {
    const listener = vi.fn()
    listen(listener)
    ctl.failSetMany = true
    await expect(addExpense({ amount: 1, currency: 'UAH', categoryId: 'c1' })).rejects.toThrow()
    expect(listener).not.toHaveBeenCalled()
  })

  it('unsubscribing stops the calls', async () => {
    const listener = vi.fn()
    const off = listen(listener)
    await addExpense({ amount: 1, currency: 'UAH', categoryId: 'c1' })
    off()
    await addExpense({ amount: 2, currency: 'UAH', categoryId: 'c1' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('notifyLocalChange calls every listener', () => {
    const a = vi.fn()
    const b = vi.fn()
    listen(a)
    listen(b)
    notifyLocalChange()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('a throwing listener is logged by name only and never fails the write', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const good = vi.fn()
    listen(() => {
      throw new TypeError('secret detail 12345')
    })
    listen(good)

    const e = await addExpense({ amount: 1, currency: 'UAH', categoryId: 'c1' })

    expect(e.id).toBeTruthy()
    expect(good).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalled()
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret detail')
  })

  it('a merge restore notifies', async () => {
    await addExpense({ amount: 1, currency: 'UAH', categoryId: 'c1', description: 'one' })
    const file = serializeBackup(await createBackup())
    // A different local database that does not have "one", so the merge writes.
    lockVault()
    mockStore.clear()
    await createVault(PW)
    setNow(T1)
    await addExpense({ amount: 2, currency: 'UAH', categoryId: 'c1', description: 'two' })
    const revBefore = await getLocalRev()
    const listener = vi.fn()
    listen(listener)

    await restoreBackup(file, PW, 'merge')

    const descriptions = (await getAllExpenses()).map((e) => e.description).sort()
    expect(descriptions).toEqual(['one', 'two'])
    expect(await getLocalRev()).toBeGreaterThan(revBefore)
    expect(listener).toHaveBeenCalled()
  })
})
