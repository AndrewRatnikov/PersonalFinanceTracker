// No CONTRACT_GAPs: convertPending, ConvertOptions / ConvertResult and the
// localDb conversion helpers are fully specified in the Interface Contract
// (module: conversion).
//
// Integration style (as localDb.concurrency.test.ts): the real localDb with a
// Map-backed idb-keyval, records seeded encrypted. Every run gets an injected
// provider (an object with id 'nbu' and a vi.fn getRates); the real NBU is
// never called.

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
import { convertPending } from '@/lib/conversion'
import {
  DecryptError,
  unlockLocalDb,
  updateExpense,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { RateUnavailableError } from '@/lib/rates/types'

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

const at = (y: number, m: number, d: number) =>
  new Date(y, m - 1, d, 12, 0, 0).toISOString()
const OCT_14 = at(2026, 10, 14)
const OCT_13 = at(2026, 10, 13)
const OCT_12 = at(2026, 10, 12)
const SEP_20 = at(2026, 9, 20)
const OCT_CHUNK = 'expenses_2026_10'
const SEP_CHUNK = 'expenses_2026_09'
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
    currency: 'EUR',
    description: null,
    createdAt: OCT_14,
    updatedAt: OLD,
    ...overrides,
  }
}

function conv(mainCurrency: Currency, amount: number, rate: number): EntryConversion {
  return {
    mainCurrency,
    rate,
    mainAmount: amount * rate,
    rateDate: '2026-10-14',
    source: 'nbu',
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

function setSettings(settings: Record<string, unknown>) {
  mockStore.set('meta:settings', settings)
}

beforeEach(async () => {
  mockStore.clear()
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('convertPending: the happy path', () => {
  it('converts a 20 USD expense of 2026-10-14 with the NBU rate for that day', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    const provider = makeProvider()

    const result = await convertPending({ provider, today: TODAY })

    expect(result).toEqual({ converted: 1, stillPending: 0 })
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion).toEqual({
      mainCurrency: 'UAH',
      rate: 41.52,
      mainAmount: 20 * 41.52,
      rateDate: '2026-10-14',
      source: 'nbu',
    })
    expect(stored.conversion?.mainAmount).toBeCloseTo(830.4, 8)
    expect(provider.getRates).toHaveBeenCalledWith('2026-10-14')
  })

  it('gives a 100 UAH expense the identity conversion without any fetch', async () => {
    await seed(OCT_CHUNK, [makeExpense({ currency: 'UAH', amount: 100 })])
    const provider = makeProvider()

    const result = await convertPending({ provider, today: TODAY })

    expect(result).toEqual({ converted: 1, stillPending: 0 })
    expect(provider.getRates).not.toHaveBeenCalled()
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion).toEqual({
      mainCurrency: 'UAH',
      rate: 1,
      mainAmount: 100,
      rateDate: '2026-10-14',
      source: 'identity',
    })
  })

  it('converts a mix of income and expenses, using the right cross rate per currency', async () => {
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'usd' }),
      makeExpense({ id: 'eur', currency: 'EUR', amount: 10 }),
    ])
    await seed('income', [makeIncome()])
    const provider = makeProvider()

    const result = await convertPending({ provider, today: TODAY })

    expect(result).toEqual({ converted: 3, stillPending: 0 })
    const expenses = await readRaw<Expense>(OCT_CHUNK)
    expect(expenses.find((e) => e.id === 'usd')?.conversion?.rate).toBe(41.52)
    expect(expenses.find((e) => e.id === 'eur')?.conversion?.rate).toBe(45.1)
    expect(expenses.find((e) => e.id === 'eur')?.conversion?.mainAmount).toBe(10 * 45.1)
    const [income] = await readRaw<IncomeEntry>('income')
    expect(income.conversion?.mainAmount).toBe(500 * 45.1)
  })

  it('stores the amount × rate unrounded', async () => {
    await seed(OCT_CHUNK, [makeExpense({ amount: 1 })])
    const provider = makeProvider((date) =>
      Promise.resolve(table(date, { UAH: 1, USD: 33.333333333, EUR: 45.1 })),
    )

    await convertPending({ provider, today: TODAY })

    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion?.mainAmount).toBe(33.333333333)
  })

  it('reports the date the provider actually used as rateDate', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    const provider = makeProvider(() => Promise.resolve(table('2026-10-12')))

    await convertPending({ provider, today: TODAY })

    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion?.rateDate).toBe('2026-10-12')
  })

  it('uses the provider id as the source', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    const provider = { ...makeProvider(), id: 'other' }

    await convertPending({ provider, today: TODAY })

    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion?.source).toBe('other')
  })

  it('does not touch updatedAt, the description or the other fields', async () => {
    const original = makeExpense({ description: 'Lunch' })
    await seed(OCT_CHUNK, [original])

    await convertPending({ provider: makeProvider(), today: TODAY })

    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    const { conversion, ...rest } = stored
    expect(conversion).toBeDefined()
    expect(rest).toEqual(original)
  })

  it('converts into the stored main currency (cross rates), identity for its own entries', async () => {
    setSettings({ mainCurrency: 'EUR' })
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'usd' }),
      makeExpense({ id: 'uah', currency: 'UAH', amount: 100 }),
      makeExpense({ id: 'eur', currency: 'EUR', amount: 7 }),
    ])

    const result = await convertPending({ provider: makeProvider(), today: TODAY })

    expect(result).toEqual({ converted: 3, stillPending: 0 })
    const stored = await readRaw<Expense>(OCT_CHUNK)
    const by = (id: string) => stored.find((e) => e.id === id)?.conversion
    expect(by('usd')?.mainCurrency).toBe('EUR')
    expect(by('usd')?.rate).toBeCloseTo(41.52 / 45.1, 12)
    expect(by('usd')?.mainAmount).toBeCloseTo(20 * (41.52 / 45.1), 10)
    expect(by('uah')?.rate).toBeCloseTo(1 / 45.1, 12)
    expect(by('eur')).toMatchObject({ rate: 1, mainAmount: 7, source: 'identity' })
  })
})

