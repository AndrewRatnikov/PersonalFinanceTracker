// No CONTRACT_GAPs: identity conversion on save, updateExpense keep/clear rules,
// onConversionNeeded / requestEntryConversion, readEntriesForConversion,
// applyEntryConversions and convertBudgets are fully specified in the
// Interface Contract (module: localDb additions) and plan sections 4 and 7.
//
// Integration style (as localDb.concurrency.test.ts): real crypto and real
// localDb with idb-keyval backed by a Map. Records are seeded encrypted with
// the same key the test unlocks the db with.
//
// The main currency now lives in the encrypted `syncedSettings` record.
// Seeding `meta:settings.mainCurrency` still works (the legacy fallback), and
// convertBudgets writes `syncedSettings` + meta:sync instead of meta:settings.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  BudgetEntry,
  Currency,
  EntryConversion,
  Expense,
  IncomeEntry,
  RecurringItem,
} from '@/lib/domain'
import type { SyncChannel } from '@/lib/syncChannel'
import { decryptValue, encryptValue } from '@/lib/crypto'
import {
  DecryptError,
  addExpense,
  addIncome,
  addRecurring,
  addRepeatingExpense,
  addRepeatingIncome,
  applyEntryConversions,
  convertBudgets,
  deleteExpense,
  deleteIncome,
  getAllBudgets,
  getAllExpenses,
  getAllIncome,
  getLocalRev,
  onConversionNeeded,
  prepareUnlockedVault,
  processDueRecurring,
  readEntriesForConversion,
  readSyncedSettings,
  requestEntryConversion,
  unlockLocalDb,
  updateExpense,
  upsertBudget,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: {
    setManyCalls: [] as Array<Array<string>>,
    failSetMany: false,
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

// Local noon, so the local date is the same in every timezone.
const OCT_14 = new Date(2026, 9, 14, 12, 0, 0).toISOString()
const OCT_14_DATE = '2026-10-14'
const SEP_20 = new Date(2026, 8, 20, 12, 0, 0).toISOString()
const OCT_CHUNK = 'expenses_2026_10'
const SEP_CHUNK = 'expenses_2026_09'
const OLD = '2026-01-05T08:00:00.000Z'

let dek: CryptoKey
let unsubscribers: Array<() => void> = []

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
  unsubscribers.push(onConversionNeeded(listener))
  return listener
}

function conv(
  mainCurrency: Currency,
  amount: number,
  rate: number,
  source = 'nbu',
): EntryConversion {
  return {
    mainCurrency,
    rate,
    mainAmount: amount * rate,
    rateDate: OCT_14_DATE,
    source,
  }
}

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'e1',
    amount: 20,
    currency: 'USD',
    categoryId: 'c1',
    description: 'Lunch',
    createdAt: OCT_14,
    updatedAt: OLD,
    ...overrides,
  }
}

function makeIncome(overrides: Partial<IncomeEntry> = {}): IncomeEntry {
  return {
    id: 'i1',
    categoryId: 'ic1',
    amount: 500,
    currency: 'USD',
    description: null,
    createdAt: OCT_14,
    updatedAt: OLD,
    ...overrides,
  }
}

async function seed(storageKey: string, value: unknown) {
  mockStore.set(storageKey, await encryptValue(dek, value))
}

