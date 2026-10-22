// CONTRACT_GAP: confirmRecurringOccurrence on an item whose category no longer
//   exists: the plan says it throws Error('Category not found') (Approach
//   section 5, ask mode) but the Interface Contract error list only names it
//   for validation too. Tested as stated in the plan, with nothing written.
// CONTRACT_GAP: confirm/skip on an unknown item id: the message is not in the
//   Interface Contract, so only "rejects" is asserted.
// CONTRACT_GAP: processDueRecurring's `created` when an occurrence already has
//   a record (idempotency skip): the contract says duplicates "count as
//   handled" for occurrenceCount but not for `created`. Tested as: `created`
//   counts only records actually written.
// CONTRACT_GAP: D2 (item whose category is gone): processDueRecurring writes
//   nothing, logs console.warn and leaves the item pending; asserted as
//   specified in the plan. The warn text is not asserted.
// CONTRACT_GAP: for the "Used by N recurring items" refusals the contract gives
//   the wording but not the order against the existing "N expenses use this
//   category" check; only items-only usage is tested.
//
// Sync-ready data run: every setMany that writes a user change also carries
// meta:sync, deleteRecurring leaves a tombstone, and the generated records get
// deterministic ids (asserted in localDb.occurrenceIds.test.ts).
//
// Integration style (as localDb.incomeCategories.test.ts): real crypto and
// real localDb, idb-keyval backed by a Map with a failure switch on setMany.
// Dates are passed to the functions explicitly ("today") so the tests do not
// depend on the clock; expected createdAt values and chunk keys are always
// derived from occurrenceCreatedAt / expenseChunkKey, so they hold in any
// timezone (the plan's verify step runs this file under TZ=Pacific/Auckland).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  CreateRecurringInput,
  Expense,
  IncomeEntry,
  RecurringItem,
} from '@/lib/domain'
import type { SyncChannel } from '@/lib/syncChannel'
import { decryptValue, encryptValue } from '@/lib/crypto'
import {
  DecryptError,
  addCategory,
  addExpense,
  addIncomeCategory,
  addRecurring,
  addRepeatingExpense,
  addRepeatingIncome,
  confirmRecurringOccurrence,
  deleteCategory,
  deleteIncomeCategory,
  deleteRecurring,
  expenseChunkKey,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getAllRecurring,
  getDueRecurring,
  prepareUnlockedVault,
  processDueRecurring,
  setRecurringPaused,
  skipRecurringOccurrence,
  unlockLocalDb,
  updateExpense,
  updateRecurring,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { occurrenceCreatedAt } from '@/lib/recurrence'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: {
    failSetMany: false,
    setManyCalls: [] as Array<Array<string>>,
    // Lock names held (by the fake navigator.locks) at each setMany call.
    heldAtSetMany: [] as Array<Array<string>>,
    held: new Set<string>(),
    requested: [] as Array<string>,
  },
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: (key: string, value: unknown) => {
    mockStore.set(key, value)
    return Promise.resolve()
  },
  // Applies all entries or none, like an IndexedDB transaction.
  setMany: (entries: Array<[string, unknown]>) => {
    ctl.setManyCalls.push(entries.map(([key]) => key))
    ctl.heldAtSetMany.push(Array.from(ctl.held))
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

// Local 10:00 on 2026-05-15: the local date is 2026-05-15 in every timezone.
const NOW = new Date(2026, 4, 15, 10, 0, 0)
const NOW_ISO = NOW.toISOString()
const LATER = new Date(2026, 4, 16, 10, 0, 0)
const TODAY = '2026-05-15'
const OLD = '2026-01-05T08:00:00.000Z'

let dek: CryptoKey

function fakeChannel() {
  return {
    postMessage: vi.fn<SyncChannel['postMessage']>(),
    addEventListener: vi.fn<SyncChannel['addEventListener']>(),
    removeEventListener: vi.fn<SyncChannel['removeEventListener']>(),
    close: vi.fn<SyncChannel['close']>(),
  }
}

function postedKeys(channel: ReturnType<typeof fakeChannel>) {
  return channel.postMessage.mock.calls.flatMap((c) => c[0].keys)
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
    startDate: '2026-02-15',
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

function makeInput(
  categoryId: string,
  overrides: Partial<CreateRecurringInput> = {},
): CreateRecurringInput {
  return {
    kind: 'expense',
    amount: 100,
    currency: 'UAH',
    categoryId,
    description: 'Gym',
    frequency: { unit: 'month', interval: 1 },
    startDate: '2026-02-15',
    end: { type: 'never' },
    mode: 'auto',
    ...overrides,
  }
}

async function seedRecurring(items: Array<RecurringItem>) {
  mockStore.set('recurring', await encryptValue(dek, items))
}

async function seedCategories(key: 'categories' | 'incomeCategories', ids: Array<string>) {
  mockStore.set(
    key,
    await encryptValue(
      dek,
      ids.map((id) => ({ id, name: `Cat ${id}`, icon: null, updatedAt: OLD })),
    ),
  )
}

async function readStored<T>(key: string): Promise<Array<T>> {
  const raw = mockStore.get(key)
  if (!(raw instanceof Uint8Array)) throw new Error(`nothing stored under ${key}`)
  return (await decryptValue(dek, raw)) as Array<T>
}

async function storedRecurring(): Promise<Array<RecurringItem>> {
  return readStored<RecurringItem>('recurring')
}

function chunkKeys(): Array<string> {
  return Array.from(mockStore.keys()).filter((k) => k.startsWith('expenses_'))
}

async function storedExpenses(): Promise<Array<Expense>> {
  const lists = await Promise.all(chunkKeys().map((k) => readStored<Expense>(k)))
  return lists.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function snapshot(): Map<string, unknown> {
  return new Map(mockStore)
}

function expectUnchanged(before: Map<string, unknown>) {
  expect(Array.from(mockStore.keys()).sort()).toEqual(Array.from(before.keys()).sort())
  for (const [key, value] of before) expect(mockStore.get(key)).toBe(value)
}

beforeEach(async () => {
  mockStore.clear()
  ctl.failSetMany = false
  ctl.setManyCalls.length = 0
  ctl.heldAtSetMany.length = 0
  ctl.held.clear()
  ctl.requested.length = 0
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  setSyncChannel(undefined)
})

describe('processDueRecurring: catch-up (acceptance 5)', () => {
  it('creates 4 records for a monthly item that started 3 months ago, in the right chunks', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])
    ctl.setManyCalls.length = 0

    const result = await processDueRecurring(TODAY)

    expect(result).toEqual({ created: 4, itemsTouched: 1 })
    const records = await storedExpenses()
    expect(records.map((r) => r.occurrenceDate)).toEqual([
      '2026-02-15',
      '2026-03-15',
      '2026-04-15',
      '2026-05-15',
    ])
    for (const record of records) {
      expect(record.recurringId).toBe('r1')
      expect(record.createdAt).toBe(occurrenceCreatedAt(record.occurrenceDate ?? ''))
      expect(record.amount).toBe(100)
      expect(record.currency).toBe('UAH')
      expect(record.categoryId).toBe(category.id)
      expect(record.description).toBe('Gym')
      expect(record.updatedAt).toBe(NOW_ISO)
      expect(typeof record.id).toBe('string')
      // The record sits in the chunk of its own createdAt.
      const stored = await readStored<Expense>(expenseChunkKey(record.createdAt))
      expect(stored.map((e) => e.id)).toContain(record.id)
    }
    expect(new Set(records.map((r) => r.id)).size).toBe(4)
    const [item] = await storedRecurring()
    expect(item.handledThrough).toBe(TODAY)
    expect(item.occurrenceCount).toBe(4)
    expect(item.updatedAt).toBe(NOW_ISO)
  })

  it('writes the item, every chunk and meta:sync in ONE setMany and announces every written data key', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])
    const channel = fakeChannel()
    setSyncChannel(channel)
    ctl.setManyCalls.length = 0

    await processDueRecurring(TODAY)

    const expectedChunks = new Set(
      ['2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15'].map((d) =>
        expenseChunkKey(occurrenceCreatedAt(d)),
      ),
    )
    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual(
      ['meta:sync', 'recurring', ...expectedChunks].sort(),
    )
    expect([...new Set(postedKeys(channel))].sort()).toEqual(
      ['recurring', ...expectedChunks].sort(),
    )
  })

  it('continues after handledThrough: only the missed occurrences are created', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({
        categoryId: category.id,
        handledThrough: '2026-03-15',
        occurrenceCount: 2,
      }),
    ])

    const result = await processDueRecurring(TODAY)

    expect(result).toEqual({ created: 2, itemsTouched: 1 })
    expect((await storedExpenses()).map((r) => r.occurrenceDate)).toEqual([
      '2026-04-15',
      '2026-05-15',
    ])
    const [item] = await storedRecurring()
    expect(item.handledThrough).toBe(TODAY)
    expect(item.occurrenceCount).toBe(4)
  })

  it('month-end clamping: a Jan 31 item creates Jan 31, Feb 28, Mar 31, Apr 30', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({ categoryId: category.id, startDate: '2027-01-31' }),
    ])

    await processDueRecurring('2027-04-30')

    expect((await storedExpenses()).map((r) => r.occurrenceDate)).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
    ])
  })

  it('end.afterCount stops the schedule: a count of 2 creates 2, a rerun creates nothing', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({ categoryId: category.id, end: { type: 'afterCount', count: 2 } }),
    ])

    expect(await processDueRecurring(TODAY)).toEqual({ created: 2, itemsTouched: 1 })
    expect(await processDueRecurring('2027-01-01')).toEqual({
      created: 0,
      itemsTouched: 0,
    })
    expect(await storedExpenses()).toHaveLength(2)
  })

  it('creates income records in the income key for an income item', async () => {
    const category = await addIncomeCategory({ name: 'Salary' })
    await seedRecurring([
      makeItem({
        kind: 'income',
        categoryId: category.id,
        amount: 5000,
        currency: 'USD',
        description: null,
        startDate: '2026-03-15',
      }),
    ])

    const result = await processDueRecurring(TODAY)

    expect(result).toEqual({ created: 3, itemsTouched: 1 })
    const income = await readStored<IncomeEntry>('income')
    expect(income.map((i) => i.occurrenceDate)).toEqual([
      '2026-03-15',
      '2026-04-15',
      '2026-05-15',
    ])
    for (const entry of income) {
      expect(entry.recurringId).toBe('r1')
      expect(entry.amount).toBe(5000)
      expect(entry.currency).toBe('USD')
      expect(entry.categoryId).toBe(category.id)
      expect(entry.createdAt).toBe(occurrenceCreatedAt(entry.occurrenceDate ?? ''))
    }
    expect(chunkKeys()).toEqual([])
  })

  it('creates nothing for an item that starts in the future', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({ categoryId: category.id, startDate: '2026-06-01' }),
    ])
    const before = snapshot()

    expect(await processDueRecurring(TODAY)).toEqual({ created: 0, itemsTouched: 0 })

    expectUnchanged(before)
  })

  it('processes several items and counts the touched ones', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({ id: 'a', categoryId: category.id, startDate: '2026-04-15' }),
      makeItem({ id: 'b', categoryId: category.id, startDate: '2026-03-15' }),
      makeItem({ id: 'c', categoryId: category.id, startDate: '2026-09-01' }),
    ])

    const result = await processDueRecurring(TODAY)

    expect(result).toEqual({ created: 5, itemsTouched: 2 })
    const records = await storedExpenses()
    expect(records.filter((r) => r.recurringId === 'a')).toHaveLength(2)
    expect(records.filter((r) => r.recurringId === 'b')).toHaveLength(3)
    expect(records.filter((r) => r.recurringId === 'c')).toHaveLength(0)
  })
})