describe('convertPending: idempotent and cheap', () => {
  it('a second run makes no fetch and no write', async () => {
    await seed(OCT_CHUNK, [
      makeExpense(),
      makeExpense({ id: 'e2', currency: 'UAH', amount: 5 }),
    ])
    await seed('income', [makeIncome()])
    const provider = makeProvider()
    await convertPending({ provider, today: TODAY })
    const callsAfterFirst = provider.getRates.mock.calls.length
    const chunkBefore = mockStore.get(OCT_CHUNK)
    const incomeBefore = mockStore.get('income')

    const second = await convertPending({ provider, today: TODAY })

    expect(second).toEqual({ converted: 0, stillPending: 0 })
    expect(provider.getRates.mock.calls.length).toBe(callsAfterFirst)
    expect(mockStore.get(OCT_CHUNK)).toBe(chunkBefore)
    expect(mockStore.get('income')).toBe(incomeBefore)
  })

  it('records on 3 distinct dates cause exactly 3 fetches (one per date)', async () => {
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'a', createdAt: OCT_14 }),
      makeExpense({ id: 'b', createdAt: OCT_14, amount: 3 }),
      makeExpense({ id: 'c', createdAt: OCT_13 }),
      makeExpense({ id: 'd', createdAt: OCT_12 }),
    ])
    const provider = makeProvider()

    const result = await convertPending({ provider, today: TODAY })

    expect(result.converted).toBe(4)
    expect(provider.getRates).toHaveBeenCalledTimes(3)
    expect(provider.getRates.mock.calls.map((c) => c[0]).sort()).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
    ])
  })

  it('shares one fetch per date across the expense chunks and income', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    await seed('income', [makeIncome()])
    const provider = makeProvider()

    await convertPending({ provider, today: TODAY })

    expect(provider.getRates).toHaveBeenCalledTimes(1)
  })

  it('does not keep rates between runs (the cache lives for one run)', async () => {
    await seed(OCT_CHUNK, [makeExpense({ id: 'a' })])
    const provider = makeProvider()
    await convertPending({ provider, today: TODAY })
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'a' }),
      makeExpense({ id: 'b', amount: 9 }),
    ])

    await convertPending({ provider, today: TODAY })

    expect(provider.getRates).toHaveBeenCalledTimes(2)
  })

  it('reconverts an entry whose stored conversion is for a previous main currency', async () => {
    await seed(OCT_CHUNK, [makeExpense({ conversion: conv('EUR', 20, 0.9) })])
    const provider = makeProvider()

    const result = await convertPending({ provider, today: TODAY })

    expect(result.converted).toBe(1)
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion?.mainCurrency).toBe('UAH')
    expect(stored.conversion?.rate).toBe(41.52)
  })
})