async function seedCategories() {
  await seed('categories', [{ id: 'c1', name: 'Food', icon: null, updatedAt: OLD }])
  await seed('incomeCategories', [
    { id: 'ic1', name: 'Salary', icon: null, updatedAt: OLD },
  ])
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

// Seeds the legacy plaintext fields (a store that has not been migrated).
function setSettings(settings: Record<string, unknown>) {
  mockStore.set('meta:settings', settings)
}

beforeEach(async () => {
  mockStore.clear()
  ctl.setManyCalls.length = 0
  ctl.failSetMany = false
  unsubscribers = []
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
})

afterEach(() => {
  for (const stop of unsubscribers) stop()
  setSyncChannel(undefined)
  vi.restoreAllMocks()
})

// ── Saving ────────────────────────────────────────────────────────────────────

describe('saving stores the identity conversion for entries in the main currency', () => {
  it('addExpense in the default main currency (UAH) is identity-converted', async () => {
    const saved = await addExpense({
      amount: 100,
      currency: 'UAH',
      categoryId: 'c1',
      createdAt: OCT_14,
    })

    expect(saved.conversion).toEqual({
      mainCurrency: 'UAH',
      rate: 1,
      mainAmount: 100,
      rateDate: OCT_14_DATE,
      source: 'identity',
    })
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion).toEqual(saved.conversion)
  })

  it('addExpense in another currency stays pending (no conversion)', async () => {
    const saved = await addExpense({
      amount: 20,
      currency: 'USD',
      categoryId: 'c1',
      createdAt: OCT_14,
    })

    expect(saved.conversion).toBeUndefined()
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect('conversion' in stored).toBe(false)
  })

  it('follows the stored main currency: with main USD the USD expense is identity, the UAH one pending', async () => {
    setSettings({ mainCurrency: 'USD' })

    const usd = await addExpense({
      amount: 20,
      currency: 'USD',
      categoryId: 'c1',
      createdAt: OCT_14,
    })
    const uah = await addExpense({
      amount: 100,
      currency: 'UAH',
      categoryId: 'c1',
      createdAt: OCT_14,
    })

    expect(usd.conversion?.mainCurrency).toBe('USD')
    expect(usd.conversion?.source).toBe('identity')
    expect(usd.conversion?.mainAmount).toBe(20)
    expect(uah.conversion).toBeUndefined()
  })

  it('follows a main currency stored in syncedSettings too', async () => {
    await seed('syncedSettings', {
      id: 'settings',
      mainCurrency: 'EUR',
      fetchExchangeRates: true,
      updatedAt: OLD,
    })

    const eur = await addExpense({
      amount: 20,
      currency: 'EUR',
      categoryId: 'c1',
      createdAt: OCT_14,
    })
    const uah = await addExpense({
      amount: 100,
      currency: 'UAH',
      categoryId: 'c1',
      createdAt: OCT_14,
    })

    expect(eur.conversion?.mainCurrency).toBe('EUR')
    expect(eur.conversion?.source).toBe('identity')
    expect(uah.conversion).toBeUndefined()
  })

  it('the syncedSettings record wins over the legacy meta:settings field', async () => {
    setSettings({ mainCurrency: 'USD' })
    await seed('syncedSettings', {
      id: 'settings',
      mainCurrency: 'EUR',
      fetchExchangeRates: true,
      updatedAt: OLD,
    })

    const eur = await addExpense({
      amount: 20,
      currency: 'EUR',
      categoryId: 'c1',
      createdAt: OCT_14,
    })
    const usd = await addExpense({
      amount: 20,
      currency: 'USD',
      categoryId: 'c1',
      createdAt: OCT_14,
    })

    expect(eur.conversion?.source).toBe('identity')
    expect(usd.conversion).toBeUndefined()
  })

  it('falls back to UAH when the stored main currency is not a known currency', async () => {
    setSettings({ mainCurrency: 'GBP' })

    const uah = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: 'c1',
      createdAt: OCT_14,
    })

    expect(uah.conversion?.mainCurrency).toBe('UAH')
  })

  it('addIncome follows the same rule', async () => {
    const uah = await addIncome({
      categoryId: 'ic1',
      amount: 900,
      currency: 'UAH',
      createdAt: OCT_14,
    })
    const eur = await addIncome({
      categoryId: 'ic1',
      amount: 50,
      currency: 'EUR',
      createdAt: OCT_14,
    })

    expect(uah.conversion).toEqual({
      mainCurrency: 'UAH',
      rate: 1,
      mainAmount: 900,
      rateDate: OCT_14_DATE,
      source: 'identity',
    })
    expect(eur.conversion).toBeUndefined()
  })

  it('addRepeatingExpense and addRepeatingIncome are identity-converted in the main currency only', async () => {
    const e = await addRepeatingExpense(
      { amount: 10, currency: 'UAH', categoryId: 'c1', createdAt: OCT_14 },
      'month',
    )
    const eUsd = await addRepeatingExpense(
      { amount: 10, currency: 'USD', categoryId: 'c1', createdAt: OCT_14 },
      'month',
    )
    const i = await addRepeatingIncome(
      { categoryId: 'ic1', amount: 10, currency: 'UAH', createdAt: OCT_14 },
      'month',
    )
    const iUsd = await addRepeatingIncome(
      { categoryId: 'ic1', amount: 10, currency: 'USD', createdAt: OCT_14 },
      'month',
    )

    expect(e.conversion?.source).toBe('identity')
    expect(i.conversion?.source).toBe('identity')
    expect(eUsd.conversion).toBeUndefined()
    expect(iUsd.conversion).toBeUndefined()
  })

  it('records generated for recurring occurrences are identity-converted per their own date', async () => {
    await seedCategories()

    await addRecurring(
      {
        kind: 'expense',
        amount: 100,
        currency: 'UAH',
        categoryId: 'c1',
        description: 'Gym',
        frequency: { unit: 'month', interval: 1 },
        startDate: '2026-08-10',
        end: { type: 'never' },
        mode: 'auto',
      },
      { createThroughToday: true, today: '2026-10-15' },
    )
    await addRecurring(
      {
        kind: 'income',
        amount: 30,
        currency: 'USD',
        categoryId: 'ic1',
        description: null,
        frequency: { unit: 'month', interval: 1 },
        startDate: '2026-08-10',
        end: { type: 'never' },
        mode: 'auto',
      },
      { createThroughToday: true, today: '2026-10-15' },
    )

    const expenses = await getAllExpenses()
    const income = await getAllIncome()
    expect(expenses).toHaveLength(3)
    expect(expenses.map((e) => e.conversion?.rateDate).sort()).toEqual([
      '2026-08-10',
      '2026-09-10',
      '2026-10-10',
    ])
    expect(expenses.every((e) => e.conversion?.source === 'identity')).toBe(true)
    expect(income).toHaveLength(3)
    expect(income.every((i) => i.conversion === undefined)).toBe(true)
  })

  it('processDueRecurring converts the generated main-currency records too', async () => {
    await seedCategories()
    const item: RecurringItem = {
      id: 'r1',
      kind: 'expense',
      amount: 70,
      currency: 'UAH',
      categoryId: 'c1',
      description: null,
      frequency: { unit: 'month', interval: 1 },
      startDate: '2026-09-01',
      end: { type: 'never' },
      mode: 'auto',
      paused: false,
      handledThrough: null,
      handledAhead: [],
      occurrenceCount: 0,
      createdAt: OLD,
      updatedAt: OLD,
    }
    await seed('recurring', [item])

    const result = await processDueRecurring('2026-10-15')

    expect(result.created).toBe(2)
    const expenses = await getAllExpenses()
    expect(expenses.map((e) => e.conversion?.mainAmount)).toEqual([70, 70])
  })
})

