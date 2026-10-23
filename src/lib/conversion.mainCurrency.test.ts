// No CONTRACT_GAPs: changeMainCurrency, MainCurrencyChangeError,
// getConversionStatus, subscribeConversion and CONVERSION_STATUS_QUERY_KEY are
// fully specified in the Interface Contract (module: conversion) and plan
// sections 5 and 7.
//
// Integration style: the real localDb with a Map-backed idb-keyval, records
// seeded encrypted, an injected provider (id 'nbu', vi.fn getRates). The real
// NBU is never called.
//
// The main currency now lives in the encrypted `syncedSettings` record.
// Seeding the plaintext meta:settings fields still works (legacy fallback);
// after a change the new value is read back from `syncedSettings`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import type {
  BudgetEntry,
  Currency,
  EntryConversion,
  Expense,
  IncomeEntry,
} from '@/lib/domain'
import type { RateProvider, RateTable } from '@/lib/rates/types'
import { decryptValue, encryptValue } from '@/lib/crypto'
import {
  CONVERSION_STATUS_QUERY_KEY,
  MainCurrencyChangeError,
  changeMainCurrency,
  getConversionStatus,
  subscribeConversion,
} from '@/lib/conversion'
import { getLocalRev, unlockLocalDb } from '@/lib/localDb'
import { RateUnavailableError } from '@/lib/rates/types'

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

const at = (y: number, m: number, d: number) =>
  new Date(y, m - 1, d, 12, 0, 0).toISOString()
const OCT_14 = at(2026, 10, 14)
const OCT_CHUNK = 'expenses_2026_10'
const OLD = '2026-01-05T08:00:00.000Z'
const TODAY = '2026-10-15'
const RATES = { UAH: 1, USD: 41.52, EUR: 45.1 }

let dek: CryptoKey

function table(date: string, perBase: RateTable['perBase'] = RATES): RateTable {
  return { base: 'UAH', effectiveDate: date, perBase }
}

type GetRates = (date: string) => Promise<RateTable>

function makeProvider(
  impl?: GetRates,
): RateProvider & { getRates: Mock<GetRates> } {
  return {
    id: 'nbu',
    getRates: vi.fn<GetRates>(impl ?? ((date) => Promise.resolve(table(date)))),
  }
}

function conv(main: Currency, amount: number, rate: number, source = 'nbu'): EntryConversion {
  return {
    mainCurrency: main,
    rate,
    mainAmount: amount * rate,
    rateDate: '2026-10-14',
    source,
  }
}

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'e1',
    amount: 20,
    currency: 'USD',
    categoryId: 'c1',
    description: null,
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
    currency: 'UAH',
    description: null,
    createdAt: OCT_14,
    updatedAt: OLD,
    ...overrides,
  }
}

function makeBudget(overrides: Partial<BudgetEntry> = {}): BudgetEntry {
  return {
    id: 'b1',
    categoryId: 'c1',
    monthlyLimit: 4510,
    currency: 'UAH',
    updatedAt: OLD,
    ...overrides,
  }
}

async function seed(storageKey: string, value: unknown) {
  mockStore.set(storageKey, await encryptValue(dek, value))
}

async function readRaw<T>(storageKey: string): Promise<Array<T>> {
  const raw = mockStore.get(storageKey)
  if (!(raw instanceof Uint8Array)) throw new Error(`nothing under ${storageKey}`)
  return (await decryptValue(dek, raw)) as Array<T>
}

// The synced settings record once it exists, else the legacy plaintext fields.
async function storedCurrencySettings(): Promise<Record<string, unknown>> {
  const raw = mockStore.get('syncedSettings')
  if (raw instanceof Uint8Array) {
    return (await decryptValue(dek, raw)) as Record<string, unknown>
  }
  return (mockStore.get('meta:settings') as Record<string, unknown> | undefined) ?? {}
}

