// CONTRACT_GAP: whether a personal DecryptError stops the Family part of the
//   same background run is not in the Interface Contract; the Family
//   DecryptError test therefore keeps the personal data readable.
//
// Conversion across spaces: each space converts to its own main currency, the
// background run covers every held space, and changeMainCurrency takes a
// spaceId. '@/lib/rates' is mocked with a fake provider (no network), the
// real localDb runs on a Map-backed idb-keyval.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Expense } from '@/lib/domain'
import type * as Rates from '@/lib/rates'
import type { RateTable } from '@/lib/rates/types'
import type { SpaceKeyEntry } from '@/lib/spaces/types'
import { base64ToBytes, decryptValue, encryptValue } from '@/lib/crypto'
import {
  MainCurrencyChangeError,
  changeMainCurrency,
  convertPending,
  getConversionStatus,
  requestConversion,
  whenConversionIdle,
} from '@/lib/conversion'
import { clearDataProblem, getDataProblem } from '@/lib/dataProblem'
import {
  createLocalSpace,
  forgetLocalSpace,
  readSyncedSettings,
  spaceDb,
  unlockLocalDb,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { clearKeyring } from '@/lib/spaces/keyring'
import { importSpaceKey } from '@/lib/spaces/spaceCrypto'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore, fakeProvider } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  fakeProvider: { id: 'nbu', getRates: vi.fn() },
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  getMany: (list: Array<string>) => Promise.resolve(list.map((k) => mockStore.get(k))),
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
  delMany: (list: Array<string>) => {
    for (const key of list) mockStore.delete(key)
    return Promise.resolve()
  },
  clear: () => {
    mockStore.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(mockStore.keys())),
}))
vi.mock('@/lib/rates', async (importOriginal) => ({
  ...(await importOriginal<typeof Rates>()),
  rateProvider: fakeProvider,
}))
vi.mock('@/lib/accountSession', () => ({
  getAccountSession: vi.fn().mockResolvedValue(null),
}))

const OCT_14 = new Date(2026, 9, 14, 12, 0, 0).toISOString()
const OCT_CHUNK = 'expenses_2026_10'
const OLD = '2026-01-05T08:00:00.000Z'
const TODAY = '2026-10-14'
const RATES = { UAH: 1, USD: 41.52, EUR: 45.1 }

let dek: CryptoKey

function table(date: string): RateTable {
  return { base: 'UAH', effectiveDate: date, perBase: RATES }
}

function makeExpense(id: string, overrides: Partial<Expense> = {}): Expense {
  return {
    id,
    amount: 100,
    currency: 'UAH',
    categoryId: 'c1',
    description: null,
    createdAt: OCT_14,
    updatedAt: OLD,
    ...overrides,
  }
}

async function skOf(spaceId: string): Promise<CryptoKey> {
  const raw = mockStore.get('spaceKeys') as Uint8Array
  const entries = (await decryptValue(dek, raw)) as Array<SpaceKeyEntry>
  const entry = entries.find((e) => e.id === spaceId)
  if (!entry) throw new Error('no entry')
  return importSpaceKey(base64ToBytes(entry.key))
}

async function seedPersonal(list: Array<Expense>) {
  mockStore.set(OCT_CHUNK, await encryptValue(dek, list))
}

async function seedFamily(spaceId: string, list: Array<Expense>) {
  mockStore.set(`space:${spaceId}:${OCT_CHUNK}`, await encryptValue(await skOf(spaceId), list))
}

async function seedFamilySettings(
  spaceId: string,
  settings: { mainCurrency: string; fetchExchangeRates: boolean },
) {
  mockStore.set(
    `space:${spaceId}:syncedSettings`,
    await encryptValue(await skOf(spaceId), {
      id: 'settings',
      ...settings,
      updatedAt: OLD,
      rev: 1,
    }),
  )
}

async function storedPersonal(): Promise<Array<Expense>> {
  return (await decryptValue(dek, mockStore.get(OCT_CHUNK) as Uint8Array)) as Array<Expense>
}

async function storedFamily(spaceId: string): Promise<Array<Expense>> {
  return (await decryptValue(
    await skOf(spaceId),
    mockStore.get(`space:${spaceId}:${OCT_CHUNK}`) as Uint8Array,
  )) as Array<Expense>
}

async function familySpace(settings?: { mainCurrency: string; fetchExchangeRates: boolean }) {
  const space = await createLocalSpace({ name: 'Home', lang: 'en' })
  if (settings) await seedFamilySettings(space.id, settings)
  return space
}