describe('processDueRecurring: idempotency and skipped items (acceptance 6)', () => {
  it('running it again creates nothing and writes nothing', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])
    await processDueRecurring(TODAY)
    const before = snapshot()
    ctl.setManyCalls.length = 0
    const channel = fakeChannel()
    setSyncChannel(channel)

    const second = await processDueRecurring(TODAY)

    expect(second).toEqual({ created: 0, itemsTouched: 0 })
    expect(ctl.setManyCalls).toHaveLength(0)
    expect(channel.postMessage).not.toHaveBeenCalled()
    expectUnchanged(before)
    expect(await storedExpenses()).toHaveLength(4)
  })

  it('a later date creates only the new occurrence', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])
    await processDueRecurring(TODAY)

    const next = await processDueRecurring('2026-06-15')

    expect(next).toEqual({ created: 1, itemsTouched: 1 })
    expect(await storedExpenses()).toHaveLength(5)
  })

  it('creates nothing for a paused item', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id, paused: true })])
    const before = snapshot()

    expect(await processDueRecurring(TODAY)).toEqual({ created: 0, itemsTouched: 0 })

    expectUnchanged(before)
  })

  it('creates nothing for an ask-mode item', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id, mode: 'ask' })])
    const before = snapshot()

    expect(await processDueRecurring(TODAY)).toEqual({ created: 0, itemsTouched: 0 })

    expectUnchanged(before)
  })

  it('only the active auto item of a mixed list is processed', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({ id: 'auto', categoryId: category.id, startDate: '2026-04-15' }),
      makeItem({ id: 'ask', categoryId: category.id, mode: 'ask' }),
      makeItem({ id: 'paused', categoryId: category.id, paused: true }),
    ])

    const result = await processDueRecurring(TODAY)

    expect(result).toEqual({ created: 2, itemsTouched: 1 })
    expect((await storedExpenses()).every((r) => r.recurringId === 'auto')).toBe(true)
  })

  it('returns zeros when nothing is stored and when the app is locked', async () => {
    expect(await processDueRecurring(TODAY)).toEqual({ created: 0, itemsTouched: 0 })

    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])
    wipeLocalDbKey()
    const before = snapshot()

    expect(await processDueRecurring(TODAY)).toEqual({ created: 0, itemsTouched: 0 })

    expectUnchanged(before)
  })

  it('an unreadable recurring blob propagates DecryptError and is not overwritten', async () => {
    const garbage = new Uint8Array(40)
    mockStore.set('recurring', garbage)

    const err = await processDueRecurring(TODAY).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DecryptError)
    expect((err as DecryptError).storageKey).toBe('recurring')
    expect(mockStore.get('recurring')).toBe(garbage)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('an unreadable expense chunk propagates DecryptError and nothing is written', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])
    const garbage = new Uint8Array(40)
    const key = expenseChunkKey(occurrenceCreatedAt('2026-03-15'))
    mockStore.set(key, garbage)
    const recurringBlob = mockStore.get('recurring')

    await expect(processDueRecurring(TODAY)).rejects.toBeInstanceOf(DecryptError)

    expect(mockStore.get(key)).toBe(garbage)
    expect(mockStore.get('recurring')).toBe(recurringBlob)
  })
})