async function storedMain(): Promise<unknown> {
  return (await storedCurrencySettings()).mainCurrency
}

// A realistic mixed vault: main UAH, converted to UAH.
async function seedMixedVault() {
  await seed('categories', [
    { id: 'c1', name: 'Food', icon: null, updatedAt: OLD },
    { id: 'c2', name: 'Fun', icon: null, updatedAt: OLD },
  ])
  await seed(OCT_CHUNK, [
    makeExpense({ id: 'usd', conversion: conv('UAH', 20, 41.52) }),
    makeExpense({
      id: 'uah',
      currency: 'UAH',
      amount: 100,
      conversion: conv('UAH', 100, 1, 'identity'),
    }),
  ])
  await seed('budgets', [
    makeBudget({ id: 'b-uah', categoryId: 'c1', monthlyLimit: 4510 }),
    makeBudget({ id: 'b-usd', categoryId: 'c2', monthlyLimit: 100, currency: 'USD' }),
  ])
  mockStore.set('meta:settings', {
    mainCurrency: 'UAH',
    fetchExchangeRates: true,
    autoLockMinutes: 5,
  })
}

async function snapshotVault() {
  return {
    chunk: mockStore.get(OCT_CHUNK),
    budgets: mockStore.get('budgets'),
    income: mockStore.get('income'),
    main: await storedMain(),
    syncedSettings: mockStore.get('syncedSettings'),
    rev: await getLocalRev(),
  }
}

async function expectRefusal(
  promise: Promise<unknown>,
  code: MainCurrencyChangeError['code'],
  message: string,
) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(MainCurrencyChangeError)
  expect((error as MainCurrencyChangeError).code).toBe(code)
  expect((error as MainCurrencyChangeError).message).toBe(message)
}