beforeEach(async () => {
  mockStore.clear()
  localStorage.clear()
  setSyncChannel(null)
  clearKeyring()
  clearDataProblem()
  fakeProvider.getRates.mockReset()
  fakeProvider.getRates.mockImplementation((date: string) => Promise.resolve(table(date)))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 14, 13, 0, 0))
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
})

afterEach(async () => {
  await whenConversionIdle()
  clearDataProblem()
  wipeLocalDbKey()
  setSyncChannel(undefined)
  vi.useRealTimers()
})

describe('the background run converts each space to its own main currency', () => {
  it('a Family space in USD gets USD conversions while personal stays in UAH', async () => {
    const space = await familySpace({ mainCurrency: 'USD', fetchExchangeRates: true })
    await seedPersonal([makeExpense('p1')])
    await seedFamily(space.id, [makeExpense('f1')])

    await requestConversion()

    const [personal] = await storedPersonal()
    const [family] = await storedFamily(space.id)
    expect(personal.conversion?.mainCurrency).toBe('UAH')
    expect(personal.conversion?.source).toBe('identity')
    expect(family.conversion?.mainCurrency).toBe('USD')
    expect(family.conversion?.source).toBe('nbu')
    expect(family.conversion?.rate).toBeCloseTo(1 / RATES.USD, 4)
  })

  it('a personal USD entry converts to the personal main currency, not the Family one', async () => {
    const space = await familySpace({ mainCurrency: 'EUR', fetchExchangeRates: true })
    await seedPersonal([makeExpense('p1', { currency: 'USD', amount: 10 })])
    await seedFamily(space.id, [makeExpense('f1', { currency: 'USD', amount: 10 })])

    await requestConversion()

    const [personal] = await storedPersonal()
    const [family] = await storedFamily(space.id)
    expect(personal.conversion?.mainCurrency).toBe('UAH')
    expect(family.conversion?.mainCurrency).toBe('EUR')
    expect(personal.conversion?.mainAmount).not.toBeCloseTo(family.conversion?.mainAmount ?? 0, 3)
  })

  it('does not convert anything of a space with exchange rates off, and leaves the other space converted', async () => {
    const space = await familySpace({ mainCurrency: 'USD', fetchExchangeRates: false })
    await seedPersonal([makeExpense('p1', { currency: 'USD', amount: 10 })])
    await seedFamily(space.id, [makeExpense('f1')])

    await requestConversion()

    const [personal] = await storedPersonal()
    const [family] = await storedFamily(space.id)
    expect(personal.conversion?.mainCurrency).toBe('UAH')
    expect(family.conversion).toBeUndefined()
  })

  it('covers a space that is only known from the store after a lock and unlock', async () => {
    const space = await familySpace({ mainCurrency: 'USD', fetchExchangeRates: true })
    await seedFamily(space.id, [makeExpense('f1')])
    wipeLocalDbKey()
    unlockLocalDb(dek)

    await requestConversion()

    expect((await storedFamily(space.id))[0].conversion?.mainCurrency).toBe('USD')
  })

  it('a forgotten space is not converted and nothing fails', async () => {
    const space = await familySpace({ mainCurrency: 'USD', fetchExchangeRates: true })
    await seedPersonal([makeExpense('p1')])
    await forgetLocalSpace(space.id)

    await expect(requestConversion()).resolves.toBeUndefined()

    expect(getDataProblem()).toBeNull()
    expect((await storedPersonal())[0].conversion?.mainCurrency).toBe('UAH')
  })

  it('an unreadable Family blob is reported as a data problem with the prefixed key', async () => {
    const space = await familySpace({ mainCurrency: 'USD', fetchExchangeRates: true })
    await seedPersonal([makeExpense('p1')])
    mockStore.set(`space:${space.id}:${OCT_CHUNK}`, new Uint8Array(40))

    await expect(requestConversion()).resolves.toBeUndefined()

    expect(getDataProblem()?.storageKey).toBe(`space:${space.id}:${OCT_CHUNK}`)
  })

  it('personal only: no Family key is created or read', async () => {
    await seedPersonal([makeExpense('p1')])

    await requestConversion()

    expect((await storedPersonal())[0].conversion?.mainCurrency).toBe('UAH')
    expect(Array.from(mockStore.keys()).some((k) => k.startsWith('space:'))).toBe(false)
  })
})