describe('processDueRecurring: concurrency and atomicity (acceptance 7, 8, 9)', () => {
  it('two concurrent calls create each occurrence exactly once', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])

    const [a, b] = await Promise.all([
      processDueRecurring(TODAY),
      processDueRecurring(TODAY),
    ])

    expect(a.created + b.created).toBe(4)
    const records = await storedExpenses()
    expect(records).toHaveLength(4)
    expect(new Set(records.map((r) => r.occurrenceDate)).size).toBe(4)
    const [item] = await storedRecurring()
    expect(item.occurrenceCount).toBe(4)
  })

  it('three concurrent calls over two items still create each occurrence once', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({ id: 'a', categoryId: category.id }),
      makeItem({ id: 'b', categoryId: category.id, startDate: '2026-04-15' }),
    ])

    await Promise.all([
      processDueRecurring(TODAY),
      processDueRecurring(TODAY),
      processDueRecurring(TODAY),
    ])

    const records = await storedExpenses()
    expect(records).toHaveLength(6)
    expect(records.filter((r) => r.recurringId === 'a')).toHaveLength(4)
    expect(records.filter((r) => r.recurringId === 'b')).toHaveLength(2)
  })

  it('a failure inside setMany leaves the recurring key and every chunk byte-identical', async () => {
    const category = await addCategory({ name: 'Gym' })
    // An unrelated record already in one of the target chunks.
    await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: category.id,
      createdAt: occurrenceCreatedAt('2026-03-15'),
    })
    await seedRecurring([makeItem({ categoryId: category.id })])
    const before = snapshot()
    const channel = fakeChannel()
    setSyncChannel(channel)
    ctl.failSetMany = true

    await expect(processDueRecurring(TODAY)).rejects.toThrow('transaction aborted')

    expectUnchanged(before)
    expect(channel.postMessage).not.toHaveBeenCalled()
  })

  it('a retry after the failed transaction creates everything, once', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])
    ctl.failSetMany = true
    await expect(processDueRecurring(TODAY)).rejects.toThrow()
    ctl.failSetMany = false

    const result = await processDueRecurring(TODAY)

    expect(result).toEqual({ created: 4, itemsTouched: 1 })
    expect(await storedExpenses()).toHaveLength(4)
  })

  it('a pre-existing record with the same recurringId and occurrenceDate is not duplicated', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])
    const existing: Expense = {
      id: 'already-there',
      amount: 77,
      currency: 'UAH',
      categoryId: category.id,
      description: 'made by another tab',
      createdAt: occurrenceCreatedAt('2026-03-15'),
      updatedAt: OLD,
      recurringId: 'r1',
      occurrenceDate: '2026-03-15',
    }
    mockStore.set(
      expenseChunkKey(existing.createdAt),
      await encryptValue(dek, [existing]),
    )

    const result = await processDueRecurring(TODAY)

    expect(result.created).toBe(3)
    const records = await storedExpenses()
    expect(records).toHaveLength(4)
    const march = records.filter((r) => r.occurrenceDate === '2026-03-15')
    expect(march).toHaveLength(1)
    // The existing record is kept as it was.
    expect(march[0]).toEqual(existing)
    const [item] = await storedRecurring()
    expect(item.handledThrough).toBe(TODAY)
    expect(item.occurrenceCount).toBe(4)
  })

  it('a record with another recurringId on the same date does not block the occurrence', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id, startDate: '2026-05-15' })])
    const other: Expense = {
      id: 'other',
      amount: 1,
      currency: 'UAH',
      categoryId: category.id,
      createdAt: occurrenceCreatedAt('2026-05-15'),
      updatedAt: OLD,
      recurringId: 'someone-else',
      occurrenceDate: '2026-05-15',
    }
    mockStore.set(expenseChunkKey(other.createdAt), await encryptValue(dek, [other]))

    const result = await processDueRecurring(TODAY)

    expect(result.created).toBe(1)
    expect(await storedExpenses()).toHaveLength(2)
  })

  it('restoring regressed handledThrough does not duplicate records that already exist', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])
    await processDueRecurring(TODAY)
    const idsBefore = (await storedExpenses()).map((r) => r.id).sort()
    // As after restoring an older backup of the item only.
    await seedRecurring([makeItem({ categoryId: category.id, handledThrough: null })])

    const result = await processDueRecurring(TODAY)

    expect(result.created).toBe(0)
    expect((await storedExpenses()).map((r) => r.id).sort()).toEqual(idsBefore)
    const [item] = await storedRecurring()
    expect(item.handledThrough).toBe(TODAY)
  })
})

// A fake Web Locks manager: exclusive per name (FIFO), records every requested
// name and the set of names held together. writeLock.ts reads navigator.locks
// on every call, so installing it here is enough.
function installFakeLocks() {
  const tails = new Map<string, Promise<void>>()
  const fake = {
    request: async (name: string, callback: () => Promise<unknown>) => {
      const previous = tails.get(name) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => {
        release = resolve
      })
      tails.set(
        name,
        previous.then(() => current),
      )
      await previous
      ctl.requested.push(name)
      ctl.held.add(name)
      try {
        return await callback()
      } finally {
        ctl.held.delete(name)
        release()
      }
    },
  }
  Object.defineProperty(navigator, 'locks', { value: fake, configurable: true })
}

function removeFakeLocks() {
  Reflect.deleteProperty(navigator, 'locks')
}

function lastHeld(): Array<string> {
  return ctl.heldAtSetMany[ctl.heldAtSetMany.length - 1]
}

describe('write locks held around the single setMany (acceptance 8)', () => {
  beforeEach(() => {
    installFakeLocks()
  })

  afterEach(() => {
    removeFakeLocks()
  })

  const FOUR_DATES = ['2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15']
  const chunkLocks = (dates: Array<string>) =>
    Array.from(new Set(dates.map((d) => `minima:${expenseChunkKey(occurrenceCreatedAt(d))}`)))

  it('processDueRecurring (expense item) holds recurring, meta:sync and every target chunk together at setMany', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])
    ctl.setManyCalls.length = 0
    ctl.heldAtSetMany.length = 0
    ctl.requested.length = 0

    await processDueRecurring(TODAY)

    const expected = ['minima:recurring', 'minima:meta:sync', ...chunkLocks(FOUR_DATES)]
    for (const name of expected) expect(ctl.requested).toContain(name)
    expect(ctl.heldAtSetMany).toHaveLength(1)
    for (const name of expected) expect(lastHeld()).toContain(name)
    expect(ctl.held.size).toBe(0)
  })

  it('processDueRecurring (income item) holds recurring and income together at setMany', async () => {
    const category = await addIncomeCategory({ name: 'Salary' })
    await seedRecurring([
      makeItem({ kind: 'income', categoryId: category.id, startDate: '2026-04-15' }),
    ])
    ctl.heldAtSetMany.length = 0
    ctl.requested.length = 0

    await processDueRecurring(TODAY)

    expect(ctl.requested).toContain('minima:recurring')
    expect(ctl.requested).toContain('minima:income')
    expect(ctl.heldAtSetMany).toHaveLength(1)
    expect(lastHeld()).toContain('minima:recurring')
    expect(lastHeld()).toContain('minima:income')
    expect(lastHeld()).toContain('minima:meta:sync')
  })

  it('confirmRecurringOccurrence holds recurring and the target chunk together at setMany', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ mode: 'ask', categoryId: category.id })])
    ctl.heldAtSetMany.length = 0
    ctl.requested.length = 0

    await confirmRecurringOccurrence('r1', '2026-02-15')

    expect(ctl.heldAtSetMany).toHaveLength(1)
    expect(lastHeld()).toContain('minima:recurring')
    expect(lastHeld()).toContain('minima:meta:sync')
    for (const name of chunkLocks(['2026-02-15'])) expect(lastHeld()).toContain(name)
  })

  it('confirmRecurringOccurrence for an income item holds recurring and income', async () => {
    const category = await addIncomeCategory({ name: 'Salary' })
    await seedRecurring([
      makeItem({ kind: 'income', mode: 'ask', categoryId: category.id }),
    ])
    ctl.heldAtSetMany.length = 0

    await confirmRecurringOccurrence('r1', '2026-02-15')

    expect(lastHeld()).toContain('minima:recurring')
    expect(lastHeld()).toContain('minima:income')
  })

  it('addRecurring with createThroughToday holds recurring and every target chunk at setMany', async () => {
    const category = await addCategory({ name: 'Gym' })
    ctl.heldAtSetMany.length = 0
    ctl.requested.length = 0

    await addRecurring(makeInput(category.id), {
      createThroughToday: true,
      today: TODAY,
    })

    expect(ctl.heldAtSetMany).toHaveLength(1)
    expect(lastHeld()).toContain('minima:recurring')
    expect(lastHeld()).toContain('minima:meta:sync')
    for (const name of chunkLocks(FOUR_DATES)) expect(lastHeld()).toContain(name)
  })

  it('addRepeatingExpense holds recurring and the chunk of today at setMany', async () => {
    const category = await addCategory({ name: 'Streaming' })
    ctl.heldAtSetMany.length = 0

    await addRepeatingExpense(
      { amount: 30, currency: 'USD', categoryId: category.id },
      'month',
    )

    expect(ctl.heldAtSetMany).toHaveLength(1)
    expect(lastHeld()).toContain('minima:recurring')
    expect(lastHeld()).toContain('minima:meta:sync')
    for (const name of chunkLocks([TODAY])) expect(lastHeld()).toContain(name)
  })

  it('addRepeatingIncome holds recurring and income at setMany', async () => {
    const category = await addIncomeCategory({ name: 'Salary' })
    ctl.heldAtSetMany.length = 0

    await addRepeatingIncome(
      { amount: 5000, currency: 'EUR', categoryId: category.id },
      'month',
    )

    expect(ctl.heldAtSetMany).toHaveLength(1)
    expect(lastHeld()).toContain('minima:recurring')
    expect(lastHeld()).toContain('minima:income')
    expect(lastHeld()).toContain('minima:meta:sync')
  })

  it('a manual addExpense racing processDueRecurring in the same chunk loses nothing', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])

    await Promise.all([
      processDueRecurring(TODAY),
      addExpense({
        amount: 5,
        currency: 'UAH',
        categoryId: category.id,
        createdAt: occurrenceCreatedAt('2026-03-15'),
      }),
    ])

    const records = await storedExpenses()
    expect(records).toHaveLength(5)
    expect(records.filter((r) => r.recurringId === 'r1')).toHaveLength(4)
    expect(records.filter((r) => r.amount === 5)).toHaveLength(1)
    const [item] = await storedRecurring()
    expect(item.occurrenceCount).toBe(4)
  })
})