beforeEach(async () => {
  mockStore.clear()
  ctl.failSetMany = false
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('changeMainCurrency: the change', () => {
  it('converts the budgets at today’s rate (unrounded), sets the currency and recalculates every entry', async () => {
    await seedMixedVault()
    const provider = makeProvider()

    const result = await changeMainCurrency('EUR', { provider, today: TODAY })

    expect(provider.getRates).toHaveBeenCalledWith(TODAY)
    expect(await storedMain()).toBe('EUR')

    const budgets = await readRaw<BudgetEntry>('budgets')
    expect(budgets.every((b) => b.currency === 'EUR')).toBe(true)
    const fromUah = budgets.find((b) => b.id === 'b-uah')?.monthlyLimit ?? 0
    const fromUsd = budgets.find((b) => b.id === 'b-usd')?.monthlyLimit ?? 0
    expect(fromUah).toBeCloseTo(4510 * (1 / 45.1), 10)
    expect(fromUsd).toBeCloseTo(100 * (41.52 / 45.1), 10)
    expect(fromUsd).not.toBe(Math.round(fromUsd * 100) / 100)

    const expenses = await readRaw<Expense>(OCT_CHUNK)
    const usd = expenses.find((e) => e.id === 'usd')
    const uah = expenses.find((e) => e.id === 'uah')
    expect(usd?.conversion?.mainCurrency).toBe('EUR')
    expect(usd?.conversion?.rate).toBeCloseTo(41.52 / 45.1, 12)
    expect(usd?.conversion?.mainAmount).toBeCloseTo(20 * (41.52 / 45.1), 10)
    expect(uah?.conversion?.mainCurrency).toBe('EUR')
    expect(uah?.conversion?.rate).toBeCloseTo(1 / 45.1, 12)

    expect(result.converted).toBe(2)
    expect(result.stillPending).toBe(0)
    expect(result.budgetsConverted).toBe(2)
    expect(result.rateDate).toBe(TODAY)
  })

  it('writes the new currency into syncedSettings and strips it from the plaintext settings', async () => {
    await seedMixedVault()

    await changeMainCurrency('EUR', { provider: makeProvider(), today: TODAY })

    const synced = await storedCurrencySettings()
    expect(synced.id).toBe('settings')
    expect(synced.mainCurrency).toBe('EUR')
    expect(synced.fetchExchangeRates).toBe(true)
    const plain = mockStore.get('meta:settings') as Record<string, unknown>
    expect('mainCurrency' in plain).toBe(false)
    expect('fetchExchangeRates' in plain).toBe(false)
  })

  it('keeps the other settings', async () => {
    await seedMixedVault()

    await changeMainCurrency('EUR', { provider: makeProvider(), today: TODAY })

    const settings = mockStore.get('meta:settings') as Record<string, unknown>
    expect(settings.autoLockMinutes).toBe(5)
    expect((await storedCurrencySettings()).fetchExchangeRates).toBe(true)
  })

  it('bumps updatedAt and rev on the settings record and on every converted budget, and on nothing else', async () => {
    await seedMixedVault()
    const revBefore = await getLocalRev()

    await changeMainCurrency('EUR', { provider: makeProvider(), today: TODAY })

    const synced = await storedCurrencySettings()
    const budgets = await readRaw<BudgetEntry & { rev?: number }>('budgets')
    expect(typeof synced.rev).toBe('number')
    expect(synced.updatedAt).not.toBe(OLD)
    const revs = [synced.rev as number, ...budgets.map((b) => b.rev as number)]
    expect(new Set(revs).size).toBe(3)
    expect([...revs].sort((a, b) => a - b)).toEqual([
      revBefore + 1,
      revBefore + 2,
      revBefore + 3,
    ])
    expect(budgets.every((b) => b.updatedAt !== OLD)).toBe(true)
    // The entries were only recalculated: no rev, updatedAt untouched.
    const expenses = await readRaw<Expense & { rev?: number }>(OCT_CHUNK)
    for (const e of expenses) {
      expect(e.rev).toBeUndefined()
      expect(e.updatedAt).toBe(OLD)
    }
    expect(await getLocalRev()).toBe(revBefore + 3)
  })

  it('treats all entries as pending first: progress starts at 0 of all entries', async () => {
    await seedMixedVault()
    const onProgress = vi.fn()

    await changeMainCurrency('EUR', {
      provider: makeProvider(),
      today: TODAY,
      onProgress,
    })

    expect(onProgress.mock.calls[0][0]).toEqual({ done: 0, total: 2 })
    const last = onProgress.mock.calls[onProgress.mock.calls.length - 1][0]
    expect(last).toEqual({ done: 2, total: 2 })
  })

  it('gives entries already in the new main currency the identity conversion', async () => {
    await seedMixedVault()
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'eur', currency: 'EUR', amount: 7, conversion: conv('UAH', 7, 45.1) }),
    ])

    await changeMainCurrency('EUR', { provider: makeProvider(), today: TODAY })

    const [eur] = await readRaw<Expense>(OCT_CHUNK)
    expect(eur.conversion).toMatchObject({
      mainCurrency: 'EUR',
      rate: 1,
      mainAmount: 7,
      source: 'identity',
    })
  })

  it('a manual rate for the old main currency no longer applies; the provider rate is used', async () => {
    await seedMixedVault()
    await seed(OCT_CHUNK, [
      makeExpense({
        id: 'manual',
        manualRate: { mainCurrency: 'UAH', rate: 40 },
        conversion: conv('UAH', 20, 40, 'manual'),
      }),
    ])

    await changeMainCurrency('EUR', { provider: makeProvider(), today: TODAY })

    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion?.source).toBe('nbu')
    expect(stored.conversion?.mainCurrency).toBe('EUR')
    expect(stored.conversion?.rate).toBeCloseTo(41.52 / 45.1, 12)
  })

  it('reports entries it could not convert as still pending, after the budgets were converted', async () => {
    await seedMixedVault()
    const provider = makeProvider((date) =>
      date === '2026-10-14'
        ? Promise.reject(new RateUnavailableError('no rates'))
        : Promise.resolve(table(date)),
    )

    const result = await changeMainCurrency('EUR', { provider, today: TODAY })

    expect(await storedMain()).toBe('EUR')
    expect(result.budgetsConverted).toBe(2)
    expect(result.converted).toBe(0)
    expect(result.stillPending).toBe(2)
    const expenses = await readRaw<Expense>(OCT_CHUNK)
    expect(expenses.every((e) => e.conversion?.mainCurrency === 'UAH')).toBe(true)
  })

  it('changing to the current main currency does nothing', async () => {
    await seedMixedVault()
    const provider = makeProvider()
    const before = await snapshotVault()

    const result = await changeMainCurrency('UAH', { provider, today: TODAY })

    expect(result).toEqual({
      converted: 0,
      stillPending: 0,
      budgetsConverted: 0,
      rateDate: null,
    })
    expect(provider.getRates).not.toHaveBeenCalled()
    expect(await snapshotVault()).toEqual(before)
  })

  it('changing to the main currency stored in syncedSettings does nothing either', async () => {
    await seedMixedVault()
    await seed('syncedSettings', {
      id: 'settings',
      mainCurrency: 'EUR',
      fetchExchangeRates: true,
      updatedAt: OLD,
    })
    const provider = makeProvider()

    const result = await changeMainCurrency('EUR', { provider, today: TODAY })

    expect(result.rateDate).toBeNull()
    expect(provider.getRates).not.toHaveBeenCalled()
  })

  it('notifies subscribers about the committed change', async () => {
    await seedMixedVault()
    const listener = vi.fn()
    const stop = subscribeConversion(listener)

    await changeMainCurrency('EUR', { provider: makeProvider(), today: TODAY })
    stop()

    expect(listener).toHaveBeenCalled()
  })

  it('a change back to the first currency converts everything again', async () => {
    await seedMixedVault()
    const provider = makeProvider()
    await changeMainCurrency('EUR', { provider, today: TODAY })

    const back = await changeMainCurrency('UAH', { provider, today: TODAY })

    expect(await storedMain()).toBe('UAH')
    expect(back.converted).toBe(2)
    const expenses = await readRaw<Expense>(OCT_CHUNK)
    expect(expenses.every((e) => e.conversion?.mainCurrency === 'UAH')).toBe(true)
  })

  it('a failed transaction changes neither the budgets, the settings nor the change counter', async () => {
    await seedMixedVault()
    const before = await snapshotVault()
    const settingsBefore = mockStore.get('meta:settings')
    ctl.failSetMany = true

    await expect(
      changeMainCurrency('EUR', { provider: makeProvider(), today: TODAY }),
    ).rejects.toThrow('transaction aborted')

    expect(await snapshotVault()).toEqual(before)
    expect(mockStore.get('meta:settings')).toBe(settingsBefore)
    expect(mockStore.has('syncedSettings')).toBe(false)
  })
})