describe('convertPending({ spaceId })', () => {
  it('converts only that space', async () => {
    const space = await familySpace({ mainCurrency: 'USD', fetchExchangeRates: true })
    await seedPersonal([makeExpense('p1', { currency: 'USD', amount: 10 })])
    await seedFamily(space.id, [makeExpense('f1')])

    const result = await convertPending({ spaceId: space.id, today: TODAY })

    expect(result.converted).toBe(1)
    expect((await storedFamily(space.id))[0].conversion?.mainCurrency).toBe('USD')
    expect((await storedPersonal())[0].conversion).toBeUndefined()
  })

  it('without a spaceId it converts only personal', async () => {
    const space = await familySpace({ mainCurrency: 'USD', fetchExchangeRates: true })
    await seedPersonal([makeExpense('p1', { currency: 'USD', amount: 10 })])
    await seedFamily(space.id, [makeExpense('f1')])

    await convertPending({ today: TODAY })

    expect((await storedPersonal())[0].conversion?.mainCurrency).toBe('UAH')
    expect((await storedFamily(space.id))[0].conversion).toBeUndefined()
  })
})

describe('getConversionStatus', () => {
  it('reports the Family space’s own main currency and counts', async () => {
    const space = await familySpace({ mainCurrency: 'USD', fetchExchangeRates: true })
    // USD entries differ from the personal main (UAH), so they are pending.
    await seedPersonal([
      makeExpense('p1', { currency: 'USD' }),
      makeExpense('p2', { currency: 'USD' }),
    ])
    await seedFamily(space.id, [makeExpense('f1')])

    const family = await getConversionStatus({ spaceId: space.id })
    const personal = await getConversionStatus()

    expect(family.mainCurrency).toBe('USD')
    expect(family.totalEntries).toBe(1)
    expect(family.pendingEntries).toBe(1)
    expect(personal.mainCurrency).toBe('UAH')
    expect(personal.totalEntries).toBe(2)
    expect(personal.pendingEntries).toBe(2)
  })

  it('reports the Family rates switch separately', async () => {
    const space = await familySpace({ mainCurrency: 'USD', fetchExchangeRates: false })

    expect((await getConversionStatus({ spaceId: space.id })).fetchExchangeRates).toBe(false)
    expect((await getConversionStatus()).fetchExchangeRates).toBe(true)
  })
})

describe('changeMainCurrency({ spaceId })', () => {
  it('changes the Family main currency and recalculates only its entries', async () => {
    const space = await familySpace({ mainCurrency: 'UAH', fetchExchangeRates: true })
    await seedPersonal([makeExpense('p1')])
    await seedFamily(space.id, [makeExpense('f1')])

    const result = await changeMainCurrency('EUR', {
      spaceId: space.id,
      provider: fakeProvider,
      today: TODAY,
    })

    expect(result.converted).toBe(1)
    expect((await spaceDb(space.id).readSyncedSettings()).mainCurrency).toBe('EUR')
    expect((await readSyncedSettings()).mainCurrency).toBe('UAH')
    expect((await storedFamily(space.id))[0].conversion?.mainCurrency).toBe('EUR')
    expect((await storedPersonal())[0].conversion).toBeUndefined()
  })

  it('a personal change leaves the Family main currency alone', async () => {
    const space = await familySpace({ mainCurrency: 'USD', fetchExchangeRates: true })
    await seedPersonal([makeExpense('p1')])

    await changeMainCurrency('EUR', { provider: fakeProvider, today: TODAY })

    expect((await readSyncedSettings()).mainCurrency).toBe('EUR')
    expect((await spaceDb(space.id).readSyncedSettings()).mainCurrency).toBe('USD')
  })

  it('refuses with rates-off when only the Family space has rates off, and writes nothing', async () => {
    const space = await familySpace({ mainCurrency: 'UAH', fetchExchangeRates: false })
    await seedFamily(space.id, [makeExpense('f1')])
    const before = new Map(mockStore)

    const err = await changeMainCurrency('EUR', {
      spaceId: space.id,
      provider: fakeProvider,
      today: TODAY,
    }).then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(MainCurrencyChangeError)
    expect((err as MainCurrencyChangeError).code).toBe('rates-off')
    for (const [key, value] of before) expect(mockStore.get(key), key).toBe(value)
    expect(fakeProvider.getRates).not.toHaveBeenCalled()
  })

  it('does nothing when the Family space is already in that currency', async () => {
    const space = await familySpace({ mainCurrency: 'USD', fetchExchangeRates: true })

    const result = await changeMainCurrency('USD', { spaceId: space.id, provider: fakeProvider })

    expect(result).toEqual({ converted: 0, stillPending: 0, budgetsConverted: 0, rateDate: null })
    expect(fakeProvider.getRates).not.toHaveBeenCalled()
  })
})
