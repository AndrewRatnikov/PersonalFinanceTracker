// CONTRACT_GAP 4 (plan): a malformed record rejects the whole batch with
//   Error('applyIncomingRecords: invalid record <index>') before anything is
//   read or written. Tested as stated in the plan.
// CONTRACT_GAP 5 (plan): an applied expense keeps the local `conversion` only
//   while amount, currency and createdAt are unchanged; otherwise it is stored
//   without one (pending). Tested as stated in the plan.
// CONTRACT_GAP: the plan does not say what a "settings" record is compared with
//   when no syncedSettings record exists yet. Only the cases with a local
//   record, or with no local settings at all and a recent incoming record, are
//   tested.
//
// Integration style (as localDb.incomeCategories.test.ts): real crypto and
// real localDb, idb-keyval backed by a Map. Local records are seeded raw (so
// their updatedAt is exact) or written through the API.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  BudgetEntry,
  Category,
  EntryConversion,
  Expense,
  IncomeEntry,
  RecurringItem,
} from '@/lib/domain'
import type { SyncRecord } from '@/lib/syncRecords'
import type { SyncChannel } from '@/lib/syncChannel'
import { decryptValue, encryptValue } from '@/lib/crypto'
import {
  DecryptError,
  addExpense,
  applyIncomingRecords,
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getAllIncomeCategories,
  getAllRecurring,
  getLocalRev,
  listChangedRecords,
  onConversionNeeded,
  readSyncedSettings,
  unlockLocalDb,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: {
    setManyCalls: [] as Array<Array<string>>,
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
  setMany: (entries: Array<[string, unknown]>) => {
    ctl.setManyCalls.push(entries.map(([key]) => key))
    ctl.heldAtSetMany.push(Array.from(ctl.held))
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

const OLD = '2026-03-01T10:00:00.000Z'
const MID = '2026-03-05T10:00:00.000Z'
const NEW = '2026-03-10T10:00:00.000Z'
const NOW = '2026-03-20T10:00:00.000Z'
const MARCH = '2026-03-15T12:00:00.000Z'
const MARCH_2 = '2026-03-16T12:00:00.000Z'
const APRIL = '2026-04-10T12:00:00.000Z'
const MARCH_CHUNK = 'expenses_2026_03'
const APRIL_CHUNK = 'expenses_2026_04'

let dek: CryptoKey
let stops: Array<() => void> = []

function setNow(iso: string) {
  vi.setSystemTime(new Date(iso))
}

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

function listen() {
  const listener = vi.fn()
  stops.push(onConversionNeeded(listener))
  return listener
}

async function seed(storageKey: string, value: unknown) {
  mockStore.set(storageKey, await encryptValue(dek, value))
}

async function readRaw<T>(storageKey: string): Promise<Array<T>> {
  const raw = mockStore.get(storageKey)
  if (!(raw instanceof Uint8Array)) throw new Error(`nothing under ${storageKey}`)
  return (await decryptValue(dek, raw)) as Array<T>
}

async function readSyncedRaw(): Promise<Record<string, unknown>> {
  const raw = mockStore.get('syncedSettings')
  if (!(raw instanceof Uint8Array)) throw new Error('no syncedSettings')
  return (await decryptValue(dek, raw)) as Record<string, unknown>
}

function expenseData(
  id: string,
  createdAt: string,
  updatedAt: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    amount: 5,
    currency: 'UAH',
    categoryId: 'c1',
    description: null,
    createdAt,
    updatedAt,
    ...extra,
  }
}

function expenseRecord(
  id: string,
  createdAt: string,
  updatedAt: string,
  extra: Record<string, unknown> = {},
): SyncRecord {
  const deletedAt = typeof extra.deletedAt === 'string' ? extra.deletedAt : undefined
  return {
    type: 'expense',
    id,
    updatedAt,
    ...(deletedAt ? { deletedAt } : {}),
    data: expenseData(id, createdAt, updatedAt, extra),
  }
}

function categoryRecord(id: string, name: string, updatedAt: string): SyncRecord {
  return {
    type: 'category',
    id,
    updatedAt,
    data: { id, name, icon: null, updatedAt },
  }
}

function settingsRecord(
  mainCurrency: string,
  fetchExchangeRates: boolean,
  updatedAt: string,
): SyncRecord {
  return {
    type: 'settings',
    id: 'settings',
    updatedAt,
    data: { id: 'settings', mainCurrency, fetchExchangeRates, updatedAt },
  }
}

function conversion(): EntryConversion {
  return {
    mainCurrency: 'UAH',
    rate: 41.5,
    mainAmount: 830,
    rateDate: '2026-03-15',
    source: 'nbu',
  }
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
  ctl.setManyCalls.length = 0
  ctl.heldAtSetMany.length = 0
  ctl.held.clear()
  ctl.requested.length = 0
  stops = []
  setSyncChannel(null)
  vi.useFakeTimers({ toFake: ['Date'] })
  setNow(NOW)
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
})

afterEach(() => {
  for (const stop of stops) stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
  setSyncChannel(undefined)
})

// ── Expenses: newest wins, chunks, tombstones ─────────────────────────────────

describe('applyIncomingRecords: expenses', () => {
  it('a newer incoming expense in another month moves chunks: the old chunk no longer holds it', async () => {
    setNow(OLD)
    const local = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: 'c1',
      createdAt: MARCH,
    })
    setNow(NOW)
    ctl.setManyCalls.length = 0

    const result = await applyIncomingRecords([
      expenseRecord(local.id, APRIL, NEW, { amount: 9 }),
    ])

    expect(result).toEqual({ applied: 1, kept: 0, conflicts: 0 })
    expect(await readRaw<Expense>(MARCH_CHUNK)).toEqual([])
    const april = await readRaw<Expense>(APRIL_CHUNK)
    expect(april).toHaveLength(1)
    expect(april[0]).toMatchObject({ id: local.id, amount: 9, createdAt: APRIL, updatedAt: NEW })
    const all = await getAllExpenses()
    expect(all).toHaveLength(1)
    expect(all[0].createdAt).toBe(APRIL)
    // One transaction with both chunks, and no counter.
    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual([MARCH_CHUNK, APRIL_CHUNK])
  })

  it('a new expense goes to the chunk of its createdAt, without a rev', async () => {
    const result = await applyIncomingRecords([
      expenseRecord('new-1', MARCH, NEW),
      expenseRecord('new-2', APRIL, NEW),
    ])

    expect(result).toEqual({ applied: 2, kept: 0, conflicts: 0 })
    const march = await readRaw<Expense & { rev?: number }>(MARCH_CHUNK)
    const april = await readRaw<Expense & { rev?: number }>(APRIL_CHUNK)
    expect(march.map((e) => e.id)).toEqual(['new-1'])
    expect(april.map((e) => e.id)).toEqual(['new-2'])
    expect('rev' in march[0]).toBe(false)
    expect(march[0]).toEqual(expenseData('new-1', MARCH, NEW))
  })

  it('an incoming tombstone newer than the local record hides it and is stored as a tombstone', async () => {
    await seed(MARCH_CHUNK, [expenseData('x', MARCH, OLD)])

    const result = await applyIncomingRecords([
      expenseRecord('x', MARCH, NEW, { deletedAt: NEW }),
    ])

    expect(result).toEqual({ applied: 1, kept: 0, conflicts: 0 })
    expect(await getAllExpenses()).toEqual([])
    const [raw] = await readRaw<Expense>(MARCH_CHUNK)
    expect(raw.id).toBe('x')
    expect(raw.deletedAt).toBe(NEW)
    expect(raw.updatedAt).toBe(NEW)
  })

  it('a tombstone whose data lacks deletedAt is still stored with it (the record carries it)', async () => {
    await seed(MARCH_CHUNK, [expenseData('x', MARCH, OLD)])
    const record = expenseRecord('x', MARCH, NEW)
    record.deletedAt = NEW

    await applyIncomingRecords([record])

    const [raw] = await readRaw<Expense>(MARCH_CHUNK)
    expect(raw.deletedAt).toBe(NEW)
    expect(await getAllExpenses()).toEqual([])
  })

  it('an incoming tombstone for an expense this device never had is stored as a tombstone', async () => {
    const result = await applyIncomingRecords([
      expenseRecord('ghost', MARCH, NEW, { deletedAt: NEW }),
    ])

    expect(result.applied).toBe(1)
    expect(await getAllExpenses()).toEqual([])
    const [raw] = await readRaw<Expense>(MARCH_CHUNK)
    expect(raw.deletedAt).toBe(NEW)
  })

  it('an older incoming record is kept local: nothing is written, announced or converted', async () => {
    await seed(MARCH_CHUNK, [expenseData('x', MARCH, NEW, { amount: 7 })])
    const before = snapshot()
    const channel = fakeChannel()
    setSyncChannel(channel)
    const listener = listen()

    const result = await applyIncomingRecords([
      expenseRecord('x', MARCH, OLD, { amount: 1 }),
    ])

    expect(result).toEqual({ applied: 0, kept: 1, conflicts: 0 })
    expect(ctl.setManyCalls).toHaveLength(0)
    expect(channel.postMessage).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
    expectUnchanged(before)
    expect((await getAllExpenses())[0].amount).toBe(7)
  })

  it('an older incoming tombstone does not delete a newer local record', async () => {
    await seed(MARCH_CHUNK, [expenseData('x', MARCH, NEW)])

    const result = await applyIncomingRecords([
      expenseRecord('x', MARCH, OLD, { deletedAt: OLD }),
    ])

    expect(result).toEqual({ applied: 0, kept: 1, conflicts: 0 })
    expect(await getAllExpenses()).toHaveLength(1)
  })

  it('an identical record is kept and is not a conflict', async () => {
    await seed(MARCH_CHUNK, [expenseData('x', MARCH, MID)])

    const result = await applyIncomingRecords([expenseRecord('x', MARCH, MID)])

    expect(result).toEqual({ applied: 0, kept: 1, conflicts: 0 })
  })

  it('removes the id from every other chunk that holds it (an old duplicate)', async () => {
    await seed(MARCH_CHUNK, [
      expenseData('dup', MARCH, OLD),
      expenseData('stays', MARCH_2, OLD),
    ])
    await seed(APRIL_CHUNK, [expenseData('dup', MARCH, OLD), expenseData('other', APRIL, OLD)])

    const result = await applyIncomingRecords([
      expenseRecord('dup', APRIL, NEW, { amount: 8 }),
    ])

    expect(result.applied).toBe(1)
    const march = await readRaw<Expense>(MARCH_CHUNK)
    const april = await readRaw<Expense>(APRIL_CHUNK)
    expect(march.map((e) => e.id)).toEqual(['stays'])
    expect(april.map((e) => e.id).sort()).toEqual(['dup', 'other'])
    expect(april.find((e) => e.id === 'dup')?.amount).toBe(8)
  })

  it('does not touch the chunks it does not need to change', async () => {
    await seed('expenses_2026_01', [expenseData('jan', '2026-01-10T10:00:00.000Z', OLD)])
    const janBlob = mockStore.get('expenses_2026_01')
    ctl.setManyCalls.length = 0

    await applyIncomingRecords([expenseRecord('new', MARCH, NEW)])

    expect(mockStore.get('expenses_2026_01')).toBe(janBlob)
    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0]).toEqual([MARCH_CHUNK])
  })

  it('strips rev, conversion and the joined category from the incoming data', async () => {
    const record = expenseRecord('new', MARCH, NEW, {
      rev: 99,
      conversion: conversion(),
      category: { id: 'c1', name: 'Food' },
    })

    await applyIncomingRecords([record])

    const [raw] = await readRaw<Expense & { rev?: number }>(MARCH_CHUNK)
    expect('rev' in raw).toBe(false)
    expect('conversion' in raw).toBe(false)
    expect('category' in raw).toBe(false)
    expect(raw.amount).toBe(5)
  })

  it('stores updatedAt from the record envelope', async () => {
    const record = expenseRecord('new', MARCH, NEW)
    record.updatedAt = MID

    await applyIncomingRecords([record])

    expect((await readRaw<Expense>(MARCH_CHUNK))[0].updatedAt).toBe(MID)
  })
})

