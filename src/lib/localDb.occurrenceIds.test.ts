// No CONTRACT_GAPs: the deterministic ids of generated records (plan §3, §5),
// the raw duplicate check that treats a tombstoned occurrence as handled, and
// occurrenceRecordId itself are fully specified in the Interface Contract.
//
// Integration style (as localDb.recurring.test.ts): real crypto and real
// localDb, idb-keyval backed by a Map. "Two separate stores" are two fresh
// stores with two different keys.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Expense, IncomeEntry, RecurringItem } from '@/lib/domain'
import { decryptValue, encryptValue } from '@/lib/crypto'
import {
  addRecurring,
  addRepeatingExpense,
  addRepeatingIncome,
  applyIncomingRecords,
  confirmRecurringOccurrence,
  deleteExpense,
  deleteIncome,
  deleteRecurring,
  expenseChunkKey,
  getAllExpenses,
  getAllIncome,
  listChangedRecords,
  processDueRecurring,
  unlockLocalDb,
} from '@/lib/localDb'
import { occurrenceRecordId } from '@/lib/occurrenceId'
import { occurrenceCreatedAt } from '@/lib/recurrence'

const { mockStore } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: (key: string, value: unknown) => {
    mockStore.set(key, value)
    return Promise.resolve()
  },
  setMany: (entries: Array<[string, unknown]>) => {
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

// Local 10:00 on 2026-05-15: the local date is 2026-05-15 in every timezone.
const NOW = new Date(2026, 4, 15, 10, 0, 0)
const OLD = '2026-01-05T08:00:00.000Z'
const TODAY = '2026-05-15'
const DATES = ['2026-03-15', '2026-04-15', '2026-05-15']

let dek: CryptoKey

async function newDevice() {
  mockStore.clear()
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
}

async function seed(storageKey: string, value: unknown) {
  mockStore.set(storageKey, await encryptValue(dek, value))
}

async function readRaw<T>(storageKey: string): Promise<Array<T>> {
  const raw = mockStore.get(storageKey)
  if (!(raw instanceof Uint8Array)) throw new Error(`nothing under ${storageKey}`)
  return (await decryptValue(dek, raw)) as Array<T>
}

function makeItem(overrides: Partial<RecurringItem> = {}): RecurringItem {
  return {
    id: 'r1',
    kind: 'expense',
    amount: 100,
    currency: 'UAH',
    categoryId: 'cat1',
    description: 'Gym',
    frequency: { unit: 'month', interval: 1 },
    startDate: '2026-03-15',
    end: { type: 'never' },
    mode: 'auto',
    paused: false,
    handledThrough: null,
    handledAhead: [],
    occurrenceCount: 0,
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  }
}

async function seedBasics(item: RecurringItem) {
  await seed('categories', [{ id: 'cat1', name: 'Gym', icon: null, updatedAt: OLD }])
  await seed('incomeCategories', [{ id: 'ic1', name: 'Salary', icon: null, updatedAt: OLD }])
  await seed('recurring', [item])
}

// The expense ids by occurrence date, read from the stored chunks.
async function expenseIdsByDate(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const chunkKeys = Array.from(mockStore.keys()).filter((k) => k.startsWith('expenses_'))
  for (const key of chunkKeys) {
    for (const e of await readRaw<Expense>(key)) {
      if (e.occurrenceDate !== undefined) out.set(e.occurrenceDate, e.id)
    }
  }
  return out
}

function need(value: string | undefined): string {
  if (value === undefined) throw new Error('expected a value')
  return value
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  await newDevice()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('generated records get the deterministic occurrence id', () => {
  it('processDueRecurring: each expense id is occurrenceRecordId(item id, occurrence date)', async () => {
    await seedBasics(makeItem())

    await processDueRecurring(TODAY)

    const ids = await expenseIdsByDate()
    expect([...ids.keys()].sort()).toEqual(DATES)
    for (const date of DATES) {
      expect(ids.get(date)).toBe(await occurrenceRecordId('r1', date))
    }
    expect(new Set(ids.values()).size).toBe(3)
  })

  it('income records too', async () => {
    await seedBasics(makeItem({ kind: 'income', categoryId: 'ic1' }))

    await processDueRecurring(TODAY)

    const income = await readRaw<IncomeEntry>('income')
    expect(income.map((i) => i.occurrenceDate)).toEqual(DATES)
    for (const entry of income) {
      expect(entry.id).toBe(await occurrenceRecordId('r1', need(entry.occurrenceDate)))
      expect(entry.recurringId).toBe('r1')
    }
  })

  it('the id depends on the item and on the date', async () => {
    await seedBasics(makeItem({ id: 'item-a' }))
    await processDueRecurring(TODAY)
    const first = await expenseIdsByDate()

    await newDevice()
    await seedBasics(makeItem({ id: 'item-b' }))
    await processDueRecurring(TODAY)
    const second = await expenseIdsByDate()

    for (const date of DATES) expect(second.get(date)).not.toBe(first.get(date))
    expect(second.get('2026-04-15')).toBe(await occurrenceRecordId('item-b', '2026-04-15'))
  })

  it('two separate stores generating the same occurrences produce the same ids', async () => {
    await seedBasics(makeItem())
    await processDueRecurring(TODAY)
    const deviceA = await expenseIdsByDate()

    await newDevice()
    await seedBasics(makeItem())
    await processDueRecurring(TODAY)
    const deviceB = await expenseIdsByDate()

    expect(deviceA.size).toBe(3)
    expect([...deviceB.entries()]).toEqual([...deviceA.entries()])
  })

  it('addRecurring with createThroughToday uses the id of the new item', async () => {
    await seed('categories', [{ id: 'cat1', name: 'Gym', icon: null, updatedAt: OLD }])

    const item = await addRecurring(
      {
        kind: 'expense',
        amount: 5,
        currency: 'UAH',
        categoryId: 'cat1',
        frequency: { unit: 'month', interval: 1 },
        startDate: '2026-03-15',
        end: { type: 'never' },
        mode: 'auto',
      },
      { createThroughToday: true, today: TODAY },
    )

    const ids = await expenseIdsByDate()
    expect(ids.size).toBe(3)
    for (const date of DATES) {
      expect(ids.get(date)).toBe(await occurrenceRecordId(item.id, date))
    }
  })

  it('confirmRecurringOccurrence: the record id is occurrenceRecordId(item id, date), for expense and income items', async () => {
    await seedBasics(makeItem({ mode: 'ask' }))
    await confirmRecurringOccurrence('r1', '2026-03-15')
    expect((await expenseIdsByDate()).get('2026-03-15')).toBe(
      await occurrenceRecordId('r1', '2026-03-15'),
    )

    await newDevice()
    await seedBasics(makeItem({ id: 'inc', kind: 'income', categoryId: 'ic1', mode: 'ask' }))
    await confirmRecurringOccurrence('inc', '2026-03-15')
    const [entry] = await readRaw<IncomeEntry>('income')
    expect(entry.id).toBe(await occurrenceRecordId('inc', '2026-03-15'))
  })

  it("addRepeatingExpense: today's record has the id of its recurring item and today's date", async () => {
    const created = await addRepeatingExpense(
      { amount: 30, currency: 'UAH', categoryId: 'cat1' },
      'month',
    )

    expect(created.occurrenceDate).toBe(TODAY)
    expect(created.id).toBe(
      await occurrenceRecordId(need(created.recurringId), need(created.occurrenceDate)),
    )
  })

  it("addRepeatingIncome: today's record has the id of its recurring item and today's date", async () => {
    const created = await addRepeatingIncome(
      { categoryId: 'ic1', amount: 30, currency: 'UAH' },
      'week',
    )

    expect(created.occurrenceDate).toBe(TODAY)
    expect(created.id).toBe(
      await occurrenceRecordId(need(created.recurringId), need(created.occurrenceDate)),
    )
  })

  it('two Quick Add repeats get different record ids (their recurring ids differ)', async () => {
    const a = await addRepeatingExpense({ amount: 1, currency: 'UAH', categoryId: 'cat1' }, 'month')
    const b = await addRepeatingExpense({ amount: 1, currency: 'UAH', categoryId: 'cat1' }, 'month')

    expect(a.id).not.toBe(b.id)
  })

  it('a generated record still carries recurringId, occurrenceDate and the createdAt of its date', async () => {
    await seedBasics(makeItem({ startDate: TODAY }))
    await processDueRecurring(TODAY)
    const [generated] = await getAllExpenses()

    expect(generated.id).toBe(await occurrenceRecordId('r1', TODAY))
    expect(generated.recurringId).toBe('r1')
    expect(generated.occurrenceDate).toBe(TODAY)
    expect(generated.createdAt).toBe(occurrenceCreatedAt(TODAY))
  })

  it('the two devices fold into one record per occurrence when their data meets', async () => {
    await seedBasics(makeItem())
    await processDueRecurring(TODAY)
    const fromA = (await listChangedRecords(-1)).records.filter((r) => r.type === 'expense')
    expect(fromA).toHaveLength(3)

    await newDevice()
    await seedBasics(makeItem())
    await processDueRecurring(TODAY)
    const result = await applyIncomingRecords(fromA)

    expect(await getAllExpenses()).toHaveLength(3)
    expect(result.applied + result.kept).toBe(3)
    expect(result.conflicts).toBe(0)
  })
})

describe('existing generated records keep their ids', () => {
  it('a record with a random id and the same recurringId + occurrenceDate is not duplicated or renamed', async () => {
    await seedBasics(makeItem())
    const existing: Expense = {
      id: 'random-old-id',
      amount: 77,
      currency: 'UAH',
      categoryId: 'cat1',
      description: 'made before ids were deterministic',
      createdAt: occurrenceCreatedAt('2026-04-15'),
      updatedAt: OLD,
      recurringId: 'r1',
      occurrenceDate: '2026-04-15',
    }
    await seed(expenseChunkKey(existing.createdAt), [existing])

    const result = await processDueRecurring(TODAY)

    expect(result.created).toBe(2)
    const ids = await expenseIdsByDate()
    expect(ids.get('2026-04-15')).toBe('random-old-id')
    expect(ids.get('2026-03-15')).toBe(await occurrenceRecordId('r1', '2026-03-15'))
    expect(ids.get('2026-05-15')).toBe(await occurrenceRecordId('r1', '2026-05-15'))
  })

  it('a record that already has the computed id is not created again, even without the pair', async () => {
    await seedBasics(makeItem())
    const id = await occurrenceRecordId('r1', '2026-04-15')
    const bare: Expense = {
      id,
      amount: 5,
      currency: 'UAH',
      categoryId: 'cat1',
      createdAt: occurrenceCreatedAt('2026-04-15'),
      updatedAt: OLD,
    }
    await seed(expenseChunkKey(bare.createdAt), [bare])

    const result = await processDueRecurring(TODAY)

    expect(result.created).toBe(2)
    const april = await readRaw<Expense>(expenseChunkKey(bare.createdAt))
    expect(april.filter((e) => e.id === id)).toHaveLength(1)
    expect(april).toHaveLength(1)
    expect(april[0]).toEqual(bare)
  })
})

describe('a tombstoned occurrence is handled and is never regenerated', () => {
  async function regressProgress() {
    // As after restoring an older copy of the item only: nothing handled yet.
    await seed('recurring', [makeItem()])
  }

  it('processDueRecurring does not bring a deleted generated expense back', async () => {
    await seedBasics(makeItem())
    await processDueRecurring(TODAY)
    const ids = await expenseIdsByDate()
    const april = need(ids.get('2026-04-15'))
    await deleteExpense(april, occurrenceCreatedAt('2026-04-15'))
    await regressProgress()

    const result = await processDueRecurring(TODAY)

    expect(result.created).toBe(0)
    const live = await getAllExpenses()
    expect(live.map((e) => e.occurrenceDate).sort()).toEqual(['2026-03-15', '2026-05-15'])
    const raw = await readRaw<Expense>(expenseChunkKey(occurrenceCreatedAt('2026-04-15')))
    expect(raw).toHaveLength(1)
    expect(raw[0].id).toBe(april)
    expect(raw[0].deletedAt).toBeDefined()
  })

  it('the item still catches up its progress', async () => {
    await seedBasics(makeItem())
    await processDueRecurring(TODAY)
    const ids = await expenseIdsByDate()
    await deleteExpense(need(ids.get('2026-05-15')), occurrenceCreatedAt('2026-05-15'))
    await regressProgress()

    await processDueRecurring(TODAY)

    const [item] = await readRaw<RecurringItem>('recurring')
    expect(item.handledThrough).toBe(TODAY)
    expect(await getAllExpenses()).toHaveLength(2)
  })

  it('works for income records', async () => {
    await seedBasics(makeItem({ kind: 'income', categoryId: 'ic1' }))
    await processDueRecurring(TODAY)
    const [first] = await readRaw<IncomeEntry>('income')
    await deleteIncome(first.id)
    await seed('recurring', [makeItem({ kind: 'income', categoryId: 'ic1' })])

    const result = await processDueRecurring(TODAY)

    expect(result.created).toBe(0)
    expect(await getAllIncome()).toHaveLength(2)
    expect(await readRaw<IncomeEntry>('income')).toHaveLength(3)
  })

  it('a deleted occurrence is also skipped when the same item is confirmed again', async () => {
    await seedBasics(makeItem({ mode: 'ask' }))
    await confirmRecurringOccurrence('r1', '2026-03-15')
    const id = need((await expenseIdsByDate()).get('2026-03-15'))
    await deleteExpense(id, occurrenceCreatedAt('2026-03-15'))
    await seed('recurring', [makeItem({ mode: 'ask' })])

    await confirmRecurringOccurrence('r1', '2026-03-15')

    expect(await getAllExpenses()).toEqual([])
    const [item] = await readRaw<RecurringItem>('recurring')
    expect(item.handledThrough).toBe('2026-03-15')
    const raw = await readRaw<Expense>(expenseChunkKey(occurrenceCreatedAt('2026-03-15')))
    expect(raw).toHaveLength(1)
  })

  it('a live record is still not duplicated either', async () => {
    await seedBasics(makeItem())
    await processDueRecurring(TODAY)
    await regressProgress()

    const result = await processDueRecurring(TODAY)

    expect(result.created).toBe(0)
    expect(await getAllExpenses()).toHaveLength(3)
  })

  it('a deleted recurring item generates nothing, its old records stay', async () => {
    await seedBasics(makeItem())
    await processDueRecurring('2026-04-20')
    await deleteRecurring('r1')

    const result = await processDueRecurring(TODAY)

    expect(result).toEqual({ created: 0, itemsTouched: 0 })
    expect(await getAllExpenses()).toHaveLength(2)
  })
})