describe('changeMainCurrency: refusals change nothing', () => {
  it('refuses while offline', async () => {
    await seedMixedVault()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const provider = makeProvider()
    const before = await snapshotVault()

    await expectRefusal(
      changeMainCurrency('EUR', { provider, today: TODAY }),
      'offline',
      "You're offline. Connect to the internet to change the main currency.",
    )

    expect(provider.getRates).not.toHaveBeenCalled()
    expect(await snapshotVault()).toEqual(before)
  })

  it('refuses when exchange rates are off', async () => {
    await seedMixedVault()
    mockStore.set('meta:settings', { mainCurrency: 'UAH', fetchExchangeRates: false })
    const provider = makeProvider()
    const before = await snapshotVault()

    await expectRefusal(
      changeMainCurrency('EUR', { provider, today: TODAY }),
      'rates-off',
      'Turn on exchange rates from the National Bank of Ukraine to change the main currency.',
    )

    expect(provider.getRates).not.toHaveBeenCalled()
    expect(await snapshotVault()).toEqual(before)
  })

  it('refuses when exchange rates are off in syncedSettings', async () => {
    await seedMixedVault()
    await seed('syncedSettings', {
      id: 'settings',
      mainCurrency: 'UAH',
      fetchExchangeRates: false,
      updatedAt: OLD,
    })
    const provider = makeProvider()
    const before = await snapshotVault()

    await expectRefusal(
      changeMainCurrency('EUR', { provider, today: TODAY }),
      'rates-off',
      'Turn on exchange rates from the National Bank of Ukraine to change the main currency.',
    )

    expect(await snapshotVault()).toEqual(before)
  })

  it('reports offline before rates-off when both apply', async () => {
    await seedMixedVault()
    mockStore.set('meta:settings', { mainCurrency: 'UAH', fetchExchangeRates: false })
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

    await expectRefusal(
      changeMainCurrency('EUR', { provider: makeProvider(), today: TODAY }),
      'offline',
      "You're offline. Connect to the internet to change the main currency.",
    )
  })

  it('refuses when today’s rates cannot be fetched', async () => {
    await seedMixedVault()
    const provider = makeProvider(() =>
      Promise.reject(new RateUnavailableError('no rates')),
    )
    const before = await snapshotVault()

    await expectRefusal(
      changeMainCurrency('EUR', { provider, today: TODAY }),
      'rates-unavailable',
      "Couldn't get today's exchange rates from the National Bank of Ukraine. Try again later.",
    )

    expect(await snapshotVault()).toEqual(before)
  })

  it('refuses when today’s table lacks the currency of a budget', async () => {
    await seedMixedVault()
    const provider = makeProvider((date) =>
      Promise.resolve(table(date, { UAH: 1, EUR: 45.1 })),
    )
    const before = await snapshotVault()

    await expectRefusal(
      changeMainCurrency('EUR', { provider, today: TODAY }),
      'rates-unavailable',
      "Couldn't get today's exchange rates from the National Bank of Ukraine. Try again later.",
    )

    expect(await snapshotVault()).toEqual(before)
  })
})