describe('applyIncomingRecords: the stored conversion (plan CONTRACT_GAP 5)', () => {
  async function seedConverted() {
    await seed(MARCH_CHUNK, [
      expenseData('x', MARCH, OLD, { amount: 20, currency: 'USD', conversion: conversion() }),
    ])
  }

  it('keeps the local conversion while amount, currency and createdAt are unchanged', async () => {
    await seedConverted()

    await applyIncomingRecords([
      expenseRecord('x', MARCH, NEW, { amount: 20, currency: 'USD', description: 'new text' }),
    ])

    const [raw] = await readRaw<Expense>(MARCH_CHUNK)
    expect(raw.description).toBe('new text')
    expect(raw.conversion).toEqual(conversion())
  })

  it.each([
    ['the amount', { amount: 25, currency: 'USD' }, MARCH],
    ['the currency', { amount: 20, currency: 'EUR' }, MARCH],
    ['the date', { amount: 20, currency: 'USD' }, MARCH_2],
  ])('stores none (pending) when %s changed', async (_what, extra, createdAt) => {
    await seedConverted()

    await applyIncomingRecords([expenseRecord('x', createdAt, NEW, extra)])

    const stored = await readRaw<Expense>(MARCH_CHUNK)
    expect(stored.find((e) => e.id === 'x')?.conversion).toBeUndefined()
    expect(stored.find((e) => e.id === 'x')?.amount).toBe(extra.amount)
  })

  it('a record that had no conversion stays without one', async () => {
    await seed(MARCH_CHUNK, [expenseData('x', MARCH, OLD, { amount: 20, currency: 'USD' })])

    await applyIncomingRecords([
      expenseRecord('x', MARCH, NEW, { amount: 20, currency: 'USD', description: 'd' }),
    ])

    expect((await readRaw<Expense>(MARCH_CHUNK))[0].conversion).toBeUndefined()
  })
})

