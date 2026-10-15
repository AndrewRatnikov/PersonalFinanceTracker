// No CONTRACT_GAPs: requestConversion, whenConversionIdle, startAutoConversion
// and subscribeConversion are fully specified in the Interface Contract
// (module: conversion). Test notes followed: '@/lib/rates' is mocked with a
// fake rateProvider, the real localDb runs on a Map-backed idb-keyval, and
// startAutoConversion is stopped in afterEach.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Expense, IncomeEntry } from '@/lib/domain'
import type { RateTable } from '@/lib/rates/types'
import { decryptValue, encryptValue } from '@/lib/crypto'
import {
  requestConversion,
  startAutoConversion,
  subscribeConversion,
  whenConversionIdle,
} from '@/lib/conversion'
import { clearDataProblem, getDataProblem } from '@/lib/dataProblem'
import {
  addExpense,
  addIncome,
  prepareUnlockedVault,
  readEntriesForConversion,
  unlockLocalDb,
  wipeLocalDbKey,
} from '@/lib/localDb'

const { mockStore, fakeProvider } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  fakeProvider: { id: 'nbu', getRates: vi.fn() },
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

vi.mock('@/lib/rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rates')>()),
  rateProvider: fakeProvider,
}))

// Wraps the real reader so the tests can count and fail runs.
vi.mock('@/lib/localDb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/localDb')>()
  return {
    ...actual,
    readEntriesForConversion: vi.fn(actual.readEntriesForConversion),
  }
})

const at = (y: number, m: number, d: number) =>
  new Date(y, m - 1, d, 12, 0, 0).toISOString()
const OCT_14 = at(2026, 10, 14)
const OCT_13 = at(2026, 10, 13)
const OCT_CHUNK = 'expenses_2026_10'
const OLD = '2026-01-05T08:00:00.000Z'
const RATES = { UAH: 1, USD: 41.52, EUR: 45.1 }

let dek: CryptoKey
let stops: Array<() => void> = []

function table(date: string): RateTable {
  return { base: 'UAH', effectiveDate: date, perBase: RATES }
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

async function seed(storageKey: string, value: unknown) {
  mockStore.set(storageKey, await encryptValue(dek, value))
}

async function readRaw<T>(storageKey: string): Promise<Array<T>> {
  const raw = mockStore.get(storageKey)
  if (!(raw instanceof Uint8Array)) throw new Error(`nothing under ${storageKey}`)
  return (await decryptValue(dek, raw)) as Array<T>
}

function startAuto() {
  const stop = startAutoConversion()
  stops.push(stop)
  return stop
}

// A getRates that waits for the test to release it, one release per call.
function holdRates() {
  const pending: Array<{ date: string; release: () => void }> = []
  fakeProvider.getRates.mockImplementation(
    (date: string) =>
      new Promise<RateTable>((resolve) => {
        pending.push({ date, release: () => resolve(table(date)) })
      }),
  )
  return pending
}

beforeEach(async () => {
  mockStore.clear()
  stops = []
  fakeProvider.getRates.mockReset()
  fakeProvider.getRates.mockImplementation((date: string) =>
    Promise.resolve(table(date)),
  )
  vi.mocked(readEntriesForConversion).mockClear()
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
})

afterEach(async () => {
  for (const stop of stops) stop()
  await whenConversionIdle()
  clearDataProblem()
  vi.restoreAllMocks()
})

describe('saving never waits for the network', () => {
  it('addExpense resolves with a pending record while the provider hangs, then the record is converted in the background', async () => {
    const pending = holdRates()
    startAuto()

    const saved = await addExpense({
      amount: 20,
      currency: 'USD',
      categoryId: 'c1',
      createdAt: OCT_14,
    })

    expect(saved.conversion).toBeUndefined()
    await vi.waitFor(() => {
      expect(pending).toHaveLength(1)
    })
    const [during] = await readRaw<Expense>(OCT_CHUNK)
    expect(during.conversion).toBeUndefined()

    pending[0].release()
    await whenConversionIdle()

    const [after] = await readRaw<Expense>(OCT_CHUNK)
    expect(after.conversion).toEqual({
      mainCurrency: 'UAH',
      rate: 41.52,
      mainAmount: 20 * 41.52,
      rateDate: '2026-10-14',
      source: 'nbu',
    })
  })

  it('addIncome in a foreign currency is converted in the background too', async () => {
    startAuto()

    await addIncome({
      categoryId: 'ic1',
      amount: 50,
      currency: 'EUR',
      createdAt: OCT_14,
    })
    await whenConversionIdle()

    const [stored] = await readRaw<IncomeEntry>('income')
    expect(stored.conversion?.mainAmount).toBe(50 * 45.1)
  })

  it('a main-currency expense needs no fetch at all', async () => {
    startAuto()

    const saved = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: 'c1',
      createdAt: OCT_14,
    })
    await whenConversionIdle()

    expect(saved.conversion?.source).toBe('identity')
    expect(fakeProvider.getRates).not.toHaveBeenCalled()
  })

  it('stops reacting to saves after the returned cleanup runs', async () => {
    const stop = startAuto()
    stop()

    await addExpense({
      amount: 20,
      currency: 'USD',
      categoryId: 'c1',
      createdAt: OCT_14,
    })
    await whenConversionIdle()

    expect(fakeProvider.getRates).not.toHaveBeenCalled()
    expect(readEntriesForConversion).not.toHaveBeenCalled()
    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion).toBeUndefined()
  })
})