describe('convertPending: rates off, offline, manual rates', () => {
  it('with fetchExchangeRates false makes zero fetches and leaves non-main entries pending', async () => {
    setSettings({ mainCurrency: 'UAH', fetchExchangeRates: false })
    await seed(OCT_CHUNK, [
      makeExpense(),
      makeExpense({ id: 'uah', currency: 'UAH', amount: 100 }),
    ])
    const provider = makeProvider()

    const result = await convertPending({ provider, today: TODAY })

    expect(provider.getRates).not.toHaveBeenCalled()
    expect(result).toEqual({ converted: 1, stillPending: 1 })
    const stored = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.find((e) => e.id === 'e1')?.conversion).toBeUndefined()
    expect(stored.find((e) => e.id === 'uah')?.conversion?.source).toBe('identity')
  })

  it('while offline makes no fetch and leaves non-main entries pending', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await seed(OCT_CHUNK, [
      makeExpense(),
      makeExpense({ id: 'uah', currency: 'UAH', amount: 100 }),
    ])
    const provider = makeProvider()

    const result = await convertPending({ provider, today: TODAY })

    expect(provider.getRates).not.toHaveBeenCalled()
    expect(result).toEqual({ converted: 1, stillPending: 1 })
  })

  it('uses a manualRate for the current main currency, with source manual and no fetch', async () => {
    await seed(OCT_CHUNK, [
      makeExpense({ manualRate: { mainCurrency: 'UAH', rate: 40 } }),
    ])
    const provider = makeProvider()

    const result = await convertPending({ provider, today: TODAY })

    expect(result).toEqual({ converted: 1, stillPending: 0 })
    expect(provider.getRates).not.toHaveBeenCalled()
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion).toEqual({
      mainCurrency: 'UAH',
      rate: 40,
      mainAmount: 800,
      rateDate: '2026-10-14',
      source: 'manual',
    })
    expect(stored.manualRate).toEqual({ mainCurrency: 'UAH', rate: 40 })
  })

  it('applies a manualRate even when exchange rates are off', async () => {
    setSettings({ fetchExchangeRates: false })
    await seed('income', [
      makeIncome({ manualRate: { mainCurrency: 'UAH', rate: 39 } }),
    ])

    const result = await convertPending({ provider: makeProvider(), today: TODAY })

    expect(result.converted).toBe(1)
    const [stored] = await readRaw<IncomeEntry>('income')
    expect(stored.conversion?.mainAmount).toBe(500 * 39)
  })

  it('ignores a manualRate made for another main currency and uses the provider', async () => {
    await seed(OCT_CHUNK, [
      makeExpense({ manualRate: { mainCurrency: 'EUR', rate: 0.9 } }),
    ])
    const provider = makeProvider()

    await convertPending({ provider, today: TODAY })

    expect(provider.getRates).toHaveBeenCalledTimes(1)
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion?.source).toBe('nbu')
    expect(stored.conversion?.rate).toBe(41.52)
  })
})

describe('convertPending: failures never throw', () => {
  it('leaves records pending when the provider rejects with RateUnavailableError', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    const provider = makeProvider(() =>
      Promise.reject(new RateUnavailableError('no rates')),
    )

    const result = await convertPending({ provider, today: TODAY })

    expect(result).toEqual({ converted: 0, stillPending: 1 })
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion).toBeUndefined()
  })

  it('leaves records pending on any other provider error', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    const provider = makeProvider(() => Promise.reject(new TypeError('offline')))

    await expect(convertPending({ provider, today: TODAY })).resolves.toEqual({
      converted: 0,
      stillPending: 1,
    })
  })

  it('converts the dates that have rates and leaves only the failing date pending', async () => {
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'good', createdAt: OCT_14 }),
      makeExpense({ id: 'bad', createdAt: OCT_13 }),
    ])
    const provider = makeProvider((date) =>
      date === '2026-10-13'
        ? Promise.reject(new RateUnavailableError('no rates'))
        : Promise.resolve(table(date)),
    )

    const result = await convertPending({ provider, today: TODAY })

    expect(result).toEqual({ converted: 1, stillPending: 1 })
    const stored = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.find((e) => e.id === 'good')?.conversion).toBeDefined()
    expect(stored.find((e) => e.id === 'bad')?.conversion).toBeUndefined()
  })

  it('leaves a record pending when the table lacks its currency', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    const provider = makeProvider((date) =>
      Promise.resolve(table(date, { UAH: 1, EUR: 45.1 })),
    )

    const result = await convertPending({ provider, today: TODAY })

    expect(result).toEqual({ converted: 0, stillPending: 1 })
  })

  it('a later run converts what an earlier failed run left pending', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    await convertPending({
      provider: makeProvider(() => Promise.reject(new Error('down'))),
      today: TODAY,
    })

    const result = await convertPending({ provider: makeProvider(), today: TODAY })

    expect(result).toEqual({ converted: 1, stillPending: 0 })
  })

  it('propagates a DecryptError for an unreadable chunk', async () => {
    mockStore.set(OCT_CHUNK, new Uint8Array(40))

    await expect(
      convertPending({ provider: makeProvider(), today: TODAY }),
    ).rejects.toBeInstanceOf(DecryptError)
  })

  it('does nothing while the vault is locked', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    const provider = makeProvider()
    wipeLocalDbKey()

    const result = await convertPending({ provider, today: TODAY })

    expect(result).toEqual({ converted: 0, stillPending: 0 })
    expect(provider.getRates).not.toHaveBeenCalled()
  })
})

