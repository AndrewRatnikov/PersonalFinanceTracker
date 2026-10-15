// No CONTRACT_GAPs: getCurrencySettings / updateCurrencySettings,
// CURRENCY_SETTINGS_QUERY_KEY and DEFAULT_FETCH_EXCHANGE_RATES are fully
// specified in the Interface Contract (module: settings).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncChannel } from '@/lib/syncChannel'
import {
  CURRENCY_SETTINGS_QUERY_KEY,
  DEFAULT_FETCH_EXCHANGE_RATES,
  getCurrencySettings,
  updateCurrencySettings,
} from '@/lib/appSettings'
import { DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore, getLocalStore, idbGet, idbSet } = vi.hoisted(() => {
  const store = new Map<string, unknown>()
  return {
    mockStore: store,
    getLocalStore: vi.fn(),
    idbGet: vi.fn((key: string) => Promise.resolve(store.get(key))),
    idbSet: vi.fn((key: string, value: unknown) => {
      store.set(key, value)
      return Promise.resolve()
    }),
  }
})

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: idbGet,
  set: idbSet,
}))

vi.mock('@/lib/localDb', () => ({ getLocalStore }))

vi.mock('@/lib/vault', () => ({ META_SETTINGS_KEY: 'meta:settings' }))

function fakeChannel() {
  return {
    postMessage: vi.fn<SyncChannel['postMessage']>(),
    addEventListener: vi.fn<SyncChannel['addEventListener']>(),
    removeEventListener: vi.fn<SyncChannel['removeEventListener']>(),
    close: vi.fn<SyncChannel['close']>(),
  }
}

beforeEach(() => {
  mockStore.clear()
  idbGet.mockClear()
  idbSet.mockClear()
  getLocalStore.mockReset().mockReturnValue('mock-store')
})

afterEach(() => {
  setSyncChannel(undefined)
})

describe('constants', () => {
  it('defaults rates on, main currency UAH, and keys the query under settings', () => {
    expect(DEFAULT_FETCH_EXCHANGE_RATES).toBe(true)
    expect(DEFAULT_MAIN_CURRENCY).toBe('UAH')
    expect([...CURRENCY_SETTINGS_QUERY_KEY]).toEqual(['settings', 'currency'])
  })
})

describe('getCurrencySettings', () => {
  it('returns the defaults for an empty store', async () => {
    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
    })
  })

  it('returns stored valid values', async () => {
    mockStore.set('meta:settings', {
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })
  })

  it('reads each field independently: a missing field means its default', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'USD' })
    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'USD',
      fetchExchangeRates: true,
    })

    mockStore.set('meta:settings', { fetchExchangeRates: false })
    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'UAH',
      fetchExchangeRates: false,
    })
  })

  it('falls back to the defaults for an unknown currency and a non-boolean flag', async () => {
    mockStore.set('meta:settings', {
      mainCurrency: 'GBP',
      fetchExchangeRates: 'no',
    })

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
    })
  })

  it('ignores the unrelated fields stored next to them', async () => {
    mockStore.set('meta:settings', {
      autoLockMinutes: 5,
      failedUnlockAttempts: 2,
      mainCurrency: 'USD',
    })

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'USD',
      fetchExchangeRates: true,
    })
  })

  it('returns the defaults without a store', async () => {
    getLocalStore.mockReturnValue(null)
    mockStore.set('meta:settings', { mainCurrency: 'EUR' })

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
    })
  })

  it('never throws: returns the defaults when the read rejects', async () => {
    idbGet.mockRejectedValueOnce(new Error('idb broke'))

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
    })
  })

  it('never throws when the local store accessor itself throws (mocked localDb without it)', async () => {
    getLocalStore.mockImplementation(() => {
      throw new Error('No "getLocalStore" export is defined on the mock')
    })

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
    })
  })
})

describe('updateCurrencySettings', () => {
  it('writes fetchExchangeRates and getCurrencySettings reads it back', async () => {
    await updateCurrencySettings({ fetchExchangeRates: false })
    expect((await getCurrencySettings()).fetchExchangeRates).toBe(false)

    await updateCurrencySettings({ fetchExchangeRates: true })
    expect((await getCurrencySettings()).fetchExchangeRates).toBe(true)
  })

  it('merges into the stored object and keeps every other field', async () => {
    mockStore.set('meta:settings', {
      mainCurrency: 'EUR',
      autoLockMinutes: 5,
      failedUnlockAttempts: 3,
    })

    await updateCurrencySettings({ fetchExchangeRates: false })

    expect(mockStore.get('meta:settings')).toEqual({
      mainCurrency: 'EUR',
      autoLockMinutes: 5,
      failedUnlockAttempts: 3,
      fetchExchangeRates: false,
    })
  })

  it('does not let a patch change mainCurrency', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'EUR' })
    const widePatch = { fetchExchangeRates: false, mainCurrency: 'USD' }

    await updateCurrencySettings(widePatch)

    expect((await getCurrencySettings()).mainCurrency).toBe('EUR')
  })

  it('announces the meta:settings key to other tabs after writing', async () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    await updateCurrencySettings({ fetchExchangeRates: false })

    expect(channel.postMessage).toHaveBeenCalledWith({
      type: 'changed',
      keys: ['meta:settings'],
    })
  })

  it('is a no-op without a store', async () => {
    getLocalStore.mockReturnValue(null)

    await updateCurrencySettings({ fetchExchangeRates: false })

    expect(idbSet).not.toHaveBeenCalled()
    expect(mockStore.size).toBe(0)
  })
})
