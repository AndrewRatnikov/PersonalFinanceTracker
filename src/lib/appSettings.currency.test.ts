// No CONTRACT_GAPs: getCurrencySettings / updateCurrencySettings,
// CURRENCY_SETTINGS_QUERY_KEY and DEFAULT_FETCH_EXCHANGE_RATES are fully
// specified in the Interface Contract (module: appSettings).
//
// The currency settings live in the encrypted `syncedSettings` record now.
// getCurrencySettings reads it through localDb.readSyncedSettings and
// updateCurrencySettings delegates to localDb.updateSyncedSettings, so localDb
// is mocked here. The real read/write behaviour (legacy fallback, migration,
// rev) is tested with the real localDb in localDb.syncedSettings.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncChannel } from '@/lib/syncChannel'
import {
  CURRENCY_SETTINGS_QUERY_KEY,
  DEFAULT_FETCH_EXCHANGE_RATES,
  getCurrencySettings,
  updateCurrencySettings,
} from '@/lib/appSettings'
import { DecryptError } from '@/lib/dataErrors'
import { DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore, getLocalStore, readSyncedSettings, updateSyncedSettings, idbSet } =
  vi.hoisted(() => {
    const store = new Map<string, unknown>()
    return {
      mockStore: store,
      getLocalStore: vi.fn(),
      readSyncedSettings: vi.fn(),
      updateSyncedSettings: vi.fn(),
      idbSet: vi.fn((key: string, value: unknown) => {
        store.set(key, value)
        return Promise.resolve()
      }),
    }
  })

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: idbSet,
}))

vi.mock('@/lib/localDb', () => ({
  getLocalStore,
  readSyncedSettings,
  updateSyncedSettings,
}))

vi.mock('@/lib/vault', () => ({ META_SETTINGS_KEY: 'meta:settings' }))

function fakeChannel() {
  return {
    postMessage: vi.fn<SyncChannel['postMessage']>(),
    addEventListener: vi.fn<SyncChannel['addEventListener']>(),
    removeEventListener: vi.fn<SyncChannel['removeEventListener']>(),
    close: vi.fn<SyncChannel['close']>(),
  }
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'settings',
    mainCurrency: 'UAH',
    fetchExchangeRates: true,
    updatedAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  mockStore.clear()
  idbSet.mockClear()
  getLocalStore.mockReset().mockReturnValue('mock-store')
  readSyncedSettings.mockReset().mockResolvedValue(record())
  updateSyncedSettings.mockReset().mockResolvedValue(undefined)
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
  it('returns the two currency fields of the synced settings record, and nothing else', async () => {
    readSyncedSettings.mockResolvedValue(
      record({ mainCurrency: 'EUR', fetchExchangeRates: false, rev: 9 }),
    )

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })
  })

  it('follows the record: other values give other results', async () => {
    readSyncedSettings.mockResolvedValue(
      record({ mainCurrency: 'USD', fetchExchangeRates: true }),
    )
    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'USD',
      fetchExchangeRates: true,
    })

    readSyncedSettings.mockResolvedValue(
      record({ mainCurrency: 'UAH', fetchExchangeRates: false }),
    )
    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'UAH',
      fetchExchangeRates: false,
    })
  })

  it('does not read the legacy meta:settings fields itself', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'EUR', fetchExchangeRates: false })

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
    })
  })

  it('returns the defaults when the read fails for a reason other than decryption', async () => {
    readSyncedSettings.mockRejectedValue(new Error('idb broke'))

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
    })
  })

  it('returns the defaults when localDb is mocked without the new export (it throws synchronously)', async () => {
    readSyncedSettings.mockImplementation(() => {
      throw new Error('No "readSyncedSettings" export is defined on the mock')
    })

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
    })
  })

  it('lets a DecryptError through: an unreadable record must not read as UAH', async () => {
    const error = new DecryptError('syncedSettings')
    readSyncedSettings.mockRejectedValue(error)

    await expect(getCurrencySettings()).rejects.toBe(error)
  })

  it('lets a DecryptError from another module copy through too', async () => {
    const error = Object.assign(new Error('Could not decrypt'), {
      name: 'DecryptError',
      storageKey: 'syncedSettings',
    })
    readSyncedSettings.mockRejectedValue(error)

    await expect(getCurrencySettings()).rejects.toBe(error)
  })
})

describe('updateCurrencySettings', () => {
  it('hands the patch to localDb.updateSyncedSettings', async () => {
    await updateCurrencySettings({ fetchExchangeRates: false })

    expect(updateSyncedSettings).toHaveBeenCalledTimes(1)
    expect(updateSyncedSettings).toHaveBeenCalledWith({ fetchExchangeRates: false })

    await updateCurrencySettings({ fetchExchangeRates: true })

    expect(updateSyncedSettings).toHaveBeenCalledTimes(2)
    expect(updateSyncedSettings).toHaveBeenLastCalledWith({ fetchExchangeRates: true })
  })

  it('does not write meta:settings itself any more', async () => {
    mockStore.set('meta:settings', { autoLockMinutes: 5 })

    await updateCurrencySettings({ fetchExchangeRates: false })

    expect(idbSet).not.toHaveBeenCalled()
    expect(mockStore.get('meta:settings')).toEqual({ autoLockMinutes: 5 })
  })

  it('does not announce meta:settings: localDb announces syncedSettings after it commits', async () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    await updateCurrencySettings({ fetchExchangeRates: false })

    expect(channel.postMessage).not.toHaveBeenCalled()
  })

  it('passes a patch that wants to change mainCurrency on without writing it itself', async () => {
    const widePatch = { fetchExchangeRates: false, mainCurrency: 'USD' }

    await updateCurrencySettings(widePatch)

    expect(idbSet).not.toHaveBeenCalled()
    expect(updateSyncedSettings).toHaveBeenCalledWith(
      expect.objectContaining({ fetchExchangeRates: false }),
    )
  })

  it('rejects when localDb rejects, so a failed write is not hidden', async () => {
    const error = new DecryptError('syncedSettings')
    updateSyncedSettings.mockRejectedValue(error)

    await expect(updateCurrencySettings({ fetchExchangeRates: false })).rejects.toBe(
      error,
    )
  })
})