// ── Conflicts at the same time ────────────────────────────────────────────────

describe('applyIncomingRecords: equal timestamps', () => {
  it('a live local record loses to an incoming tombstone, and the tie is counted', async () => {
    await seed(MARCH_CHUNK, [expenseData('x', MARCH, MID)])

    const result = await applyIncomingRecords([
      expenseRecord('x', MARCH, MID, { deletedAt: MID }),
    ])

    expect(result).toEqual({ applied: 1, kept: 0, conflicts: 1 })
    expect(await getAllExpenses()).toEqual([])
  })

  it('a local tombstone beats an incoming live record, and the tie is counted', async () => {
    await seed(MARCH_CHUNK, [expenseData('x', MARCH, MID, { deletedAt: MID })])

    const result = await applyIncomingRecords([expenseRecord('x', MARCH, MID)])

    expect(result).toEqual({ applied: 0, kept: 1, conflicts: 1 })
    expect(await getAllExpenses()).toEqual([])
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('without a tombstone the larger canonical JSON wins: incoming 9 beats local 5', async () => {
    await seed(MARCH_CHUNK, [expenseData('x', MARCH, MID, { amount: 5 })])

    const result = await applyIncomingRecords([
      expenseRecord('x', MARCH, MID, { amount: 9 }),
    ])

    expect(result).toEqual({ applied: 1, kept: 0, conflicts: 1 })
    expect((await getAllExpenses())[0].amount).toBe(9)
  })

  it('and local 9 beats incoming 5', async () => {
    await seed(MARCH_CHUNK, [expenseData('x', MARCH, MID, { amount: 9 })])

    const result = await applyIncomingRecords([
      expenseRecord('x', MARCH, MID, { amount: 5 }),
    ])

    expect(result).toEqual({ applied: 0, kept: 1, conflicts: 1 })
    expect((await getAllExpenses())[0].amount).toBe(9)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('both devices pick the same winner: the result does not depend on the direction', async () => {
    await seed(MARCH_CHUNK, [expenseData('x', MARCH, MID, { description: 'apple' })])
    await applyIncomingRecords([expenseRecord('x', MARCH, MID, { description: 'Zebra' })])
    const first = (await getAllExpenses())[0].description

    await seed(MARCH_CHUNK, [expenseData('x', MARCH, MID, { description: 'Zebra' })])
    await applyIncomingRecords([expenseRecord('x', MARCH, MID, { description: 'apple' })])
    const second = (await getAllExpenses())[0].description

    expect(first).toBe(second)
    // Plain string order: "apple" > "Zebra".
    expect(first).toBe('apple')
  })
})

// ── The other types ───────────────────────────────────────────────────────────

describe('applyIncomingRecords: the other types', () => {
  const NEW_RECURRING: RecurringItem = {
    id: 'rec-1',
    kind: 'expense',
    amount: 10,
    currency: 'UAH',
    categoryId: 'c1',
    description: null,
    frequency: { unit: 'month', interval: 1 },
    startDate: '2026-02-15',
    end: { type: 'never' },
    mode: 'ask',
    paused: false,
    handledThrough: null,
    handledAhead: [],
    occurrenceCount: 0,
    createdAt: OLD,
    updatedAt: NEW,
  }

  const CASES: Array<{
    type: SyncRecord['type']
    key: string
    id: string
    data: Record<string, unknown>
    read: () => Promise<Array<{ id: string }>>
  }> = [
    {
      type: 'category',
      key: 'categories',
      id: 'cat-1',
      data: { id: 'cat-1', name: 'Food', icon: null, updatedAt: NEW },
      read: () => getAllCategories(),
    },
    {
      type: 'incomeCategory',
      key: 'incomeCategories',
      id: 'icat-1',
      data: { id: 'icat-1', name: 'Salary', icon: null, updatedAt: NEW },
      read: () => getAllIncomeCategories(),
    },
    {
      type: 'income',
      key: 'income',
      id: 'inc-1',
      data: {
        id: 'inc-1',
        categoryId: 'icat-1',
        amount: 100,
        currency: 'UAH',
        description: null,
        createdAt: MARCH,
        updatedAt: NEW,
      },
      read: () => getAllIncome(),
    },
    {
      type: 'budget',
      key: 'budgets',
      id: 'bud-1',
      data: { id: 'bud-1', categoryId: 'cat-1', monthlyLimit: 50, currency: 'UAH', updatedAt: NEW },
      read: () => getAllBudgets(),
    },
    {
      type: 'recurring',
      key: 'recurring',
      id: 'rec-1',
      data: { ...NEW_RECURRING },
      read: () => getAllRecurring(),
    },
  ]

  it.each(CASES)('$type: a new record is inserted into $key without a rev', async (c) => {
    const result = await applyIncomingRecords([
      { type: c.type, id: c.id, updatedAt: NEW, data: c.data },
    ])

    expect(result).toEqual({ applied: 1, kept: 0, conflicts: 0 })
    expect((await c.read()).map((r) => r.id)).toEqual([c.id])
    const raw = await readRaw<Record<string, unknown>>(c.key)
    expect(raw).toEqual([c.data])
    expect(ctl.setManyCalls).toEqual([[c.key]])
  })

  it.each(CASES)('$type: a newer tombstone is stored as a tombstone and hides the record', async (c) => {
    await seed(c.key, [{ ...c.data, updatedAt: OLD }])

    const result = await applyIncomingRecords([
      { type: c.type, id: c.id, updatedAt: NEW, deletedAt: NEW, data: { ...c.data, deletedAt: NEW } },
    ])

    expect(result).toEqual({ applied: 1, kept: 0, conflicts: 0 })
    expect(await c.read()).toEqual([])
    const raw = await readRaw<Record<string, unknown>>(c.key)
    expect(raw).toHaveLength(1)
    expect(raw[0].deletedAt).toBe(NEW)
  })

  it.each(CASES)('$type: an older record is kept', async (c) => {
    await seed(c.key, [{ ...c.data, updatedAt: NEW }])
    const before = snapshot()

    const result = await applyIncomingRecords([
      { type: c.type, id: c.id, updatedAt: OLD, data: { ...c.data, updatedAt: OLD } },
    ])

    expect(result).toEqual({ applied: 0, kept: 1, conflicts: 0 })
    expectUnchanged(before)
  })

  it('a record replaces the local one with the same id in its own key only', async () => {
    await seed('categories', [
      { id: 'a', name: 'Local A', icon: null, updatedAt: OLD },
      { id: 'b', name: 'Local B', icon: null, updatedAt: OLD },
    ])
    await seed('incomeCategories', [{ id: 'a', name: 'Income A', icon: null, updatedAt: OLD }])
    const incomeBlob = mockStore.get('incomeCategories')

    await applyIncomingRecords([categoryRecord('a', 'Remote A', NEW)])

    const categories = await readRaw<Category>('categories')
    expect(categories.map((c) => c.name)).toEqual(['Remote A', 'Local B'])
    expect(mockStore.get('incomeCategories')).toBe(incomeBlob)
  })

  it('locally created data keeps its place: a new income entry is appended', async () => {
    await seed('income', [
      { id: 'i0', categoryId: 'ic', amount: 1, currency: 'UAH', createdAt: MARCH, updatedAt: OLD },
    ])

    await applyIncomingRecords([
      {
        type: 'income',
        id: 'i1',
        updatedAt: NEW,
        data: {
          id: 'i1',
          categoryId: 'ic',
          amount: 2,
          currency: 'UAH',
          createdAt: MARCH_2,
          updatedAt: NEW,
        },
      },
    ])

    expect((await readRaw<IncomeEntry>('income')).map((i) => i.id)).toEqual(['i0', 'i1'])
  })

  it('budgets: an incoming budget is stored as sent', async () => {
    await applyIncomingRecords([
      {
        type: 'budget',
        id: 'b1',
        updatedAt: NEW,
        data: { id: 'b1', categoryId: 'c1', monthlyLimit: 12.5, currency: 'EUR', updatedAt: NEW },
      },
    ])

    const [raw] = await readRaw<BudgetEntry>('budgets')
    expect(raw).toEqual({
      id: 'b1',
      categoryId: 'c1',
      monthlyLimit: 12.5,
      currency: 'EUR',
      updatedAt: NEW,
    })
  })
})

describe('applyIncomingRecords: the settings record', () => {
  async function seedLocalSettings() {
    await seed('syncedSettings', {
      id: 'settings',
      mainCurrency: 'USD',
      fetchExchangeRates: true,
      updatedAt: OLD,
      rev: 3,
    })
    mockStore.set('meta:sync', { localRev: 3 })
  }

  it('a newer incoming settings record replaces the local one, without a rev', async () => {
    await seedLocalSettings()

    const result = await applyIncomingRecords([settingsRecord('EUR', false, NEW)])

    expect(result).toEqual({ applied: 1, kept: 0, conflicts: 0 })
    expect(await readSyncedSettings()).toMatchObject({
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })
    const raw = await readSyncedRaw()
    expect(raw).toEqual({
      id: 'settings',
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
      updatedAt: NEW,
    })
    expect(ctl.setManyCalls).toEqual([['syncedSettings']])
    expect(await getLocalRev()).toBe(3)
  })

  it('an older incoming settings record is kept out', async () => {
    await seedLocalSettings()
    const before = snapshot()

    const result = await applyIncomingRecords([settingsRecord('EUR', false, '2025-01-01T00:00:00.000Z')])

    expect(result).toEqual({ applied: 0, kept: 1, conflicts: 0 })
    expectUnchanged(before)
  })

  it('announces syncedSettings and asks for a conversion', async () => {
    await seedLocalSettings()
    const channel = fakeChannel()
    setSyncChannel(channel)
    const listener = listen()

    await applyIncomingRecords([settingsRecord('EUR', true, NEW)])

    expect(postedKeys(channel)).toEqual(['syncedSettings'])
    expect(listener).toHaveBeenCalled()
  })

  it('works on a device that has no settings record yet', async () => {
    const result = await applyIncomingRecords([settingsRecord('EUR', false, NEW)])

    expect(result.applied).toBe(1)
    expect(await readSyncedSettings()).toMatchObject({
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })
  })
})

// ── Batches ───────────────────────────────────────────────────────────────────

describe('applyIncomingRecords: batches', () => {
  it('an empty batch writes nothing and returns zeros', async () => {
    const before = snapshot()

    expect(await applyIncomingRecords([])).toEqual({ applied: 0, kept: 0, conflicts: 0 })

    expect(ctl.setManyCalls).toHaveLength(0)
    expectUnchanged(before)
  })

  it('a mixed batch is one setMany and applied + kept equals the batch size', async () => {
    await seed(MARCH_CHUNK, [
      expenseData('newer-local', MARCH, NEW, { amount: 7 }),
      expenseData('older-local', MARCH_2, OLD),
      expenseData('tie', MARCH, MID, { amount: 5 }),
    ])
    await seed('categories', [{ id: 'cat', name: 'Old name', icon: null, updatedAt: OLD }])
    ctl.setManyCalls.length = 0
    const batch = [
      expenseRecord('newer-local', MARCH, MID),
      expenseRecord('older-local', MARCH_2, NEW, { amount: 6 }),
      expenseRecord('tie', MARCH, MID, { amount: 9 }),
      expenseRecord('brand-new', APRIL, NEW),
      categoryRecord('cat', 'New name', NEW),
    ]

    const result = await applyIncomingRecords(batch)

    expect(result).toEqual({ applied: 4, kept: 1, conflicts: 1 })
    expect(result.applied + result.kept).toBe(batch.length)
    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual(['categories', APRIL_CHUNK, MARCH_CHUNK].sort())
  })

  it('two records with the same id: the later one is compared with the result of the earlier one', async () => {
    const older = expenseRecord('dup', MARCH, MID, { amount: 1 })
    const newer = expenseRecord('dup', MARCH, NEW, { amount: 2 })

    const ascending = await applyIncomingRecords([older, newer])

    expect(ascending).toEqual({ applied: 2, kept: 0, conflicts: 0 })
    expect((await getAllExpenses())[0].amount).toBe(2)

    mockStore.clear()
    const descending = await applyIncomingRecords([newer, older])

    expect(descending).toEqual({ applied: 1, kept: 1, conflicts: 0 })
    expect((await getAllExpenses())[0].amount).toBe(2)
    expect(await getAllExpenses()).toHaveLength(1)
  })

  it('applied + kept equals the batch size for batches with duplicates too', async () => {
    const batch = [
      expenseRecord('a', MARCH, MID),
      expenseRecord('a', MARCH, NEW),
      expenseRecord('a', MARCH, OLD),
      expenseRecord('b', MARCH, OLD),
    ]

    const result = await applyIncomingRecords(batch)

    expect(result.applied + result.kept).toBe(4)
    expect(result.applied).toBe(3)
    expect(result.kept).toBe(1)
  })
})

// ── Local bookkeeping and announcements ───────────────────────────────────────

describe('applyIncomingRecords: not a local change', () => {
  it('leaves localRev and meta:sync alone and stamps no rev', async () => {
    setNow(OLD)
    const local = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: 'c1',
      createdAt: MARCH,
    })
    setNow(NOW)
    const rev = await getLocalRev()
    const syncBlob = mockStore.get('meta:sync')
    ctl.setManyCalls.length = 0

    await applyIncomingRecords([
      expenseRecord(local.id, MARCH, NEW, { amount: 9 }),
      categoryRecord('cat', 'Remote', NEW),
    ])

    expect(await getLocalRev()).toBe(rev)
    expect(mockStore.get('meta:sync')).toBe(syncBlob)
    expect(ctl.setManyCalls.flat()).not.toContain('meta:sync')
    const [raw] = await readRaw<Expense & { rev?: number }>(MARCH_CHUNK)
    expect(raw.amount).toBe(9)
    expect('rev' in raw).toBe(false)
    const [category] = await readRaw<Category & { rev?: number }>('categories')
    expect('rev' in category).toBe(false)
  })

  it('what it applied is not offered as a local change to upload', async () => {
    const rev = await getLocalRev()

    await applyIncomingRecords([expenseRecord('from-server', MARCH, NEW)])

    expect((await listChangedRecords(rev)).records).toEqual([])
    expect((await listChangedRecords(-1)).records.map((r) => r.id)).toEqual(['from-server'])
  })

  it('announces the changed keys to other tabs once, after the commit', async () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    await applyIncomingRecords([
      expenseRecord('a', MARCH, NEW),
      expenseRecord('b', APRIL, NEW),
      categoryRecord('cat', 'Remote', NEW),
    ])

    expect(channel.postMessage).toHaveBeenCalledTimes(1)
    expect([...postedKeys(channel)].sort()).toEqual(['categories', APRIL_CHUNK, MARCH_CHUNK].sort())
  })

  it('announces only the keys it wrote', async () => {
    await seed(MARCH_CHUNK, [expenseData('x', MARCH, NEW)])
    const channel = fakeChannel()
    setSyncChannel(channel)

    await applyIncomingRecords([
      expenseRecord('x', MARCH, OLD),
      categoryRecord('cat', 'Remote', NEW),
    ])

    expect(postedKeys(channel)).toEqual(['categories'])
  })

  it('asks for a conversion when an entry key changed', async () => {
    const listener = listen()

    await applyIncomingRecords([expenseRecord('a', MARCH, NEW)])

    expect(listener).toHaveBeenCalled()
  })

  it('asks for a conversion for income too, but not for a category-only batch', async () => {
    const listener = listen()

    await applyIncomingRecords([categoryRecord('cat', 'Remote', NEW)])
    expect(listener).not.toHaveBeenCalled()

    await applyIncomingRecords([
      {
        type: 'income',
        id: 'i1',
        updatedAt: NEW,
        data: { id: 'i1', categoryId: 'ic', amount: 1, currency: 'USD', createdAt: MARCH, updatedAt: NEW },
      },
    ])
    expect(listener).toHaveBeenCalled()
  })

  it('marks a data change for the backup reminder', async () => {
    await applyIncomingRecords([categoryRecord('cat', 'Remote', NEW)])

    expect(
      (mockStore.get('meta:settings') as { lastDataChangeAt?: string }).lastDataChangeAt,
    ).toBe(NOW)
  })
})

// ── Validation ────────────────────────────────────────────────────────────────

describe('applyIncomingRecords: a malformed record rejects the batch before anything is read or written', () => {
  const GOOD = categoryRecord('good', 'Fine', NEW)
  const asRecord = (value: unknown) => value as SyncRecord

  const MALFORMED: Array<[string, SyncRecord]> = [
    ['an unknown type', asRecord({ ...GOOD, type: 'wallet' })],
    ['an empty id', asRecord({ type: 'category', id: '', updatedAt: NEW, data: { id: '' } })],
    ['a non-string id', asRecord({ type: 'category', id: 5, updatedAt: NEW, data: { id: 5 } })],
    ['data that is null', asRecord({ ...GOOD, data: null })],
    ['data that is an array', asRecord({ ...GOOD, data: [] })],
    ['data that is a string', asRecord({ ...GOOD, data: 'text' })],
    ['a data.id that differs from the id', asRecord({ ...GOOD, data: { id: 'other', name: 'x' } })],
    ['an unparseable updatedAt', asRecord({ ...GOOD, updatedAt: 'not a date' })],
    ['an unparseable deletedAt', asRecord({ ...GOOD, deletedAt: 'nope' })],
    [
      'an expense without createdAt',
      asRecord({ type: 'expense', id: 'e', updatedAt: NEW, data: { id: 'e', amount: 1 } }),
    ],
    [
      'an expense with an unparseable createdAt',
      asRecord({
        type: 'expense',
        id: 'e',
        updatedAt: NEW,
        data: { id: 'e', amount: 1, createdAt: 'garbage' },
      }),
    ],
    [
      'an income entry without createdAt',
      asRecord({ type: 'income', id: 'i', updatedAt: NEW, data: { id: 'i', amount: 1 } }),
    ],
    [
      'a settings record with another id',
      asRecord({
        type: 'settings',
        id: 'prefs',
        updatedAt: NEW,
        data: { id: 'prefs', mainCurrency: 'EUR', fetchExchangeRates: true, updatedAt: NEW },
      }),
    ],
    ['a settings record with an invalid currency', settingsRecord('GBP', true, NEW)],
    [
      'a settings record with an invalid boolean',
      asRecord({
        type: 'settings',
        id: 'settings',
        updatedAt: NEW,
        data: {
          id: 'settings',
          mainCurrency: 'EUR',
          fetchExchangeRates: 'yes',
          updatedAt: NEW,
        },
      }),
    ],
  ]

  it.each(MALFORMED)('%s', async (_name, bad) => {
    await seed('categories', [{ id: 'keep', name: 'Keep', icon: null, updatedAt: OLD }])
    const before = snapshot()
    const channel = fakeChannel()
    setSyncChannel(channel)

    await expect(applyIncomingRecords([GOOD, bad, GOOD])).rejects.toThrow(
      'applyIncomingRecords: invalid record 1',
    )

    expect(ctl.setManyCalls).toHaveLength(0)
    expect(channel.postMessage).not.toHaveBeenCalled()
    expectUnchanged(before)
  })

  it('names the index of the first malformed record', async () => {
    await expect(
      applyIncomingRecords([GOOD, GOOD, asRecord({ ...GOOD, type: 'wallet' })]),
    ).rejects.toThrow('applyIncomingRecords: invalid record 2')
    await expect(
      applyIncomingRecords([asRecord({ ...GOOD, id: '' }), GOOD]),
    ).rejects.toThrow('applyIncomingRecords: invalid record 0')
  })

  it('validates before it reads: an unreadable chunk does not hide the validation error', async () => {
    mockStore.set(MARCH_CHUNK, new Uint8Array(40))

    await expect(
      applyIncomingRecords([
        expenseRecord('ok', MARCH, NEW),
        asRecord({ ...GOOD, type: 'wallet' }),
      ]),
    ).rejects.toThrow('applyIncomingRecords: invalid record 1')
  })

  it('a record with no deletedAt and a parseable updatedAt is fine', async () => {
    await expect(applyIncomingRecords([GOOD])).resolves.toEqual({
      applied: 1,
      kept: 0,
      conflicts: 0,
    })
  })
})

// ── Errors ────────────────────────────────────────────────────────────────────

describe('applyIncomingRecords: a DecryptError propagates and nothing is written', () => {
  it('an unreadable target chunk', async () => {
    const garbage = new Uint8Array(40)
    mockStore.set(MARCH_CHUNK, garbage)
    await seed('categories', [{ id: 'keep', name: 'Keep', icon: null, updatedAt: OLD }])
    const categoriesBlob = mockStore.get('categories')

    await expect(
      applyIncomingRecords([
        categoryRecord('keep', 'Renamed', NEW),
        expenseRecord('e', MARCH, NEW),
      ]),
    ).rejects.toBeInstanceOf(DecryptError)

    expect(mockStore.get(MARCH_CHUNK)).toBe(garbage)
    expect(mockStore.get('categories')).toBe(categoriesBlob)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('an unreadable chunk of another month is still found, because every chunk is read', async () => {
    const garbage = new Uint8Array(40)
    mockStore.set('expenses_2026_01', garbage)

    await expect(
      applyIncomingRecords([expenseRecord('e', MARCH, NEW)]),
    ).rejects.toBeInstanceOf(DecryptError)

    expect(mockStore.get('expenses_2026_01')).toBe(garbage)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('an unreadable single key', async () => {
    const garbage = new Uint8Array(40)
    mockStore.set('categories', garbage)

    const err = await applyIncomingRecords([categoryRecord('c', 'x', NEW)]).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(DecryptError)
    expect((err as DecryptError).storageKey).toBe('categories')
    expect(mockStore.get('categories')).toBe(garbage)
  })

  it('an unreadable key the batch does not need is never read', async () => {
    const garbage = new Uint8Array(40)
    mockStore.set('income', garbage)
    mockStore.set('expenses_2026_01', garbage)

    await expect(
      applyIncomingRecords([categoryRecord('c', 'x', NEW)]),
    ).resolves.toMatchObject({ applied: 1 })

    expect(mockStore.get('income')).toBe(garbage)
  })

  it('an unreadable syncedSettings record', async () => {
    const garbage = new Uint8Array(40)
    mockStore.set('syncedSettings', garbage)

    await expect(
      applyIncomingRecords([settingsRecord('EUR', true, NEW)]),
    ).rejects.toBeInstanceOf(DecryptError)

    expect(mockStore.get('syncedSettings')).toBe(garbage)
  })
})

// ── Locks ─────────────────────────────────────────────────────────────────────

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

describe('applyIncomingRecords: locking', () => {
  beforeEach(() => {
    installFakeLocks()
  })

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks')
  })

  it('holds the single keys of the batch and, for an expense, every chunk, but not meta:sync', async () => {
    await seed('expenses_2026_01', [expenseData('jan', '2026-01-10T10:00:00.000Z', OLD)])
    await seed('expenses_2026_05', [expenseData('may', '2026-05-10T10:00:00.000Z', OLD)])
    ctl.requested.length = 0

    await applyIncomingRecords([
      expenseRecord('new', MARCH, NEW),
      categoryRecord('cat', 'Remote', NEW),
    ])

    const held = ctl.heldAtSetMany[ctl.heldAtSetMany.length - 1]
    for (const name of [
      'minima:categories',
      'minima:expenses_2026_01',
      'minima:expenses_2026_03',
      'minima:expenses_2026_05',
    ]) {
      expect(ctl.requested).toContain(name)
      expect(held).toContain(name)
    }
    expect(ctl.requested).not.toContain('minima:meta:sync')
    expect(ctl.requested).not.toContain('minima:income')
    expect(ctl.held.size).toBe(0)
  })

  it('a batch without expenses does not lock the expense chunks', async () => {
    await seed('expenses_2026_01', [expenseData('jan', '2026-01-10T10:00:00.000Z', OLD)])
    ctl.requested.length = 0

    await applyIncomingRecords([categoryRecord('cat', 'Remote', NEW)])

    expect(ctl.requested).toContain('minima:categories')
    expect(ctl.requested.some((name) => name.startsWith('minima:expenses_'))).toBe(false)
    expect(ctl.requested).not.toContain('minima:meta:sync')
  })

  it('an addExpense racing an applyIncomingRecords into the same chunk loses nothing', async () => {
    await Promise.all([
      applyIncomingRecords([
        expenseRecord('remote-1', MARCH, NEW),
        expenseRecord('remote-2', MARCH_2, NEW),
      ]),
      addExpense({ amount: 3, currency: 'UAH', categoryId: 'c1', createdAt: MARCH }),
    ])

    const all = await getAllExpenses()
    expect(all).toHaveLength(3)
    expect(all.map((e) => e.id)).toEqual(expect.arrayContaining(['remote-1', 'remote-2']))
    // Only the local write moved the counter.
    expect(await getLocalRev()).toBe(1)
  })
})