describe('changeMainCurrency: when nothing needs a rate', () => {
  it('changes an empty vault while offline', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'UAH', fetchExchangeRates: true })
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const provider = makeProvider()

    const result = await changeMainCurrency('EUR', { provider, today: TODAY })

    expect(await storedMain()).toBe('EUR')
    expect(result.budgetsConverted).toBe(0)
    expect(provider.getRates).not.toHaveBeenCalled()
  })

  it('changes to the currency every entry is already in, with rates off, using identity', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'UAH', fetchExchangeRates: false })
    await seed(OCT_CHUNK, [
      makeExpense({ currency: 'EUR', amount: 12, conversion: conv('UAH', 12, 45.1) }),
    ])
    const provider = makeProvider()

    const result = await changeMainCurrency('EUR', { provider, today: TODAY })

    expect(await storedMain()).toBe('EUR')
    expect(result.converted).toBe(1)
    expect(result.stillPending).toBe(0)
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion).toMatchObject({ mainCurrency: 'EUR', source: 'identity', mainAmount: 12 })
    expect(provider.getRates).not.toHaveBeenCalled()
  })

  it('changes with rates off when every foreign entry has a manual rate for the new main currency', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'UAH', fetchExchangeRates: false })
    await seed(OCT_CHUNK, [
      makeExpense({ manualRate: { mainCurrency: 'EUR', rate: 0.9 } }),
    ])
    const provider = makeProvider()

    const result = await changeMainCurrency('EUR', { provider, today: TODAY })

    expect(await storedMain()).toBe('EUR')
    expect(result.converted).toBe(1)
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion).toMatchObject({ source: 'manual', rate: 0.9, mainAmount: 20 * 0.9 })
  })

  it('keeps the exchange-rates switch the user had when only the currency changes', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'UAH', fetchExchangeRates: false })
    await seed(OCT_CHUNK, [
      makeExpense({ currency: 'EUR', amount: 12, conversion: conv('UAH', 12, 45.1) }),
    ])

    await changeMainCurrency('EUR', { provider: makeProvider(), today: TODAY })

    expect((await storedCurrencySettings()).fetchExchangeRates).toBe(false)
  })

  it('does not count a deleted entry when it decides whether a rate is needed', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'UAH', fetchExchangeRates: false })
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'eur', currency: 'EUR', amount: 12, conversion: conv('UAH', 12, 45.1) }),
      makeExpense({ id: 'dead', currency: 'USD', deletedAt: OLD }),
    ])
    const provider = makeProvider()

    // The only USD entry is deleted, so no rate is needed (rates are off).
    const result = await changeMainCurrency('EUR', { provider, today: TODAY })

    expect(await storedMain()).toBe('EUR')
    expect(result.stillPending).toBe(0)
    expect(provider.getRates).not.toHaveBeenCalled()
  })

  it('still refuses offline when one foreign entry has no manual rate', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'UAH', fetchExchangeRates: true })
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'manual', manualRate: { mainCurrency: 'EUR', rate: 0.9 } }),
      makeExpense({ id: 'plain' }),
    ])
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

    await expectRefusal(
      changeMainCurrency('EUR', { provider: makeProvider(), today: TODAY }),
      'offline',
      "You're offline. Connect to the internet to change the main currency.",
    )
    expect(await storedMain()).toBe('UAH')
  })
})