// ── updateExpense ─────────────────────────────────────────────────────────────

describe('updateExpense keeps or clears the conversion', () => {
  async function seedConvertedUsd(extra: Partial<Expense> = {}) {
    await seedCategories()
    await seed(OCT_CHUNK, [
      makeExpense({ conversion: conv('UAH', 20, 41.52), ...extra }),
    ])
  }

  it('keeps the conversion on a description-only edit', async () => {
    await seedConvertedUsd()

    const updated = await updateExpense('e1', OCT_14, { description: 'Dinner' })

    expect(updated.description).toBe('Dinner')
    expect(updated.conversion).toEqual(conv('UAH', 20, 41.52))
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion).toEqual(conv('UAH', 20, 41.52))
  })

  it('keeps the conversion when the patch repeats the same amount, currency and date', async () => {
    await seedConvertedUsd()

    const updated = await updateExpense('e1', OCT_14, {
      amount: 20,
      currency: 'USD',
      createdAt: OCT_14,
    })

    expect(updated.conversion).toEqual(conv('UAH', 20, 41.52))
  })

  it('keeps the conversion on a category-only edit', async () => {
    await seedConvertedUsd()
    await seed('categories', [
      { id: 'c1', name: 'Food', icon: null, updatedAt: OLD },
      { id: 'c2', name: 'Fun', icon: null, updatedAt: OLD },
    ])

    const updated = await updateExpense('e1', OCT_14, { categoryId: 'c2' })

    expect(updated.categoryId).toBe('c2')
    expect(updated.conversion).toEqual(conv('UAH', 20, 41.52))
  })

  it('clears the conversion when the amount changes', async () => {
    await seedConvertedUsd()

    const updated = await updateExpense('e1', OCT_14, { amount: 25 })

    expect(updated.conversion).toBeUndefined()
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.amount).toBe(25)
    expect(stored.conversion).toBeUndefined()
  })

  it('clears the conversion when the date changes (and the record moves month)', async () => {
    await seedConvertedUsd()

    const updated = await updateExpense('e1', OCT_14, { createdAt: SEP_20 })

    expect(updated.conversion).toBeUndefined()
    const [moved] = await readRaw<Expense>(SEP_CHUNK)
    expect(moved.conversion).toBeUndefined()
  })

  it('clears the conversion when the currency changes to another non-main currency', async () => {
    await seedConvertedUsd()

    const updated = await updateExpense('e1', OCT_14, { currency: 'EUR' })

    expect(updated.currency).toBe('EUR')
    expect(updated.conversion).toBeUndefined()
  })

  it('switching the currency to the main currency stores an identity conversion for the new amount', async () => {
    await seedConvertedUsd()

    const updated = await updateExpense('e1', OCT_14, {
      currency: 'UAH',
      amount: 830,
    })

    expect(updated.conversion).toEqual({
      mainCurrency: 'UAH',
      rate: 1,
      mainAmount: 830,
      rateDate: OCT_14_DATE,
      source: 'identity',
    })
  })

  it('changing the amount of a main-currency expense refreshes the identity conversion', async () => {
    await seedCategories()
    await seed(OCT_CHUNK, [
      makeExpense({
        currency: 'UAH',
        amount: 100,
        conversion: {
          mainCurrency: 'UAH',
          rate: 1,
          mainAmount: 100,
          rateDate: OCT_14_DATE,
          source: 'identity',
        },
      }),
    ])

    const updated = await updateExpense('e1', OCT_14, { amount: 250 })

    expect(updated.conversion?.mainAmount).toBe(250)
    expect(updated.conversion?.source).toBe('identity')
  })

  it('moving a main-currency expense to another day updates the identity rateDate', async () => {
    await seedCategories()
    await seed(OCT_CHUNK, [makeExpense({ currency: 'UAH', amount: 100 })])

    const updated = await updateExpense('e1', OCT_14, { createdAt: SEP_20 })

    expect(updated.conversion?.rateDate).toBe('2026-09-20')
  })

  it('keeps manualRate when the currency is unchanged, even if the amount changes', async () => {
    await seedConvertedUsd({ manualRate: { mainCurrency: 'UAH', rate: 40 } })

    const updated = await updateExpense('e1', OCT_14, { amount: 30 })

    expect(updated.manualRate).toEqual({ mainCurrency: 'UAH', rate: 40 })
    expect(updated.conversion).toBeUndefined()
  })

  it('drops manualRate when the currency changes', async () => {
    await seedConvertedUsd({ manualRate: { mainCurrency: 'UAH', rate: 40 } })

    const updated = await updateExpense('e1', OCT_14, { currency: 'EUR' })

    expect(updated.manualRate).toBeUndefined()
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect('manualRate' in stored).toBe(false)
  })
})