describe('processDueRecurring: item whose category is gone (D2)', () => {
  it('writes nothing for that item, warns, and still processes the other items', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({ id: 'orphan', categoryId: 'gone' }),
      makeItem({ id: 'fine', categoryId: category.id }),
    ])

    const result = await processDueRecurring(TODAY)

    expect(result).toEqual({ created: 4, itemsTouched: 1 })
    const records = await storedExpenses()
    expect(records.every((r) => r.recurringId === 'fine')).toBe(true)
    const items = await storedRecurring()
    const orphan = items.find((i) => i.id === 'orphan')
    expect(orphan?.handledThrough).toBeNull()
    expect(orphan?.occurrenceCount).toBe(0)
    expect(orphan?.updatedAt).toBe(OLD)
    expect(warn).toHaveBeenCalled()
  })

  it('an item with only a missing category leaves every byte untouched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await seedRecurring([makeItem({ categoryId: 'gone' })])
    const before = snapshot()

    expect(await processDueRecurring(TODAY)).toEqual({ created: 0, itemsTouched: 0 })

    expectUnchanged(before)
  })

  it('an item whose category was deleted counts as "category not found" too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const category = await addCategory({ name: 'Gym' })
    await deleteCategory(category.id)
    await seedRecurring([makeItem({ categoryId: category.id })])
    const before = snapshot()

    expect(await processDueRecurring(TODAY)).toEqual({ created: 0, itemsTouched: 0 })

    expectUnchanged(before)
  })

  it('after the user picks a category, the missed occurrences are caught up', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: 'gone' })])
    await processDueRecurring(TODAY)

    await updateRecurring('r1', { categoryId: category.id })
    const result = await processDueRecurring(TODAY)

    expect(result).toEqual({ created: 4, itemsTouched: 1 })
    expect((await storedExpenses()).map((r) => r.categoryId)).toEqual(
      Array(4).fill(category.id),
    )
  })

  it('an income item checks the income categories, not the expense categories', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await seedCategories('categories', ['shared'])
    await seedRecurring([makeItem({ kind: 'income', categoryId: 'shared' })])

    const result = await processDueRecurring(TODAY)

    expect(result).toEqual({ created: 0, itemsTouched: 0 })
    expect(mockStore.has('income')).toBe(false)
  })
})

describe('prepareUnlockedVault', () => {
  it('returns recurringCreated 0 for a new vault', async () => {
    const result = await prepareUnlockedVault({ isNewVault: true })

    expect(result).toEqual({ recurringCreated: 0 })
  })

  it('generates the due occurrences and returns how many were created', async () => {
    await seedCategories('categories', ['cat1'])
    await seedCategories('incomeCategories', ['ic1'])
    await seedRecurring([
      makeItem({ id: 'e', categoryId: 'cat1', startDate: '2026-04-15' }),
      makeItem({
        id: 'i',
        kind: 'income',
        categoryId: 'ic1',
        startDate: '2026-05-01',
      }),
    ])

    const result = await prepareUnlockedVault({ isNewVault: false })

    expect(result).toEqual({ recurringCreated: 3 })
    expect(await storedExpenses()).toHaveLength(2)
    expect(await readStored<IncomeEntry>('income')).toHaveLength(1)
  })

  it('a second run creates nothing', async () => {
    await seedCategories('categories', ['cat1'])
    await seedCategories('incomeCategories', ['ic1'])
    await seedRecurring([makeItem({ categoryId: 'cat1', startDate: '2026-04-15' })])
    await prepareUnlockedVault({ isNewVault: false })

    const second = await prepareUnlockedVault({ isNewVault: false })

    expect(second).toEqual({ recurringCreated: 0 })
    expect(await storedExpenses()).toHaveLength(2)
  })

  it('still provisions the income categories, and an income item with an unknown category creates nothing (D2)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await seedRecurring([
      makeItem({ kind: 'income', categoryId: 'missing', startDate: '2026-05-01' }),
    ])

    const result = await prepareUnlockedVault({ isNewVault: false })

    expect(result).toEqual({ recurringCreated: 0 })
    expect(mockStore.has('incomeCategories')).toBe(true)
    expect(await readStored<IncomeEntry>('income')).toEqual([])
  })

  it('an unreadable recurring blob propagates DecryptError and is not overwritten', async () => {
    const garbage = new Uint8Array(40)
    mockStore.set('recurring', garbage)

    await expect(prepareUnlockedVault({ isNewVault: false })).rejects.toBeInstanceOf(
      DecryptError,
    )

    expect(mockStore.get('recurring')).toBe(garbage)
  })
})