describe('getConversionStatus', () => {
  it('has the documented query key', () => {
    expect([...CONVERSION_STATUS_QUERY_KEY]).toEqual(['conversion-status'])
  })

  it('reports zeros and the defaults for an empty vault', async () => {
    expect(await getConversionStatus()).toEqual({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
      totalEntries: 0,
      pendingEntries: 0,
      pendingBudgets: 0,
    })
  })

  it('counts entries without a usable main amount as pending, and budgets in other currencies', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'UAH', fetchExchangeRates: false })
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'uah-plain', currency: 'UAH', amount: 100 }), // implicit identity
      makeExpense({ id: 'usd-pending' }), // pending
      makeExpense({ id: 'usd-done', conversion: conv('UAH', 20, 41.52) }),
    ])
    await seed('income', [
      makeIncome({ id: 'eur-stale', currency: 'EUR', conversion: conv('USD', 500, 1.1) }), // pending
    ])
    await seed('budgets', [
      makeBudget({ id: 'b1' }),
      makeBudget({ id: 'b2', categoryId: 'c2', currency: 'USD' }),
    ])

    expect(await getConversionStatus()).toEqual({
      mainCurrency: 'UAH',
      fetchExchangeRates: false,
      totalEntries: 4,
      pendingEntries: 2,
      pendingBudgets: 1,
    })
  })

  it('judges pending against the stored main currency', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'EUR' })
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'uah', currency: 'UAH', conversion: conv('UAH', 100, 1, 'identity') }),
      makeExpense({ id: 'eur', currency: 'EUR' }),
    ])

    const status = await getConversionStatus()

    expect(status.mainCurrency).toBe('EUR')
    expect(status.totalEntries).toBe(2)
    expect(status.pendingEntries).toBe(1)
  })

  it('reads the currency settings from syncedSettings', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'USD', fetchExchangeRates: true })
    await seed('syncedSettings', {
      id: 'settings',
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
      updatedAt: OLD,
    })
    await seed(OCT_CHUNK, [makeExpense({ id: 'usd' })])

    const status = await getConversionStatus()

    expect(status.mainCurrency).toBe('EUR')
    expect(status.fetchExchangeRates).toBe(false)
    expect(status.pendingEntries).toBe(1)
  })
})