describe('requestConversion', () => {
  it('converts the pending records and resolves', async () => {
    await seed(OCT_CHUNK, [makeExpense()])

    await requestConversion()

    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion?.source).toBe('nbu')
  })

  it('runs one conversion at a time and schedules exactly one follow-up for requests made meanwhile', async () => {
    await seed(OCT_CHUNK, [makeExpense({ id: 'a', createdAt: OCT_14 })])
    const pending = holdRates()

    const first = requestConversion()
    await vi.waitFor(() => {
      expect(pending).toHaveLength(1)
    })
    expect(readEntriesForConversion).toHaveBeenCalledTimes(1)

    // A record arrives while run 1 waits for rates; three more requests come in.
    await seed(OCT_CHUNK, [
      makeExpense({ id: 'a', createdAt: OCT_14 }),
      makeExpense({ id: 'b', createdAt: OCT_13 }),
    ])
    const more = [requestConversion(), requestConversion(), requestConversion()]
    expect(pending).toHaveLength(1) // still only run 1 in flight

    pending[0].release()
    await vi.waitFor(() => {
      expect(pending).toHaveLength(2)
    })
    expect(pending[1].date).toBe('2026-10-13')
    pending[1].release()
    await Promise.all([first, ...more, whenConversionIdle()])

    expect(readEntriesForConversion).toHaveBeenCalledTimes(2)
    const stored = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.every((e) => e.conversion !== undefined)).toBe(true)
  })

  it('never rejects: a DecryptError goes to the data problem screen', async () => {
    mockStore.set(OCT_CHUNK, new Uint8Array(40))

    await expect(requestConversion()).resolves.toBeUndefined()

    expect(getDataProblem()?.storageKey).toBe(OCT_CHUNK)
  })

  it('never rejects: any other error is logged', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(readEntriesForConversion).mockRejectedValueOnce(new Error('boom'))

    await expect(requestConversion()).resolves.toBeUndefined()

    expect(errorLog).toHaveBeenCalled()
    expect(getDataProblem()).toBeNull()
  })

  it('does nothing while locked', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    wipeLocalDbKey()

    await expect(requestConversion()).resolves.toBeUndefined()

    expect(fakeProvider.getRates).not.toHaveBeenCalled()
    expect(getDataProblem()).toBeNull()
  })

  it('works again after a failed run', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(readEntriesForConversion).mockRejectedValueOnce(new Error('boom'))
    await requestConversion()

    await requestConversion()

    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion).toBeDefined()
  })
})

describe('whenConversionIdle', () => {
  it('resolves immediately when nothing runs', async () => {
    await expect(whenConversionIdle()).resolves.toBeUndefined()
  })

  it('stays pending while a run is in flight and resolves after it', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    const pending = holdRates()
    void requestConversion()
    await vi.waitFor(() => {
      expect(pending).toHaveLength(1)
    })
    let idle = false
    void whenConversionIdle().then(() => {
      idle = true
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(idle).toBe(false)

    pending[0].release()
    await whenConversionIdle()
    expect(idle).toBe(true)
  })
})

describe('startAutoConversion', () => {
  it('runs when the browser comes back online', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    startAuto()

    window.dispatchEvent(new Event('online'))
    await whenConversionIdle()

    const [stored] = await readRaw<Expense>(OCT_CHUNK)
    expect(stored.conversion?.source).toBe('nbu')
  })

  it('ignores the online event after cleanup', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    const stop = startAuto()
    stop()

    window.dispatchEvent(new Event('online'))
    await whenConversionIdle()

    expect(fakeProvider.getRates).not.toHaveBeenCalled()
  })

  it('converts the records generated by prepareUnlockedVault after processDueRecurring', async () => {
    await seed('categories', [{ id: 'c1', name: 'Rent', icon: null, updatedAt: OLD }])
    await seed('incomeCategories', [])
    await seed('recurring', [
      {
        id: 'r1',
        kind: 'expense',
        amount: 30,
        currency: 'USD',
        categoryId: 'c1',
        description: null,
        frequency: { unit: 'month', interval: 1 },
        startDate: '2025-06-01',
        end: { type: 'never' },
        mode: 'auto',
        paused: false,
        handledThrough: null,
        handledAhead: [],
        occurrenceCount: 0,
        createdAt: OLD,
        updatedAt: OLD,
      },
    ])
    startAuto()

    const result = await prepareUnlockedVault({ isNewVault: false })
    await whenConversionIdle()

    expect(result.recurringCreated).toBeGreaterThan(0)
    const keys = Array.from(mockStore.keys()).filter((k) => k.startsWith('expenses_'))
    const records = (await Promise.all(keys.map((k) => readRaw<Expense>(k)))).flat()
    expect(records).toHaveLength(result.recurringCreated)
    expect(records.every((r) => r.conversion?.source === 'nbu')).toBe(true)
    expect(records.every((r) => r.conversion?.mainAmount === 30 * 41.52)).toBe(true)
  })
})

describe('subscribeConversion', () => {
  it('calls the listener when a run commits and ends, and stops after unsubscribing', async () => {
    await seed(OCT_CHUNK, [makeExpense()])
    const listener = vi.fn()
    const stop = subscribeConversion(listener)

    await requestConversion()
    expect(listener).toHaveBeenCalled()

    stop()
    listener.mockClear()
    await seed(OCT_CHUNK, [makeExpense({ id: 'later', createdAt: OCT_13 })])
    await requestConversion()

    expect(listener).not.toHaveBeenCalled()
  })

  it('calls the listener at the end of a run even when nothing was converted', async () => {
    const listener = vi.fn()
    const stop = subscribeConversion(listener)

    await requestConversion()
    stop()

    expect(listener).toHaveBeenCalled()
  })
})