// ── In-tab trigger ────────────────────────────────────────────────────────────

describe('onConversionNeeded / requestEntryConversion', () => {
  it('requestEntryConversion calls every registered listener', () => {
    const a = listen()
    const b = listen()

    requestEntryConversion()

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('stops calling a listener after it unsubscribes', () => {
    const a = listen()
    const b = vi.fn()
    const stopB = onConversionNeeded(b)
    stopB()

    requestEntryConversion()

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('logs a throwing listener and still calls the others', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    unsubscribers.push(
      onConversionNeeded(() => {
        throw new Error('listener broke')
      }),
    )
    const healthy = listen()

    expect(() => requestEntryConversion()).not.toThrow()

    expect(healthy).toHaveBeenCalledTimes(1)
    expect(errorLog).toHaveBeenCalled()
  })

  it('addExpense triggers it', async () => {
    const listener = listen()

    await addExpense({ amount: 1, currency: 'USD', categoryId: 'c1', createdAt: OCT_14 })

    expect(listener).toHaveBeenCalled()
  })

  it('addIncome triggers it', async () => {
    const listener = listen()

    await addIncome({ categoryId: 'ic1', amount: 1, currency: 'USD', createdAt: OCT_14 })

    expect(listener).toHaveBeenCalled()
  })

  it('updateExpense, deleteExpense and deleteIncome trigger it', async () => {
    await seedCategories()
    await seed(OCT_CHUNK, [makeExpense(), makeExpense({ id: 'e2' })])
    await seed('income', [makeIncome()])
    const listener = listen()

    await updateExpense('e1', OCT_14, { amount: 21 })
    expect(listener).toHaveBeenCalledTimes(1)

    await deleteExpense('e2', OCT_14)
    expect(listener).toHaveBeenCalledTimes(2)

    await deleteIncome('i1')
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('recurring generation triggers it', async () => {
    await seedCategories()
    await seed('recurring', [
      {
        id: 'r1',
        kind: 'expense',
        amount: 70,
        currency: 'USD',
        categoryId: 'c1',
        description: null,
        frequency: { unit: 'month', interval: 1 },
        startDate: '2026-10-01',
        end: { type: 'never' },
        mode: 'auto',
        paused: false,
        handledThrough: null,
        handledAhead: [],
        occurrenceCount: 0,
        createdAt: OLD,
        updatedAt: OLD,
      } satisfies RecurringItem,
    ])
    const listener = listen()

    await processDueRecurring('2026-10-15')

    expect(listener).toHaveBeenCalled()
  })

  it('budget and category writes do not trigger it', async () => {
    const listener = listen()

    await upsertBudget({ categoryId: 'c1', monthlyLimit: 100, currency: 'UAH' })

    expect(listener).not.toHaveBeenCalled()
  })

  it("the converter's own writes (applyEntryConversions, convertBudgets) do not trigger it", async () => {
    await seedCategories()
    await seed(OCT_CHUNK, [makeExpense()])
    await seed('budgets', [
      { id: 'b1', categoryId: 'c1', monthlyLimit: 10, currency: 'USD', updatedAt: OLD },
    ])
    const listener = listen()

    await applyEntryConversions(OCT_CHUNK, 'UAH', [
      {
        id: 'e1',
        amount: 20,
        currency: 'USD',
        createdAt: OCT_14,
        conversion: conv('UAH', 20, 41.52),
      },
    ])
    await convertBudgets('UAH', () => 41.52, { setMainCurrency: false })
    await convertBudgets('UAH', () => 41.52, { setMainCurrency: true })

    expect(listener).not.toHaveBeenCalled()
  })

  it('prepareUnlockedVault requests a conversion', async () => {
    await seed('categories', [])
    await seed('incomeCategories', [])
    const listener = listen()

    await prepareUnlockedVault({ isNewVault: false })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('prepareUnlockedVault requests the conversion after the due recurring records exist', async () => {
    await seedCategories()
    await seed('recurring', [
      {
        id: 'r1',
        kind: 'expense',
        amount: 5,
        currency: 'USD',
        categoryId: 'c1',
        description: null,
        frequency: { unit: 'month', interval: 1 },
        startDate: '2026-10-01',
        end: { type: 'never' },
        mode: 'auto',
        paused: false,
        handledThrough: null,
        handledAhead: [],
        occurrenceCount: 0,
        createdAt: OLD,
        updatedAt: OLD,
      } satisfies RecurringItem,
    ])
    const seen: Array<number> = []
    unsubscribers.push(
      onConversionNeeded(() => {
        seen.push(
          Array.from(mockStore.keys()).filter((k) => k.startsWith('expenses_'))
            .length,
        )
      }),
    )

    const result = await prepareUnlockedVault({ isNewVault: false })

    expect(result.recurringCreated).toBeGreaterThan(0)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toBeGreaterThan(0)
  })
})

// ── readEntriesForConversion ──────────────────────────────────────────────────

describe('readEntriesForConversion', () => {
  it('is empty for an empty store', async () => {
    expect(await readEntriesForConversion()).toEqual([])
  })

  it('returns one group per expense chunk in ascending key order, then income', async () => {
    await seedCategories()
    await seed(OCT_CHUNK, [makeExpense({ id: 'e-oct' })])
    await seed(SEP_CHUNK, [makeExpense({ id: 'e-sep', createdAt: SEP_20 })])
    await seed('income', [makeIncome()])

    const groups = await readEntriesForConversion()

    expect(groups.map((g) => g.storageKey)).toEqual([
      SEP_CHUNK,
      OCT_CHUNK,
      'income',
    ])
    expect(groups[0].records.map((r) => r.id)).toEqual(['e-sep'])
    expect(groups[1].records.map((r) => r.id)).toEqual(['e-oct'])
    expect(groups[2].records.map((r) => r.id)).toEqual(['i1'])
  })

  it('returns the raw stored records without a joined category', async () => {
    await seedCategories()
    await seed(OCT_CHUNK, [makeExpense({ conversion: conv('UAH', 20, 41.52) })])
    await seed('income', [makeIncome()])

    const groups = await readEntriesForConversion()

    for (const group of groups) {
      for (const record of group.records) {
        expect('category' in record).toBe(false)
      }
    }
    expect(groups[0].records[0].conversion).toEqual(conv('UAH', 20, 41.52))
  })

  it('stays raw: tombstones are returned too (its callers filter them)', async () => {
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'live' }),
      makeExpense({ id: 'dead', deletedAt: OLD }),
    ])

    const groups = await readEntriesForConversion()

    expect(groups[0].records.map((r) => r.id)).toEqual(['live', 'dead'])
  })

  it('propagates a DecryptError for an unreadable chunk', async () => {
    mockStore.set(OCT_CHUNK, new Uint8Array(40))

    await expect(readEntriesForConversion()).rejects.toBeInstanceOf(DecryptError)
  })
})

// ── applyEntryConversions ─────────────────────────────────────────────────────

describe('applyEntryConversions', () => {
  const update = (overrides: Partial<Parameters<typeof applyEntryConversions>[2][number]> = {}) => ({
    id: 'e1',
    amount: 20,
    currency: 'USD' as const,
    createdAt: OCT_14,
    conversion: conv('UAH', 20, 41.52),
    ...overrides,
  })

  it('sets only the conversion field and leaves updatedAt and everything else alone', async () => {
    await seed(OCT_CHUNK, [makeExpense(), makeExpense({ id: 'e2', amount: 3 })])

    const written = await applyEntryConversions(OCT_CHUNK, 'UAH', [update()])

    expect(written).toBe(1)
    const stored = await readRaw<Expense>(OCT_CHUNK)
    expect(stored[0]).toEqual({
      ...makeExpense(),
      conversion: conv('UAH', 20, 41.52),
    })
    expect(stored[0].updatedAt).toBe(OLD)
    expect(stored[1]).toEqual(makeExpense({ id: 'e2', amount: 3 }))
  })

  it('is a derived write: no rev is stamped and the change counter stays', async () => {
    await seed(OCT_CHUNK, [makeExpense()])

    await applyEntryConversions(OCT_CHUNK, 'UAH', [update()])

    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect('rev' in stored).toBe(false)
    expect(await getLocalRev()).toBe(0)
    expect(mockStore.has('meta:sync')).toBe(false)
  })

  it('stores the conversion unrounded', async () => {
    await seed(OCT_CHUNK, [makeExpense({ amount: 1 })])
    const exact = { ...conv('UAH', 1, 1), rate: 33.333333333, mainAmount: 33.333333333 }

    await applyEntryConversions(OCT_CHUNK, 'UAH', [
      update({ amount: 1, conversion: exact }),
    ])

    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion?.mainAmount).toBe(33.333333333)
  })

  it('works on the income key', async () => {
    await seed('income', [makeIncome()])

    const written = await applyEntryConversions('income', 'UAH', [
      update({ id: 'i1', amount: 500, conversion: conv('UAH', 500, 41) }),
    ])

    expect(written).toBe(1)
    const [stored] = await readRaw<IncomeEntry>('income')
    expect(stored.conversion?.mainAmount).toBe(500 * 41)
    expect(stored.updatedAt).toBe(OLD)
  })

  it('never converts a deleted record', async () => {
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'dead', deletedAt: OLD }),
      makeExpense({ id: 'live' }),
    ])

    const written = await applyEntryConversions(OCT_CHUNK, 'UAH', [
      update({ id: 'dead' }),
      update({ id: 'live' }),
    ])

    expect(written).toBe(1)
    const stored = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.find((e) => e.id === 'dead')?.conversion).toBeUndefined()
    expect(stored.find((e) => e.id === 'live')?.conversion).toBeDefined()
  })

  it('skips a record whose amount changed since the rates were fetched', async () => {
    await seed(OCT_CHUNK, [makeExpense({ amount: 25 })])

    const written = await applyEntryConversions(OCT_CHUNK, 'UAH', [update()])

    expect(written).toBe(0)
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion).toBeUndefined()
  })

  it('skips a record whose currency or date changed', async () => {
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'a', currency: 'EUR' }),
      makeExpense({ id: 'b', createdAt: new Date(2026, 9, 14, 13).toISOString() }),
    ])

    const written = await applyEntryConversions(OCT_CHUNK, 'UAH', [
      update({ id: 'a' }),
      update({ id: 'b' }),
    ])

    expect(written).toBe(0)
  })

  it('skips records that no longer exist', async () => {
    await seed(OCT_CHUNK, [makeExpense({ id: 'other' })])

    const written = await applyEntryConversions(OCT_CHUNK, 'UAH', [update()])

    expect(written).toBe(0)
  })

  it('skips a record that is already converted for this main currency', async () => {
    const existing = conv('UAH', 20, 40, 'manual')
    await seed(OCT_CHUNK, [makeExpense({ conversion: existing })])

    const written = await applyEntryConversions(OCT_CHUNK, 'UAH', [update()])

    expect(written).toBe(0)
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion).toEqual(existing)
  })

  it('overwrites a conversion made for a previous main currency', async () => {
    await seed(OCT_CHUNK, [makeExpense({ conversion: conv('EUR', 20, 0.9) })])

    const written = await applyEntryConversions(OCT_CHUNK, 'UAH', [update()])

    expect(written).toBe(1)
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion).toEqual(conv('UAH', 20, 41.52))
  })

  it('writes the matching updates and skips the rest in one call', async () => {
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'a' }),
      makeExpense({ id: 'b', amount: 99 }),
      makeExpense({ id: 'c' }),
    ])

    const written = await applyEntryConversions(OCT_CHUNK, 'UAH', [
      update({ id: 'a' }),
      update({ id: 'b' }),
      update({ id: 'c' }),
    ])

    expect(written).toBe(2)
    const stored = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.map((e) => e.conversion !== undefined)).toEqual([true, false, true])
  })

  it('writes nothing and announces nothing when no update matches', async () => {
    await seed(OCT_CHUNK, [makeExpense({ amount: 25 })])
    const before = mockStore.get(OCT_CHUNK)
    const channel = fakeChannel()
    setSyncChannel(channel)

    const written = await applyEntryConversions(OCT_CHUNK, 'UAH', [update()])

    expect(written).toBe(0)
    expect(mockStore.get(OCT_CHUNK)).toBe(before)
    expect(channel.postMessage).not.toHaveBeenCalled()
    expect(mockStore.has('meta:settings')).toBe(false)
  })

  it('announces the written storage key to other tabs', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    const channel = fakeChannel()
    setSyncChannel(channel)

    await applyEntryConversions(OCT_CHUNK, 'UAH', [update()])

    expect(postedKeys(channel)).toEqual([OCT_CHUNK])
  })

  it('shows up in getAllExpenses as a converted record', async () => {
    await seedCategories()
    await seed(OCT_CHUNK, [makeExpense()])

    await applyEntryConversions(OCT_CHUNK, 'UAH', [update()])

    const [expense] = await getAllExpenses()
    expect(expense.conversion).toEqual(conv('UAH', 20, 41.52))
    expect(expense.category?.name).toBe('Food')
  })
})