describe('ask mode (acceptance 10)', () => {
  async function seedAsk(overrides: Partial<RecurringItem> = {}) {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({ mode: 'ask', categoryId: category.id, ...overrides }),
    ])
    return category
  }

  it('getDueRecurring lists the due dates of ask-mode items, oldest first', async () => {
    await seedAsk()

    const due = await getDueRecurring('2026-04-20')

    expect(due.map((d) => d.occurrenceDate)).toEqual([
      '2026-02-15',
      '2026-03-15',
      '2026-04-15',
    ])
    expect(due.every((d) => d.item.id === 'r1')).toBe(true)
  })

  it('getDueRecurring ignores auto and paused items', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({ id: 'auto', categoryId: category.id }),
      makeItem({ id: 'paused', categoryId: category.id, mode: 'ask', paused: true }),
    ])

    expect(await getDueRecurring(TODAY)).toEqual([])
  })

  it('getDueRecurring is empty when nothing is stored', async () => {
    expect(await getDueRecurring(TODAY)).toEqual([])
  })

  it('confirming the oldest creates one record and advances handledThrough', async () => {
    const category = await seedAsk()
    ctl.setManyCalls.length = 0
    const channel = fakeChannel()
    setSyncChannel(channel)

    await confirmRecurringOccurrence('r1', '2026-02-15')

    const records = await storedExpenses()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      amount: 100,
      currency: 'UAH',
      categoryId: category.id,
      description: 'Gym',
      recurringId: 'r1',
      occurrenceDate: '2026-02-15',
      createdAt: occurrenceCreatedAt('2026-02-15'),
    })
    const [item] = await storedRecurring()
    expect(item.handledThrough).toBe('2026-02-15')
    expect(item.occurrenceCount).toBe(1)
    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual(
      ['meta:sync', 'recurring', expenseChunkKey(occurrenceCreatedAt('2026-02-15'))].sort(),
    )
    expect([...postedKeys(channel)].sort()).toEqual(
      ['recurring', expenseChunkKey(occurrenceCreatedAt('2026-02-15'))].sort(),
    )
    expect((await getDueRecurring('2026-04-20')).map((d) => d.occurrenceDate)).toEqual([
      '2026-03-15',
      '2026-04-15',
    ])
  })

  it('confirming an income item creates an income entry', async () => {
    const category = await addIncomeCategory({ name: 'Salary' })
    await seedRecurring([
      makeItem({ kind: 'income', mode: 'ask', categoryId: category.id, amount: 900 }),
    ])

    await confirmRecurringOccurrence('r1', '2026-02-15')

    const income = await readStored<IncomeEntry>('income')
    expect(income).toHaveLength(1)
    expect(income[0]).toMatchObject({
      amount: 900,
      recurringId: 'r1',
      occurrenceDate: '2026-02-15',
      categoryId: category.id,
    })
    expect(chunkKeys()).toEqual([])
  })

  it('skipping a later date first adds it to handledAhead without creating anything', async () => {
    await seedAsk()

    await skipRecurringOccurrence('r1', '2026-03-15')

    const [item] = await storedRecurring()
    expect(item.handledThrough).toBeNull()
    expect(item.handledAhead).toEqual(['2026-03-15'])
    expect(item.occurrenceCount).toBe(1)
    expect(chunkKeys()).toEqual([])
    expect((await getDueRecurring('2026-03-20')).map((d) => d.occurrenceDate)).toEqual([
      '2026-02-15',
    ])
  })

  it('skipping later and then confirming the oldest advances handledThrough past both and prunes handledAhead', async () => {
    await seedAsk()
    await skipRecurringOccurrence('r1', '2026-03-15')

    await confirmRecurringOccurrence('r1', '2026-02-15')

    const [item] = await storedRecurring()
    expect(item.handledThrough).toBe('2026-03-15')
    expect(item.handledAhead).toEqual([])
    expect(item.occurrenceCount).toBe(2)
    // Only the confirmed one became a record.
    const records = await storedExpenses()
    expect(records.map((r) => r.occurrenceDate)).toEqual(['2026-02-15'])
    expect(await getDueRecurring('2026-03-20')).toEqual([])
  })

  it('skipping the oldest advances handledThrough and creates nothing', async () => {
    await seedAsk()

    await skipRecurringOccurrence('r1', '2026-02-15')

    const [item] = await storedRecurring()
    expect(item.handledThrough).toBe('2026-02-15')
    expect(item.occurrenceCount).toBe(1)
    expect(chunkKeys()).toEqual([])
  })

  it('overrides change only that record, and the item keeps its own amount and description', async () => {
    await seedAsk()

    await confirmRecurringOccurrence('r1', '2026-02-15', {
      amount: 55.5,
      description: 'February, extra',
    })
    await confirmRecurringOccurrence('r1', '2026-03-15')

    const records = await storedExpenses()
    expect(records[0]).toMatchObject({ amount: 55.5, description: 'February, extra' })
    expect(records[1]).toMatchObject({ amount: 100, description: 'Gym' })
    const [item] = await storedRecurring()
    expect(item.amount).toBe(100)
    expect(item.description).toBe('Gym')
  })

  it('an empty description override becomes null; an amount-only override keeps the description', async () => {
    await seedAsk()

    await confirmRecurringOccurrence('r1', '2026-02-15', { description: '' })
    await confirmRecurringOccurrence('r1', '2026-03-15', { amount: 12 })

    const records = await storedExpenses()
    expect(records[0].description).toBeNull()
    expect(records[0].amount).toBe(100)
    expect(records[1].description).toBe('Gym')
    expect(records[1].amount).toBe(12)
  })

  it.each([
    ['a date that is not an occurrence', '2026-02-16'],
    ['a date before the start', '2026-01-15'],
  ])('confirm and skip reject %s with "Occurrence is not due" and write nothing', async (_n, date) => {
    await seedAsk()
    const before = snapshot()
    ctl.setManyCalls.length = 0

    await expect(confirmRecurringOccurrence('r1', date)).rejects.toThrow(
      'Occurrence is not due',
    )
    await expect(skipRecurringOccurrence('r1', date)).rejects.toThrow(
      'Occurrence is not due',
    )

    expectUnchanged(before)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('an already handled date is not due again', async () => {
    await seedAsk()
    await confirmRecurringOccurrence('r1', '2026-02-15')
    await skipRecurringOccurrence('r1', '2026-04-15')
    const before = snapshot()

    await expect(confirmRecurringOccurrence('r1', '2026-02-15')).rejects.toThrow(
      'Occurrence is not due',
    )
    await expect(skipRecurringOccurrence('r1', '2026-02-15')).rejects.toThrow(
      'Occurrence is not due',
    )
    await expect(confirmRecurringOccurrence('r1', '2026-04-15')).rejects.toThrow(
      'Occurrence is not due',
    )

    expectUnchanged(before)
    expect(await storedExpenses()).toHaveLength(1)
  })

  it('rejects an unknown item id and writes nothing', async () => {
    await seedAsk()
    const before = snapshot()

    await expect(confirmRecurringOccurrence('nope', '2026-02-15')).rejects.toThrow()
    await expect(skipRecurringOccurrence('nope', '2026-02-15')).rejects.toThrow()

    expectUnchanged(before)
  })

  it('confirm throws "Category not found" when the category is gone and writes nothing', async () => {
    await seedRecurring([makeItem({ mode: 'ask', categoryId: 'gone' })])
    const before = snapshot()

    await expect(confirmRecurringOccurrence('r1', '2026-02-15')).rejects.toThrow(
      'Category not found',
    )

    expectUnchanged(before)
  })

  it('a failure inside setMany leaves everything byte-identical', async () => {
    await seedAsk()
    const before = snapshot()
    ctl.failSetMany = true

    await expect(confirmRecurringOccurrence('r1', '2026-02-15')).rejects.toThrow(
      'transaction aborted',
    )
    await expect(skipRecurringOccurrence('r1', '2026-02-15')).rejects.toThrow(
      'transaction aborted',
    )

    expectUnchanged(before)
  })

  it('confirming a date that already has a record creates nothing new and marks it handled', async () => {
    const category = await seedAsk()
    const existing: Expense = {
      id: 'already-there',
      amount: 100,
      currency: 'UAH',
      categoryId: category.id,
      createdAt: occurrenceCreatedAt('2026-02-15'),
      updatedAt: OLD,
      recurringId: 'r1',
      occurrenceDate: '2026-02-15',
    }
    mockStore.set(
      expenseChunkKey(existing.createdAt),
      await encryptValue(dek, [existing]),
    )

    await confirmRecurringOccurrence('r1', '2026-02-15')

    expect(await storedExpenses()).toEqual([existing])
    const [item] = await storedRecurring()
    expect(item.handledThrough).toBe('2026-02-15')
  })
})