describe('convertPending: edits during a run', () => {
  it('does not overwrite an expense edited between the fetch and the write, and leaves it pending', async () => {
    await seed('categories', [{ id: 'c1', name: 'Food', icon: null, updatedAt: OLD }])
    await seed(OCT_CHUNK, [makeExpense({ amount: 20 })])
    const provider = makeProvider(async (date) => {
      await updateExpense('e1', OCT_14, { amount: 25 })
      return table(date)
    })

    const result = await convertPending({ provider, today: TODAY })

    expect(result).toEqual({ converted: 0, stillPending: 1 })
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.amount).toBe(25)
    expect(stored.conversion).toBeUndefined()
  })

  it('the next run converts the edited record with its new amount', async () => {
    await seed('categories', [{ id: 'c1', name: 'Food', icon: null, updatedAt: OLD }])
    await seed(OCT_CHUNK, [makeExpense({ amount: 20 })])
    await convertPending({
      provider: makeProvider(async (date) => {
        await updateExpense('e1', OCT_14, { amount: 25 })
        return table(date)
      }),
      today: TODAY,
    })

    const result = await convertPending({ provider: makeProvider(), today: TODAY })

    expect(result.converted).toBe(1)
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion?.mainAmount).toBe(25 * 41.52)
  })

  it('keeps the other records of the chunk converted when only one was edited', async () => {
    await seed('categories', [{ id: 'c1', name: 'Food', icon: null, updatedAt: OLD }])
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'edited', amount: 20 }),
      makeExpense({ id: 'untouched', amount: 8 }),
    ])
    const provider = makeProvider(async (date) => {
      await updateExpense('edited', OCT_14, { amount: 21 })
      return table(date)
    })

    const result = await convertPending({ provider, today: TODAY })

    expect(result).toEqual({ converted: 1, stillPending: 1 })
    const stored = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.find((e) => e.id === 'edited')?.conversion).toBeUndefined()
    expect(stored.find((e) => e.id === 'untouched')?.conversion?.mainAmount).toBe(
      8 * 41.52,
    )
  })
})