// ── convertBudgets ────────────────────────────────────────────────────────────

describe('convertBudgets', () => {
  const budgets = (): Array<BudgetEntry> => [
    { id: 'b-uah', categoryId: 'c1', monthlyLimit: 1000, currency: 'UAH', updatedAt: OLD },
    { id: 'b-usd', categoryId: 'c2', monthlyLimit: 33, currency: 'USD', updatedAt: OLD },
    { id: 'b-eur', categoryId: 'c3', monthlyLimit: 50, currency: 'EUR', updatedAt: OLD },
  ]
  const rates: Record<Currency, number> = { UAH: 1, USD: 41.123456, EUR: 45.5 }
  const rateFor = (from: Currency) => rates[from]

  async function seedBudgets() {
    await seed('categories', [
      { id: 'c1', name: 'Food', icon: null, updatedAt: OLD },
      { id: 'c2', name: 'Fun', icon: null, updatedAt: OLD },
      { id: 'c3', name: 'Rent', icon: null, updatedAt: OLD },
    ])
    await seed('budgets', budgets())
  }

  it('converts budgets in other currencies unrounded and leaves the target-currency one alone', async () => {
    await seedBudgets()

    const converted = await convertBudgets('UAH', rateFor, { setMainCurrency: false })

    expect(converted).toBe(2)
    const stored = await readRaw<BudgetEntry>('budgets')
    const byId = Object.fromEntries(stored.map((b) => [b.id, b]))
    expect(byId['b-uah']).toEqual(budgets()[0])
    expect(byId['b-usd'].monthlyLimit).toBe(33 * 41.123456)
    expect(byId['b-usd'].currency).toBe('UAH')
    expect(byId['b-eur'].monthlyLimit).toBe(50 * 45.5)
    expect(byId['b-eur'].currency).toBe('UAH')
  })

  it('gives converted budgets a new updatedAt', async () => {
    await seedBudgets()

    await convertBudgets('UAH', rateFor, { setMainCurrency: false })

    const stored = await readRaw<BudgetEntry>('budgets')
    expect(stored.find((b) => b.id === 'b-usd')?.updatedAt).not.toBe(OLD)
    expect(stored.find((b) => b.id === 'b-uah')?.updatedAt).toBe(OLD)
  })

  it('the one-time fix pass stamps a rev on each converted budget (and only those) in the same setMany as meta:sync', async () => {
    await seedBudgets()
    ctl.setManyCalls.length = 0

    await convertBudgets('UAH', rateFor, { setMainCurrency: false })

    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual(['budgets', 'meta:sync'])
    const stored = await readRaw<BudgetEntry & { rev?: number }>('budgets')
    const revs = ['b-usd', 'b-eur'].map((id) => stored.find((b) => b.id === id)?.rev)
    expect([...revs].sort()).toEqual([1, 2])
    expect(stored.find((b) => b.id === 'b-uah')?.rev).toBeUndefined()
    expect(await getLocalRev()).toBe(2)
    expect(mockStore.has('syncedSettings')).toBe(false)
    expect(mockStore.has('meta:settings')).toBe(false)
  })

  it('asks for rates only for budgets that need converting', async () => {
    await seedBudgets()
    const rateSpy = vi.fn(rateFor)

    await convertBudgets('UAH', rateSpy, { setMainCurrency: false })

    expect(rateSpy.mock.calls.map((c) => c[0]).sort()).toEqual(['EUR', 'USD'])
  })

  it('converts live budgets only: a deleted budget in another currency stays as it was', async () => {
    await seed('budgets', [
      ...budgets(),
      {
        id: 'b-dead',
        categoryId: 'c4',
        monthlyLimit: 7,
        currency: 'USD',
        updatedAt: OLD,
        deletedAt: OLD,
      },
    ])

    const converted = await convertBudgets('UAH', rateFor, { setMainCurrency: false })

    expect(converted).toBe(2)
    const stored = await readRaw<BudgetEntry>('budgets')
    expect(stored.find((b) => b.id === 'b-dead')).toEqual({
      id: 'b-dead',
      categoryId: 'c4',
      monthlyLimit: 7,
      currency: 'USD',
      updatedAt: OLD,
      deletedAt: OLD,
    })
  })

  it('returns 0 and writes nothing when the stored main currency is not the target and setMainCurrency is false', async () => {
    await seedBudgets()
    setSettings({ mainCurrency: 'EUR' })
    const before = mockStore.get('budgets')

    const converted = await convertBudgets('UAH', rateFor, { setMainCurrency: false })

    expect(converted).toBe(0)
    expect(mockStore.get('budgets')).toBe(before)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('reads the stored main currency from syncedSettings for that check too', async () => {
    await seedBudgets()
    await seed('syncedSettings', {
      id: 'settings',
      mainCurrency: 'EUR',
      fetchExchangeRates: true,
      updatedAt: OLD,
    })
    const before = mockStore.get('budgets')

    const converted = await convertBudgets('UAH', rateFor, { setMainCurrency: false })

    expect(converted).toBe(0)
    expect(mockStore.get('budgets')).toBe(before)
  })

  it('with setMainCurrency writes the converted budgets, the new main currency and meta:sync in one transaction, keeping other settings', async () => {
    await seedBudgets()
    setSettings({ mainCurrency: 'UAH', autoLockMinutes: 5, fetchExchangeRates: true })
    ctl.setManyCalls.length = 0

    const converted = await convertBudgets(
      'EUR',
      (from) => (from === 'EUR' ? 1 : from === 'USD' ? 0.9 : 0.02),
      { setMainCurrency: true },
    )

    expect(converted).toBe(2)
    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual([
      'budgets',
      'meta:settings',
      'meta:sync',
      'syncedSettings',
    ])
    const settings = await readSyncedRaw()
    expect(settings.id).toBe('settings')
    expect(settings.mainCurrency).toBe('EUR')
    expect(settings.fetchExchangeRates).toBe(true)
    // The legacy plaintext fields are gone; the per-device ones stay.
    const plain = mockStore.get('meta:settings') as Record<string, unknown>
    expect('mainCurrency' in plain).toBe(false)
    expect('fetchExchangeRates' in plain).toBe(false)
    expect(plain.autoLockMinutes).toBe(5)
    const stored = await readRaw<BudgetEntry>('budgets')
    expect(stored.every((b) => b.currency === 'EUR')).toBe(true)
    expect(stored.find((b) => b.id === 'b-uah')?.monthlyLimit).toBe(1000 * 0.02)
    expect(stored.find((b) => b.id === 'b-usd')?.monthlyLimit).toBe(33 * 0.9)
    expect(stored.find((b) => b.id === 'b-eur')?.monthlyLimit).toBe(50)
  })

  it('with setMainCurrency stamps updatedAt and a distinct rev on the settings record and on every converted budget', async () => {
    await seedBudgets()
    ctl.setManyCalls.length = 0

    await convertBudgets('EUR', () => 2, { setMainCurrency: true })

    const settings = await readSyncedRaw()
    const stored = await readRaw<BudgetEntry & { rev?: number }>('budgets')
    const budgetRevs = stored
      .filter((b) => b.id !== 'b-eur')
      .map((b) => b.rev)
    expect(budgetRevs).toHaveLength(2)
    expect(typeof settings.rev).toBe('number')
    expect(typeof settings.updatedAt).toBe('string')
    expect(settings.updatedAt).not.toBe(OLD)
    const allRevs = [...budgetRevs, settings.rev as number].sort()
    expect(allRevs).toEqual([1, 2, 3])
    expect(await getLocalRev()).toBe(3)
    expect(stored.find((b) => b.id === 'b-eur')?.rev).toBeUndefined()
  })

  it('with setMainCurrency and no budgets still sets the main currency and announces syncedSettings, not budgets', async () => {
    setSettings({ mainCurrency: 'UAH' })
    const channel = fakeChannel()
    setSyncChannel(channel)

    const converted = await convertBudgets('USD', rateFor, { setMainCurrency: true })

    expect(converted).toBe(0)
    expect((await readSyncedRaw()).mainCurrency).toBe('USD')
    expect((await readSyncedSettings()).mainCurrency).toBe('USD')
    expect(postedKeys(channel)).toContain('syncedSettings')
    expect(postedKeys(channel)).not.toContain('budgets')
  })

  it('announces budgets and syncedSettings after a full change', async () => {
    await seedBudgets()
    const channel = fakeChannel()
    setSyncChannel(channel)

    await convertBudgets('UAH', rateFor, { setMainCurrency: true })

    expect(postedKeys(channel)).toEqual(
      expect.arrayContaining(['budgets', 'syncedSettings']),
    )
  })

  it('writes nothing when rateFor throws', async () => {
    await seedBudgets()
    setSettings({ mainCurrency: 'UAH' })
    const budgetsBefore = mockStore.get('budgets')
    const settingsBefore = mockStore.get('meta:settings')

    await expect(
      convertBudgets(
        'EUR',
        () => {
          throw new Error('no rate')
        },
        { setMainCurrency: true },
      ),
    ).rejects.toThrow('no rate')

    expect(mockStore.get('budgets')).toBe(budgetsBefore)
    expect(mockStore.get('meta:settings')).toBe(settingsBefore)
    expect((mockStore.get('meta:settings') as Record<string, unknown>).mainCurrency).toBe(
      'UAH',
    )
    expect(mockStore.has('syncedSettings')).toBe(false)
    expect(mockStore.has('meta:sync')).toBe(false)
  })

  it('a failed transaction leaves budgets, settings and meta:sync as they were', async () => {
    await seedBudgets()
    setSettings({ mainCurrency: 'UAH', autoLockMinutes: 5 })
    const budgetsBefore = mockStore.get('budgets')
    const settingsBefore = mockStore.get('meta:settings')
    ctl.failSetMany = true

    await expect(
      convertBudgets('EUR', () => 2, { setMainCurrency: true }),
    ).rejects.toThrow('transaction aborted')

    expect(mockStore.get('budgets')).toBe(budgetsBefore)
    expect(mockStore.get('meta:settings')).toBe(settingsBefore)
    expect(mockStore.has('syncedSettings')).toBe(false)
    expect(mockStore.has('meta:sync')).toBe(false)
  })

  it('getAllBudgets reads the converted budgets back', async () => {
    await seedBudgets()

    await convertBudgets('UAH', rateFor, { setMainCurrency: false })

    const read = await getAllBudgets()
    expect(read.map((b) => b.currency)).toEqual(['UAH', 'UAH', 'UAH'])
    expect(read.find((b) => b.categoryName === 'Fun')?.monthlyLimit).toBe(33 * 41.123456)
    expect(read.every((b) => !('rev' in b))).toBe(true)
  })
})

// ── typed seeds stay in sync with the domain types ───────────────────────────

describe('seeded fixtures', () => {
  it('addExpense/addIncome results are readable through the getters with their conversions', async () => {
    await seedCategories()
    await addExpense({ amount: 7, currency: 'UAH', categoryId: 'c1', createdAt: OCT_14 })
    await addIncome({ categoryId: 'ic1', amount: 9, currency: 'UAH', createdAt: OCT_14 })

    const [expense] = await getAllExpenses()
    const [income] = await getAllIncome()
    expect(expense.conversion?.mainAmount).toBe(7)
    expect(income.conversion?.mainAmount).toBe(9)
  })
})