describe('getAllRecurring and addRecurring (acceptance 11)', () => {
  it('getAllRecurring returns [] when nothing is stored', async () => {
    expect(await getAllRecurring()).toEqual([])
  })

  it('createThroughToday false creates nothing and sets handledThrough to the last occurrence on or before today', async () => {
    const category = await addCategory({ name: 'Gym' })
    ctl.setManyCalls.length = 0

    const created = await addRecurring(makeInput(category.id), {
      createThroughToday: false,
      today: TODAY,
    })

    expect(created.handledThrough).toBe(TODAY)
    expect(created.occurrenceCount).toBe(4)
    expect(chunkKeys()).toEqual([])
    expect(await getAllRecurring()).toEqual([created])
  })

  it('handledThrough is the last occurrence on or before today, not today itself', async () => {
    const category = await addCategory({ name: 'Gym' })

    const monthly = await addRecurring(
      makeInput(category.id, { startDate: '2026-02-20' }),
      { createThroughToday: false, today: TODAY },
    )
    const weekly = await addRecurring(
      makeInput(category.id, {
        startDate: '2026-05-01',
        frequency: { unit: 'week', interval: 1 },
      }),
      { createThroughToday: false, today: TODAY },
    )

    expect(monthly.handledThrough).toBe('2026-04-20')
    expect(monthly.occurrenceCount).toBe(3)
    expect(weekly.handledThrough).toBe('2026-05-15')
    expect(weekly.occurrenceCount).toBe(3)
  })

  it('a start date in the future leaves handledThrough null and the count at 0', async () => {
    const category = await addCategory({ name: 'Gym' })

    const created = await addRecurring(
      makeInput(category.id, { startDate: '2026-08-01' }),
      { createThroughToday: false, today: TODAY },
    )

    expect(created.handledThrough).toBeNull()
    expect(created.occurrenceCount).toBe(0)
  })

  it('builds the full item: id, paused false, empty handledAhead, timestamps, input fields', async () => {
    const category = await addCategory({ name: 'Gym' })

    const created = await addRecurring(
      makeInput(category.id, {
        amount: 49.9,
        currency: 'EUR',
        description: undefined,
        mode: 'ask',
        end: { type: 'afterCount', count: 6 },
      }),
      { createThroughToday: false, today: TODAY },
    )

    expect(typeof created.id).toBe('string')
    expect(created.id.length).toBeGreaterThan(0)
    expect(created).toMatchObject({
      kind: 'expense',
      amount: 49.9,
      currency: 'EUR',
      categoryId: category.id,
      description: null,
      frequency: { unit: 'month', interval: 1 },
      startDate: '2026-02-15',
      end: { type: 'afterCount', count: 6 },
      mode: 'ask',
      paused: false,
      handledAhead: [],
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    })
    expect('rev' in created).toBe(false)
  })

  it('createThroughToday true in auto mode creates the occurrences in one setMany', async () => {
    const category = await addCategory({ name: 'Gym' })
    const channel = fakeChannel()
    setSyncChannel(channel)
    ctl.setManyCalls.length = 0

    const created = await addRecurring(makeInput(category.id), {
      createThroughToday: true,
      today: TODAY,
    })

    expect((await storedExpenses()).map((r) => r.occurrenceDate)).toEqual([
      '2026-02-15',
      '2026-03-15',
      '2026-04-15',
      '2026-05-15',
    ])
    expect((await storedExpenses()).every((r) => r.recurringId === created.id)).toBe(true)
    expect(created.handledThrough).toBe(TODAY)
    expect(created.occurrenceCount).toBe(4)
    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0]).toContain('recurring')
    expect(ctl.setManyCalls[0]).toContain('meta:sync')
    expect(postedKeys(channel)).toContain('recurring')
    // The next generation run finds nothing to do.
    expect(await processDueRecurring(TODAY)).toEqual({ created: 0, itemsTouched: 0 })
  })

  it('createThroughToday true in ask mode creates nothing and leaves the occurrences due', async () => {
    const category = await addCategory({ name: 'Gym' })

    const created = await addRecurring(makeInput(category.id, { mode: 'ask' }), {
      createThroughToday: true,
      today: TODAY,
    })

    expect(created.handledThrough).toBeNull()
    expect(chunkKeys()).toEqual([])
    expect((await getDueRecurring(TODAY)).map((d) => d.occurrenceDate)).toEqual([
      '2026-02-15',
      '2026-03-15',
      '2026-04-15',
      '2026-05-15',
    ])
  })

  it('an income item with createThroughToday true writes to the income key', async () => {
    const category = await addIncomeCategory({ name: 'Salary' })

    await addRecurring(
      makeInput(category.id, { kind: 'income', startDate: '2026-04-15' }),
      { createThroughToday: true, today: TODAY },
    )

    expect(await readStored<IncomeEntry>('income')).toHaveLength(2)
    expect(chunkKeys()).toEqual([])
  })

  it('rejects an unknown category and stores nothing', async () => {
    await addCategory({ name: 'Gym' })
    const before = snapshot()

    await expect(
      addRecurring(makeInput('gone'), { createThroughToday: false, today: TODAY }),
    ).rejects.toThrow('Category not found')

    expectUnchanged(before)
  })

  it('rejects a deleted category like an unknown one', async () => {
    const category = await addCategory({ name: 'Gym' })
    await deleteCategory(category.id)
    const before = snapshot()

    await expect(
      addRecurring(makeInput(category.id), { createThroughToday: false, today: TODAY }),
    ).rejects.toThrow('Category not found')

    expectUnchanged(before)
  })

  it('validates the category against the item kind', async () => {
    const expenseCategory = await addCategory({ name: 'Gym' })
    const before = snapshot()

    await expect(
      addRecurring(makeInput(expenseCategory.id, { kind: 'income' }), {
        createThroughToday: false,
        today: TODAY,
      }),
    ).rejects.toThrow('Category not found')

    expectUnchanged(before)
  })

  it('rejects an invalid amount with the schema message and stores nothing', async () => {
    const category = await addCategory({ name: 'Gym' })

    await expect(
      addRecurring(makeInput(category.id, { amount: 0 }), {
        createThroughToday: false,
        today: TODAY,
      }),
    ).rejects.toThrow('Amount must be greater than 0')
    await expect(
      addRecurring(
        makeInput(category.id, { end: { type: 'onDate', date: '2026-01-01' } }),
        { createThroughToday: false, today: TODAY },
      ),
    ).rejects.toThrow("End date can't be before the start date")

    expect(mockStore.has('recurring')).toBe(false)
  })

  it('a failed createThroughToday write stores neither the item nor the records', async () => {
    const category = await addCategory({ name: 'Gym' })
    const before = snapshot()
    ctl.failSetMany = true

    await expect(
      addRecurring(makeInput(category.id), { createThroughToday: true, today: TODAY }),
    ).rejects.toThrow('transaction aborted')

    expectUnchanged(before)
  })

  it('announces the recurring key', async () => {
    const category = await addCategory({ name: 'Gym' })
    const channel = fakeChannel()
    setSyncChannel(channel)

    await addRecurring(makeInput(category.id), {
      createThroughToday: false,
      today: TODAY,
    })

    expect(postedKeys(channel)).toContain('recurring')
  })

  it('serializes concurrent adds: all items are stored', async () => {
    const category = await addCategory({ name: 'Gym' })

    await Promise.all(
      [10, 20, 30].map((amount) =>
        addRecurring(makeInput(category.id, { amount }), {
          createThroughToday: false,
          today: TODAY,
        }),
      ),
    )

    expect((await getAllRecurring()).map((i) => i.amount).sort((a, b) => a - b)).toEqual([
      10, 20, 30,
    ])
  })
})

describe('updateRecurring (acceptance 13)', () => {
  it('changes the item, keeps the progress fields and bumps updatedAt', async () => {
    const category = await addCategory({ name: 'Gym' })
    const created = await addRecurring(makeInput(category.id), {
      createThroughToday: true,
      today: TODAY,
    })
    vi.setSystemTime(LATER)

    const updated = await updateRecurring(created.id, {
      amount: 200,
      description: 'Gym Pro',
    })

    expect(updated).toMatchObject({
      id: created.id,
      amount: 200,
      description: 'Gym Pro',
      frequency: { unit: 'month', interval: 1 },
      handledThrough: TODAY,
      handledAhead: [],
      occurrenceCount: 4,
      paused: false,
      createdAt: NOW_ISO,
      updatedAt: LATER.toISOString(),
    })
    expect(await getAllRecurring()).toEqual([updated])
  })

  it('never touches already created records', async () => {
    const category = await addCategory({ name: 'Gym' })
    const created = await addRecurring(makeInput(category.id), {
      createThroughToday: true,
      today: TODAY,
    })
    const chunksBefore = new Map(chunkKeys().map((k) => [k, mockStore.get(k)]))

    await updateRecurring(created.id, { amount: 999, categoryId: category.id })

    for (const [key, value] of chunksBefore) expect(mockStore.get(key)).toBe(value)
    expect((await storedExpenses()).every((r) => r.amount === 100)).toBe(true)
  })

  it('changes future occurrences only: a new frequency applies after handledThrough', async () => {
    const category = await addCategory({ name: 'Gym' })
    const created = await addRecurring(makeInput(category.id), {
      createThroughToday: true,
      today: TODAY,
    })

    await updateRecurring(created.id, {
      amount: 200,
      frequency: { unit: 'week', interval: 1 },
    })
    const result = await processDueRecurring('2026-05-31')

    // Weekly from 2026-02-15: 05-17, 05-24 and 05-31 come after handledThrough.
    expect(result.created).toBe(3)
    const records = await storedExpenses()
    expect(records).toHaveLength(7)
    expect(records.filter((r) => r.amount === 100)).toHaveLength(4)
    expect(
      records
        .filter((r) => r.amount === 200)
        .map((r) => r.occurrenceDate),
    ).toEqual(['2026-05-17', '2026-05-24', '2026-05-31'])
  })

  it('changing the start date keeps handledThrough', async () => {
    const category = await addCategory({ name: 'Gym' })
    const created = await addRecurring(makeInput(category.id), {
      createThroughToday: false,
      today: TODAY,
    })

    const updated = await updateRecurring(created.id, { startDate: '2026-01-15' })

    expect(updated.startDate).toBe('2026-01-15')
    expect(updated.handledThrough).toBe(TODAY)
    expect(updated.occurrenceCount).toBe(created.occurrenceCount)
  })

  it('throws "Recurring item not found: <id>" for an unknown id', async () => {
    const category = await addCategory({ name: 'Gym' })
    await addRecurring(makeInput(category.id), { createThroughToday: false, today: TODAY })

    await expect(updateRecurring('missing', { amount: 5 })).rejects.toThrow(
      'Recurring item not found: missing',
    )
  })

  it('throws "Recurring item not found" for a deleted item and writes nothing', async () => {
    const category = await addCategory({ name: 'Gym' })
    const created = await addRecurring(makeInput(category.id), {
      createThroughToday: false,
      today: TODAY,
    })
    await deleteRecurring(created.id)
    const before = snapshot()

    await expect(updateRecurring(created.id, { amount: 5 })).rejects.toThrow(
      `Recurring item not found: ${created.id}`,
    )

    expectUnchanged(before)
  })

  it('validates the merged item and stores nothing on failure', async () => {
    const category = await addCategory({ name: 'Gym' })
    const created = await addRecurring(makeInput(category.id), {
      createThroughToday: false,
      today: TODAY,
    })
    const before = snapshot()

    await expect(updateRecurring(created.id, { amount: -1 })).rejects.toThrow(
      'Amount must be greater than 0',
    )
    await expect(
      updateRecurring(created.id, { end: { type: 'onDate', date: '2026-01-01' } }),
    ).rejects.toThrow("End date can't be before the start date")
    await expect(updateRecurring(created.id, { categoryId: 'gone' })).rejects.toThrow(
      'Category not found',
    )

    expectUnchanged(before)
  })

  it('announces the recurring key', async () => {
    const category = await addCategory({ name: 'Gym' })
    const created = await addRecurring(makeInput(category.id), {
      createThroughToday: false,
      today: TODAY,
    })
    const channel = fakeChannel()
    setSyncChannel(channel)

    await updateRecurring(created.id, { amount: 1 })

    expect(postedKeys(channel)).toContain('recurring')
  })
})