describe('convertPending: progress and abort', () => {
  it('reports progress per group with the pending total', async () => {
    await seed(SEP_CHUNK, [makeExpense({ id: 's', createdAt: SEP_20 })])
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'o1' }),
      makeExpense({ id: 'o2', amount: 4 }),
    ])
    const onProgress = vi.fn()

    await convertPending({ provider: makeProvider(), today: TODAY, onProgress })

    const calls = onProgress.mock.calls.map((c) => c[0] as { done: number; total: number })
    expect(calls[0]).toEqual({ done: 0, total: 3 })
    expect(calls[calls.length - 1]).toEqual({ done: 3, total: 3 })
    expect(calls.every((p) => p.total === 3)).toBe(true)
    const dones = calls.map((p) => p.done)
    expect([...dones].sort((a, b) => a - b)).toEqual(dones)
  })

  it('does not count records that are already converted in the total', async () => {
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'done', conversion: conv('UAH', 20, 41.52) }),
      makeExpense({ id: 'todo' }),
    ])
    const onProgress = vi.fn()

    await convertPending({ provider: makeProvider(), today: TODAY, onProgress })

    expect(onProgress.mock.calls[0][0]).toEqual({ done: 0, total: 1 })
  })

  it('stops after the first chunk when aborted, and the next run converts only the rest', async () => {
    await seed(SEP_CHUNK, [makeExpense({ id: 'sep', createdAt: SEP_20 })])
    await seed(OCT_CHUNK, [makeExpense({ id: 'oct' })])
    const controller = new AbortController()
    const first = makeProvider()

    const aborted = await convertPending({
      provider: first,
      today: TODAY,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.done >= 1) controller.abort()
      },
    })

    expect(aborted).toEqual({ converted: 1, stillPending: 1 })
    expect((await readRaw<Expense>(SEP_CHUNK))[0].conversion).toBeDefined()
    expect((await readRaw<Expense>(OCT_CHUNK))[0].conversion).toBeUndefined()
    expect(first.getRates.mock.calls.map((c) => c[0])).toEqual(['2026-09-20'])

    const second = makeProvider()
    const resumed = await convertPending({ provider: second, today: TODAY })

    expect(resumed).toEqual({ converted: 1, stillPending: 0 })
    expect(second.getRates.mock.calls.map((c) => c[0])).toEqual(['2026-10-14'])
  })

  it('does nothing when the signal is already aborted', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    const controller = new AbortController()
    controller.abort()
    const provider = makeProvider()

    const result = await convertPending({
      provider,
      today: TODAY,
      signal: controller.signal,
    })

    expect(result.converted).toBe(0)
    expect(provider.getRates).not.toHaveBeenCalled()
    expect((await readRaw<Expense>(OCT_CHUNK))[0].conversion).toBeUndefined()
  })
})

describe('convertPending: the one-time budget fix', () => {
  const budget = (overrides: Partial<BudgetEntry> = {}): BudgetEntry => ({
    id: 'b1',
    categoryId: 'c1',
    monthlyLimit: 10,
    currency: 'USD',
    updatedAt: OLD,
    ...overrides,
  })

  it('converts a budget in another currency at today’s rate, unrounded', async () => {
    await seed('budgets', [budget(), budget({ id: 'b2', categoryId: 'c2', currency: 'UAH', monthlyLimit: 500 })])
    const provider = makeProvider()

    await convertPending({ provider, today: TODAY })

    expect(provider.getRates).toHaveBeenCalledWith(TODAY)
    const stored = await readRaw<BudgetEntry>('budgets')
    expect(stored.find((b) => b.id === 'b1')).toMatchObject({
      currency: 'UAH',
      monthlyLimit: 10 * 41.52,
    })
    expect(stored.find((b) => b.id === 'b2')).toMatchObject({
      currency: 'UAH',
      monthlyLimit: 500,
    })
  })

  it('shares the fetch with an entry dated today', async () => {
    await seed('budgets', [budget()])
    await seed(OCT_CHUNK, [makeExpense({ createdAt: at(2026, 10, 15) })])
    const provider = makeProvider()

    await convertPending({ provider, today: TODAY })

    expect(provider.getRates).toHaveBeenCalledTimes(1)
  })

  it('makes no rate request when every budget is already in the main currency', async () => {
    await seed('budgets', [budget({ currency: 'UAH' })])
    const provider = makeProvider()

    await convertPending({ provider, today: TODAY })

    expect(provider.getRates).not.toHaveBeenCalled()
  })

  it('leaves the budgets alone when rates are off', async () => {
    setSettings({ fetchExchangeRates: false })
    await seed('budgets', [budget()])
    const before = mockStore.get('budgets')

    await convertPending({ provider: makeProvider(), today: TODAY })

    expect(mockStore.get('budgets')).toBe(before)
  })

  it('leaves the budgets alone, and does not throw, when today’s rates are unavailable', async () => {
    await seed('budgets', [budget()])
    const before = mockStore.get('budgets')
    const provider = makeProvider(() =>
      Promise.reject(new RateUnavailableError('no rates')),
    )

    await expect(convertPending({ provider, today: TODAY })).resolves.toBeDefined()

    expect(mockStore.get('budgets')).toBe(before)
  })

  it('does not convert budgets after an abort', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    await seed('budgets', [budget()])
    const before = mockStore.get('budgets')
    const controller = new AbortController()
    controller.abort()

    await convertPending({
      provider: makeProvider(),
      today: TODAY,
      signal: controller.signal,
    })

    expect(mockStore.get('budgets')).toBe(before)
  })
})