describe('setRecurringPaused (D3)', () => {
  it('pausing sets paused and stops generation', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])

    const paused = await setRecurringPaused('r1', true)

    expect(paused.paused).toBe(true)
    expect((await getAllRecurring())[0].paused).toBe(true)
    expect(await processDueRecurring(TODAY)).toEqual({ created: 0, itemsTouched: 0 })
  })

  it('resuming skips the occurrences that fell inside the pause and generates from today', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({
        categoryId: category.id,
        paused: true,
        handledThrough: '2026-03-15',
        occurrenceCount: 2,
      }),
    ])

    const resumed = await setRecurringPaused('r1', false, TODAY)

    expect(resumed.paused).toBe(false)
    expect(resumed.handledThrough).toBe('2026-04-15')
    const result = await processDueRecurring(TODAY)
    expect(result.created).toBe(1)
    expect((await storedExpenses()).map((r) => r.occurrenceDate)).toEqual(['2026-05-15'])
  })

  it('resuming never moves handledThrough backwards', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({ categoryId: category.id, paused: true, handledThrough: TODAY }),
    ])

    const resumed = await setRecurringPaused('r1', false, TODAY)

    expect(resumed.handledThrough).toBe(TODAY)
  })

  it('resuming prunes handledAhead entries that are now behind handledThrough', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({
        categoryId: category.id,
        mode: 'ask',
        paused: true,
        handledThrough: '2026-03-15',
        handledAhead: ['2026-04-15'],
      }),
    ])

    const resumed = await setRecurringPaused('r1', false, TODAY)

    expect(resumed.handledThrough).toBe('2026-04-15')
    expect(resumed.handledAhead).toEqual([])
  })

  it('resuming an item that has not started yet leaves handledThrough null', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({ categoryId: category.id, paused: true, startDate: '2026-08-01' }),
    ])

    const resumed = await setRecurringPaused('r1', false, TODAY)

    expect(resumed.handledThrough).toBeNull()
  })

  it('throws "Recurring item not found: <id>" for an unknown id', async () => {
    await expect(setRecurringPaused('missing', true)).rejects.toThrow(
      'Recurring item not found: missing',
    )
  })

  it('announces the recurring key', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])
    const channel = fakeChannel()
    setSyncChannel(channel)

    await setRecurringPaused('r1', true)

    expect(postedKeys(channel)).toContain('recurring')
  })
})

describe('deleteRecurring (acceptance 13)', () => {
  it('tombstones the item and keeps the records it created as ordinary records', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({ id: 'gone', categoryId: category.id }),
      makeItem({ id: 'stays', categoryId: category.id, startDate: '2026-05-15' }),
    ])
    await processDueRecurring(TODAY)
    const recordsBefore = await storedExpenses()
    const chunkBlobs = new Map(chunkKeys().map((k) => [k, mockStore.get(k)]))

    await deleteRecurring('gone')

    expect((await getAllRecurring()).map((i) => i.id)).toEqual(['stays'])
    // The item stays in the key as a tombstone.
    const raw = await storedRecurring()
    expect(raw.map((i) => i.id).sort()).toEqual(['gone', 'stays'])
    expect(raw.find((i) => i.id === 'gone')?.deletedAt).toBe(NOW_ISO)
    expect(await storedExpenses()).toEqual(recordsBefore)
    for (const [key, value] of chunkBlobs) expect(mockStore.get(key)).toBe(value)
    // The surviving records are visible through the normal reader.
    expect(await getAllExpenses()).toHaveLength(5)
  })

  it('announces the recurring key', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])
    const channel = fakeChannel()
    setSyncChannel(channel)

    await deleteRecurring('r1')

    expect(postedKeys(channel)).toContain('recurring')
    expect(await getAllRecurring()).toEqual([])
  })

  it('a deleted item generates nothing any more', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])

    await deleteRecurring('r1')

    expect(await processDueRecurring(TODAY)).toEqual({ created: 0, itemsTouched: 0 })
    expect(chunkKeys()).toEqual([])
  })

  it('a deleted ask-mode item is no longer due', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ mode: 'ask', categoryId: category.id })])
    expect((await getDueRecurring('2026-04-20')).length).toBeGreaterThan(0)

    await deleteRecurring('r1')

    expect(await getDueRecurring('2026-04-20')).toEqual([])
  })
})

describe('category deletes are refused while a recurring item uses the category (acceptance 13)', () => {
  it('deleteCategory is refused with "Used by 1 recurring item"', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])
    const categoriesBlob = mockStore.get('categories')

    await expect(deleteCategory(category.id)).rejects.toThrow(
      'Used by 1 recurring item',
    )

    expect(mockStore.get('categories')).toBe(categoriesBlob)
    expect(await getAllCategories()).toHaveLength(1)
  })

  it('uses the plural with a count for several items', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({ id: 'a', categoryId: category.id }),
      makeItem({ id: 'b', categoryId: category.id }),
      makeItem({ id: 'c', categoryId: category.id }),
    ])

    await expect(deleteCategory(category.id)).rejects.toThrow(
      'Used by 3 recurring items',
    )
  })

  it('counts only the items of that category', async () => {
    const used = await addCategory({ name: 'Gym' })
    const other = await addCategory({ name: 'Rent' })
    await seedRecurring([
      makeItem({ id: 'a', categoryId: used.id }),
      makeItem({ id: 'b', categoryId: used.id }),
      makeItem({ id: 'c', categoryId: other.id }),
    ])

    await expect(deleteCategory(used.id)).rejects.toThrow('Used by 2 recurring items')
    await expect(deleteCategory(other.id)).rejects.toThrow('Used by 1 recurring item')
  })

  it('counts live items only: a deleted item no longer blocks', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({ id: 'live', categoryId: category.id }),
      makeItem({ id: 'dead', categoryId: category.id, deletedAt: OLD }),
    ])

    await expect(deleteCategory(category.id)).rejects.toThrow(
      'Used by 1 recurring item',
    )
  })

  it('succeeds once the items are deleted', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([makeItem({ categoryId: category.id })])
    await expect(deleteCategory(category.id)).rejects.toThrow()

    await deleteRecurring('r1')
    await deleteCategory(category.id)

    expect(await getAllCategories()).toEqual([])
  })

  it('deleteCategory ignores income items that share the id', async () => {
    await seedCategories('categories', ['shared'])
    await seedCategories('incomeCategories', ['shared'])
    await seedRecurring([makeItem({ kind: 'income', categoryId: 'shared' })])

    await deleteCategory('shared')

    expect(await getAllCategories()).toEqual([])
  })

  it('deleteIncomeCategory is refused with "Used by N recurring items"', async () => {
    const category = await addIncomeCategory({ name: 'Salary' })
    await seedRecurring([makeItem({ kind: 'income', categoryId: category.id })])
    const blob = mockStore.get('incomeCategories')

    await expect(deleteIncomeCategory(category.id)).rejects.toThrow(
      'Used by 1 recurring item',
    )

    expect(mockStore.get('incomeCategories')).toBe(blob)
  })

  it('deleteIncomeCategory uses the plural for several items', async () => {
    const category = await addIncomeCategory({ name: 'Salary' })
    await seedRecurring([
      makeItem({ id: 'a', kind: 'income', categoryId: category.id }),
      makeItem({ id: 'b', kind: 'income', categoryId: category.id }),
    ])

    await expect(deleteIncomeCategory(category.id)).rejects.toThrow(
      'Used by 2 recurring items',
    )
  })

  it('deleteIncomeCategory counts live income items only', async () => {
    const category = await addIncomeCategory({ name: 'Salary' })
    await seedRecurring([
      makeItem({ id: 'dead', kind: 'income', categoryId: category.id, deletedAt: OLD }),
    ])

    await deleteIncomeCategory(category.id)

    expect(await readStored('incomeCategories')).toHaveLength(1)
    expect((await readStored<{ deletedAt?: string }>('incomeCategories'))[0].deletedAt).toBe(
      NOW_ISO,
    )
  })

  it('deleteIncomeCategory ignores expense items that share the id', async () => {
    await seedCategories('categories', ['shared'])
    await seedCategories('incomeCategories', ['shared'])
    await seedRecurring([makeItem({ kind: 'expense', categoryId: 'shared' })])

    await deleteIncomeCategory('shared')

    expect(mockStore.has('incomeCategories')).toBe(true)
    expect(await getAllCategories()).toHaveLength(1)
    // The category stays in its key as a tombstone.
    const raw = await readStored<{ id: string; deletedAt?: string }>('incomeCategories')
    expect(raw).toHaveLength(1)
    expect(raw[0].id).toBe('shared')
    expect(raw[0].deletedAt).toBe(NOW_ISO)
  })
})

describe('Quick Add repeat (acceptance 12)', () => {
  it('addRepeatingExpense saves one expense today and an auto monthly item with handledThrough today', async () => {
    const category = await addCategory({ name: 'Streaming' })
    ctl.setManyCalls.length = 0
    const channel = fakeChannel()
    setSyncChannel(channel)

    const created = await addRepeatingExpense(
      {
        amount: 30,
        currency: 'USD',
        categoryId: category.id,
        description: 'Netflix',
      },
      'month',
    )

    expect(created).toMatchObject({
      amount: 30,
      currency: 'USD',
      categoryId: category.id,
      description: 'Netflix',
      createdAt: NOW_ISO,
      occurrenceDate: TODAY,
    })
    expect(created.category).toEqual(category)
    const records = await storedExpenses()
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(created.id)
    const [item] = await storedRecurring()
    expect(created.recurringId).toBe(item.id)
    expect(item).toMatchObject({
      kind: 'expense',
      amount: 30,
      currency: 'USD',
      categoryId: category.id,
      description: 'Netflix',
      frequency: { unit: 'month', interval: 1 },
      startDate: TODAY,
      end: { type: 'never' },
      mode: 'auto',
      paused: false,
      handledThrough: TODAY,
      handledAhead: [],
      occurrenceCount: 1,
    })
    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual(
      ['meta:sync', 'recurring', expenseChunkKey(created.createdAt)].sort(),
    )
    expect([...postedKeys(channel)].sort()).toEqual(
      ['recurring', expenseChunkKey(created.createdAt)].sort(),
    )
  })

  it('the next processDueRecurring creates nothing until next month', async () => {
    const category = await addCategory({ name: 'Streaming' })
    await addRepeatingExpense(
      { amount: 30, currency: 'USD', categoryId: category.id },
      'month',
    )

    expect(await processDueRecurring(TODAY)).toEqual({ created: 0, itemsTouched: 0 })
    expect(await processDueRecurring('2026-06-14')).toEqual({
      created: 0,
      itemsTouched: 0,
    })
    expect(await processDueRecurring('2026-06-15')).toEqual({
      created: 1,
      itemsTouched: 1,
    })
    expect(await storedExpenses()).toHaveLength(2)
  })

  it('weekly and yearly repeats use their own unit', async () => {
    const category = await addCategory({ name: 'Streaming' })

    await addRepeatingExpense(
      { amount: 1, currency: 'UAH', categoryId: category.id, description: 'w' },
      'week',
    )
    await addRepeatingExpense(
      { amount: 2, currency: 'UAH', categoryId: category.id, description: 'y' },
      'year',
    )

    const items = await storedRecurring()
    expect(items.find((i) => i.description === 'w')?.frequency).toEqual({
      unit: 'week',
      interval: 1,
    })
    expect(items.find((i) => i.description === 'y')?.frequency).toEqual({
      unit: 'year',
      interval: 1,
    })
    expect(await processDueRecurring('2026-05-21')).toEqual({ created: 0, itemsTouched: 0 })
    expect(await processDueRecurring('2026-05-22')).toEqual({ created: 1, itemsTouched: 1 })
    expect(await processDueRecurring('2027-05-15')).toMatchObject({ itemsTouched: 2 })
  })

  it('without a description the item stores null', async () => {
    const category = await addCategory({ name: 'Streaming' })

    await addRepeatingExpense(
      { amount: 5, currency: 'UAH', categoryId: category.id },
      'month',
    )

    expect((await storedRecurring())[0].description).toBeNull()
  })

  it('a failed write stores neither the record nor the item', async () => {
    const category = await addCategory({ name: 'Streaming' })
    const before = snapshot()
    ctl.failSetMany = true

    await expect(
      addRepeatingExpense(
        { amount: 5, currency: 'UAH', categoryId: category.id },
        'month',
      ),
    ).rejects.toThrow('transaction aborted')

    expectUnchanged(before)
  })

  it('addRepeatingIncome saves one income entry today and an income item', async () => {
    const category = await addIncomeCategory({ name: 'Salary' })
    ctl.setManyCalls.length = 0

    const created = await addRepeatingIncome(
      {
        amount: 5000,
        currency: 'EUR',
        categoryId: category.id,
        description: 'Paycheck',
      },
      'month',
    )

    expect(created).toMatchObject({
      amount: 5000,
      currency: 'EUR',
      categoryId: category.id,
      description: 'Paycheck',
      occurrenceDate: TODAY,
    })
    expect(created.category).toEqual(category)
    expect(await getAllIncome()).toHaveLength(1)
    const [item] = await storedRecurring()
    expect(created.recurringId).toBe(item.id)
    expect(item).toMatchObject({
      kind: 'income',
      amount: 5000,
      currency: 'EUR',
      frequency: { unit: 'month', interval: 1 },
      startDate: TODAY,
      mode: 'auto',
      handledThrough: TODAY,
      occurrenceCount: 1,
    })
    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual(['income', 'meta:sync', 'recurring'])
    expect(await processDueRecurring(TODAY)).toEqual({ created: 0, itemsTouched: 0 })
    expect(chunkKeys()).toEqual([])
  })
})

describe('updateExpense keeps the idempotency key', () => {
  it('a generated expense keeps recurringId and occurrenceDate after an edit', async () => {
    const category = await addCategory({ name: 'Gym' })
    await seedRecurring([
      makeItem({ categoryId: category.id, startDate: TODAY }),
    ])
    await processDueRecurring(TODAY)
    const [generated] = await storedExpenses()

    const updated = await updateExpense(generated.id, generated.createdAt, {
      amount: 999,
    })

    expect(updated.amount).toBe(999)
    const [stored] = await storedExpenses()
    expect(stored.recurringId).toBe('r1')
    expect(stored.occurrenceDate).toBe(TODAY)
    expect(stored.amount).toBe(999)
    // The edited record still blocks a duplicate when the item is re-processed.
    await seedRecurring([
      makeItem({ categoryId: category.id, startDate: TODAY, handledThrough: null }),
    ])
    expect((await processDueRecurring(TODAY)).created).toBe(0)
    const after = await storedExpenses()
    expect(after).toHaveLength(1)
    expect(after[0].amount).toBe(999)
  })

  it('an ordinary expense does not gain the keys', async () => {
    const category = await addCategory({ name: 'Gym' })
    const ordinary = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: category.id,
    })

    await updateExpense(ordinary.id, ordinary.createdAt, { amount: 6 })

    const [stored] = await storedExpenses()
    expect(stored.amount).toBe(6)
    expect('recurringId' in stored).toBe(false)
    expect('occurrenceDate' in stored).toBe(false)
  })
})
