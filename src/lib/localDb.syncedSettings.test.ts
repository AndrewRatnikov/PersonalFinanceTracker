// CONTRACT_GAP: the plan does not say which `updatedAt` readSyncedSettings
//   gives a record it builds from the legacy meta:settings fields. Only the
//   currency fields of such a record are asserted.
// CONTRACT_GAP: the plan does not say whether the migration removes the legacy
//   fields from meta:settings when they hold only invalid values. Tested for
//   valid legacy values only.
//
// Integration style (as localDb.incomeCategories.test.ts): real crypto and
// real localDb, idb-keyval backed by a Map with a switch that makes setMany
// reject once. appSettings and conversion run for real on top of it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BudgetEntry, Expense, RecurringItem } from '@/lib/domain'
import type { RateProvider, RateTable } from '@/lib/rates/types'
import type { SyncChannel } from '@/lib/syncChannel'
import { getCurrencySettings, updateCurrencySettings } from '@/lib/appSettings'
import { changeMainCurrency } from '@/lib/conversion'
import { decryptValue, encryptValue } from '@/lib/crypto'
import {
  DecryptError,
  SETTINGS_DEFAULT_UPDATED_AT,
  addCategory,
  addExpense,
  convertBudgets,
  getAllBudgets,
  getAllCategories,
  getLocalRev,
  hasLocalData,
  migrateSyncedSettings,
  onConversionNeeded,
  prepareUnlockedVault,
  quarantineKey,
  readSyncedSettings,
  unlockLocalDb,
  updateSyncedSettings,
  upsertBudget,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: {
    failSetMany: 0,
    setManyCalls: [] as Array<Array<string>>,
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
    if (ctl.failSetMany > 0) {
      ctl.failSetMany--
      return Promise.reject(new Error('transaction aborted'))
    }
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

const T0 = '2026-01-01T09:00:00.000Z'
const T1 = '2026-05-15T10:00:00.000Z'
const T2 = '2026-05-16T10:00:00.000Z'
const TODAY = '2026-05-15'

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

function plainSettings(): Record<string, unknown> {
  return mockStore.get('meta:settings') as Record<string, unknown>
}

async function seedSynced(overrides: Record<string, unknown> = {}) {
  await seed('syncedSettings', {
    id: 'settings',
    mainCurrency: 'EUR',
    fetchExchangeRates: true,
    updatedAt: T0,
    rev: 5,
    ...overrides,
  })
  mockStore.set('meta:sync', { localRev: 5 })
}

// A store as it was before this change: the currency settings sit in the
// plaintext meta:settings next to the per-device ones.
const OLD_SETTINGS = {
  mainCurrency: 'EUR',
  fetchExchangeRates: false,
  autoLockMinutes: 5,
  failedUnlockAttempts: 2,
  unlockBlockedUntil: null,
  installHintDismissed: true,
  persistRequestedAt: '2026-04-01T00:00:00.000Z',
  recoveryKeyConfirmed: false,
  backupReminderDays: 30,
  lastBackupAt: '2026-04-02T00:00:00.000Z',
  backupReminderSnoozedUntil: '2026-06-01T00:00:00.000Z',
  lastDataChangeAt: T0,
}

const PER_DEVICE = {
  autoLockMinutes: 5,
  failedUnlockAttempts: 2,
  unlockBlockedUntil: null,
  installHintDismissed: true,
  persistRequestedAt: '2026-04-01T00:00:00.000Z',
  recoveryKeyConfirmed: false,
  backupReminderDays: 30,
  lastBackupAt: '2026-04-02T00:00:00.000Z',
  backupReminderSnoozedUntil: '2026-06-01T00:00:00.000Z',
}

function expectUnchanged(before: Map<string, unknown>) {
  expect(Array.from(mockStore.keys()).sort()).toEqual(Array.from(before.keys()).sort())
  for (const [key, value] of before) expect(mockStore.get(key)).toBe(value)
}

beforeEach(async () => {
  mockStore.clear()
  ctl.failSetMany = 0
  ctl.setManyCalls.length = 0
  stops = []
  localStorage.clear()
  setSyncChannel(null)
  vi.useFakeTimers({ toFake: ['Date'] })
  setNow(T1)
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

// ── Reading ───────────────────────────────────────────────────────────────────

describe('readSyncedSettings', () => {
  it('gives the defaults when nothing is stored', async () => {
    expect(await readSyncedSettings()).toEqual({
      id: 'settings',
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
      updatedAt: SETTINGS_DEFAULT_UPDATED_AT,
    })
  })

  it('falls back to the legacy plaintext fields while the record does not exist yet', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'EUR', fetchExchangeRates: false })

    expect(await readSyncedSettings()).toMatchObject({
      id: 'settings',
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })

    mockStore.set('meta:settings', { mainCurrency: 'USD' })
    expect(await readSyncedSettings()).toMatchObject({
      mainCurrency: 'USD',
      fetchExchangeRates: true,
    })

    mockStore.set('meta:settings', { fetchExchangeRates: false })
    expect(await readSyncedSettings()).toMatchObject({
      mainCurrency: 'UAH',
      fetchExchangeRates: false,
    })
  })

  it('reads the encrypted record when it exists', async () => {
    await seedSynced({ mainCurrency: 'USD', fetchExchangeRates: false })

    expect(await readSyncedSettings()).toMatchObject({
      id: 'settings',
      mainCurrency: 'USD',
      fetchExchangeRates: false,
      updatedAt: T0,
    })
  })

  it('the record wins over the legacy fields', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'USD', fetchExchangeRates: true })
    await seedSynced({ mainCurrency: 'EUR', fetchExchangeRates: false })

    expect(await readSyncedSettings()).toMatchObject({
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })
  })

  it('an invalid field of the record reads as its default, the other one is kept', async () => {
    await seedSynced({ mainCurrency: 'GBP', fetchExchangeRates: 'yes' })
    expect(await readSyncedSettings()).toMatchObject({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
    })

    await seedSynced({ mainCurrency: 'EUR', fetchExchangeRates: 'yes' })
    expect(await readSyncedSettings()).toMatchObject({
      mainCurrency: 'EUR',
      fetchExchangeRates: true,
    })

    await seedSynced({ mainCurrency: 'GBP', fetchExchangeRates: false })
    expect(await readSyncedSettings()).toMatchObject({
      mainCurrency: 'UAH',
      fetchExchangeRates: false,
    })
  })

  it('an unreadable record is a DecryptError for syncedSettings', async () => {
    mockStore.set('syncedSettings', new Uint8Array(40))

    const err = await readSyncedSettings().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DecryptError)
    expect((err as DecryptError).storageKey).toBe('syncedSettings')
  })

  it('reads only: nothing is written', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'EUR' })
    const before = new Map(mockStore)

    await readSyncedSettings()

    expect(ctl.setManyCalls).toHaveLength(0)
    expectUnchanged(before)
  })

  it('before unlock it gives the legacy values or the defaults and never throws', async () => {
    wipeLocalDbKey()
    expect(await readSyncedSettings()).toMatchObject({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
    })

    mockStore.set('meta:settings', { mainCurrency: 'EUR', fetchExchangeRates: false })
    expect(await readSyncedSettings()).toMatchObject({
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })

    mockStore.set('syncedSettings', new Uint8Array(40))
    await expect(readSyncedSettings()).resolves.toMatchObject({ id: 'settings' })
    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })
  })
})

describe('getCurrencySettings / updateCurrencySettings on top of the record', () => {
  it('getCurrencySettings returns the two currency fields', async () => {
    await seedSynced({ mainCurrency: 'USD', fetchExchangeRates: false })

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'USD',
      fetchExchangeRates: false,
    })
  })

  it('getCurrencySettings reads the legacy fields of an unmigrated store', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'EUR', fetchExchangeRates: false })

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })
  })

  it('getCurrencySettings lets a DecryptError through', async () => {
    mockStore.set('syncedSettings', new Uint8Array(40))

    await expect(getCurrencySettings()).rejects.toBeInstanceOf(DecryptError)
  })

  it('updateCurrencySettings writes the record and announces syncedSettings, not meta:settings', async () => {
    await seedSynced()
    const channel = fakeChannel()
    setSyncChannel(channel)

    await updateCurrencySettings({ fetchExchangeRates: false })

    expect((await getCurrencySettings()).fetchExchangeRates).toBe(false)
    expect((await readSyncedRaw()).fetchExchangeRates).toBe(false)
    expect(postedKeys(channel)).toContain('syncedSettings')
    expect(postedKeys(channel)).not.toContain('meta:settings')

    await updateCurrencySettings({ fetchExchangeRates: true })
    expect((await getCurrencySettings()).fetchExchangeRates).toBe(true)
  })

  it('updateCurrencySettings never changes the main currency', async () => {
    await seedSynced({ mainCurrency: 'EUR' })
    const widePatch = { fetchExchangeRates: false, mainCurrency: 'USD' }

    await updateCurrencySettings(widePatch)

    expect((await getCurrencySettings()).mainCurrency).toBe('EUR')
  })
})

// ── The migration ─────────────────────────────────────────────────────────────

describe('migrateSyncedSettings', () => {
  it('moves the legacy currency fields into the encrypted record, in ONE setMany', async () => {
    mockStore.set('meta:settings', { ...OLD_SETTINGS })

    const migrated = await migrateSyncedSettings()

    expect(migrated).toBe(true)
    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual(['meta:settings', 'syncedSettings'])
    expect(mockStore.get('syncedSettings')).toBeInstanceOf(Uint8Array)
    const record = await readSyncedRaw()
    expect(record).toEqual({
      id: 'settings',
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
      updatedAt: T1,
    })
    expect('rev' in record).toBe(false)
    const plain = plainSettings()
    expect('mainCurrency' in plain).toBe(false)
    expect('fetchExchangeRates' in plain).toBe(false)
    // Every other field is exactly as it was.
    const { mainCurrency, fetchExchangeRates, ...rest } = OLD_SETTINGS
    expect(mainCurrency).toBe('EUR')
    expect(fetchExchangeRates).toBe(false)
    expect(plain).toEqual(rest)
  })

  it('reads back as the old values through the normal readers', async () => {
    mockStore.set('meta:settings', { ...OLD_SETTINGS })

    await migrateSyncedSettings()

    expect(await readSyncedSettings()).toMatchObject({
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })
    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })
  })

  it('is a derived write: no rev, no meta:sync, no lastDataChangeAt, no conversion request', async () => {
    mockStore.set('meta:settings', { ...OLD_SETTINGS })
    const listener = listen()
    setNow(T2)

    await migrateSyncedSettings()

    expect(mockStore.has('meta:sync')).toBe(false)
    expect(await getLocalRev()).toBe(0)
    expect(plainSettings().lastDataChangeAt).toBe(T0)
    expect(listener).not.toHaveBeenCalled()
  })

  it('announces syncedSettings once', async () => {
    mockStore.set('meta:settings', { ...OLD_SETTINGS })
    const channel = fakeChannel()
    setSyncChannel(channel)

    await migrateSyncedSettings()

    expect(channel.postMessage).toHaveBeenCalledTimes(1)
    expect(postedKeys(channel)).toEqual(['syncedSettings'])
  })

  it('a partial legacy value: the other field gets its default and updatedAt is the migration time', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'USD', autoLockMinutes: 15 })

    await migrateSyncedSettings()

    expect(await readSyncedRaw()).toEqual({
      id: 'settings',
      mainCurrency: 'USD',
      fetchExchangeRates: true,
      updatedAt: T1,
    })
    expect(plainSettings()).toEqual({ autoLockMinutes: 15 })
  })

  it('only fetchExchangeRates stored: the main currency defaults to UAH', async () => {
    mockStore.set('meta:settings', { fetchExchangeRates: false })

    await migrateSyncedSettings()

    expect(await readSyncedRaw()).toEqual({
      id: 'settings',
      mainCurrency: 'UAH',
      fetchExchangeRates: false,
      updatedAt: T1,
    })
  })

  it('a store with neither legacy field gets the defaults dated at the epoch, and meta:settings is not written', async () => {
    mockStore.set('meta:settings', { autoLockMinutes: 5 })
    const plainBefore = mockStore.get('meta:settings')

    const migrated = await migrateSyncedSettings()

    expect(migrated).toBe(true)
    expect(await readSyncedRaw()).toEqual({
      id: 'settings',
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
      updatedAt: SETTINGS_DEFAULT_UPDATED_AT,
    })
    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0]).toEqual(['syncedSettings'])
    expect(mockStore.get('meta:settings')).toBe(plainBefore)
  })

  it('a store without any settings gets the defaults dated at the epoch', async () => {
    await migrateSyncedSettings()

    expect(await readSyncedRaw()).toEqual({
      id: 'settings',
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
      updatedAt: SETTINGS_DEFAULT_UPDATED_AT,
    })
    expect(mockStore.has('meta:settings')).toBe(false)
  })

  it('invalid legacy values count as no values: defaults dated at the epoch', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'GBP', fetchExchangeRates: 'yes' })

    await migrateSyncedSettings()

    expect(await readSyncedRaw()).toEqual({
      id: 'settings',
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
      updatedAt: SETTINGS_DEFAULT_UPDATED_AT,
    })
  })

  it('is idempotent: a second run returns false and writes nothing', async () => {
    mockStore.set('meta:settings', { ...OLD_SETTINGS })
    await migrateSyncedSettings()
    const before = new Map(mockStore)
    ctl.setManyCalls.length = 0
    setNow(T2)

    const again = await migrateSyncedSettings()
    const third = await migrateSyncedSettings()

    expect(again).toBe(false)
    expect(third).toBe(false)
    expect(ctl.setManyCalls).toHaveLength(0)
    expectUnchanged(before)
  })

  it('never overwrites a record the user already changed', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'USD' })
    await seedSynced({ mainCurrency: 'EUR' })
    const before = new Map(mockStore)

    expect(await migrateSyncedSettings()).toBe(false)

    expectUnchanged(before)
  })

  it('an unreadable existing record counts as existing: false, bytes untouched', async () => {
    const garbage = new Uint8Array(40)
    mockStore.set('syncedSettings', garbage)
    mockStore.set('meta:settings', { mainCurrency: 'EUR' })

    expect(await migrateSyncedSettings()).toBe(false)

    expect(mockStore.get('syncedSettings')).toBe(garbage)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('does nothing while the app is locked', async () => {
    mockStore.set('meta:settings', { ...OLD_SETTINGS })
    wipeLocalDbKey()

    expect(await migrateSyncedSettings()).toBe(false)

    expect(mockStore.has('syncedSettings')).toBe(false)
    expect(plainSettings().mainCurrency).toBe('EUR')
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('a failed transaction leaves the old state, and a retry migrates', async () => {
    mockStore.set('meta:settings', { ...OLD_SETTINGS })
    const plainBefore = mockStore.get('meta:settings')
    const channel = fakeChannel()
    setSyncChannel(channel)
    ctl.failSetMany = 1

    await expect(migrateSyncedSettings()).rejects.toThrow('transaction aborted')

    expect(mockStore.get('meta:settings')).toBe(plainBefore)
    expect(plainSettings().mainCurrency).toBe('EUR')
    expect(mockStore.has('syncedSettings')).toBe(false)
    expect(channel.postMessage).not.toHaveBeenCalled()
    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })

    expect(await migrateSyncedSettings()).toBe(true)
    expect((await readSyncedRaw()).mainCurrency).toBe('EUR')
  })

  it('two concurrent runs migrate once', async () => {
    mockStore.set('meta:settings', { ...OLD_SETTINGS })

    const results = await Promise.all([migrateSyncedSettings(), migrateSyncedSettings()])

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(ctl.setManyCalls).toHaveLength(1)
  })

  it('leaves the per-device settings and the language alone', async () => {
    localStorage.setItem('minima_lang', 'uk')
    mockStore.set('meta:settings', { ...OLD_SETTINGS })

    await migrateSyncedSettings()

    expect(plainSettings()).toMatchObject(PER_DEVICE)
    expect(plainSettings().lastDataChangeAt).toBe(T0)
    expect(localStorage.getItem('minima_lang')).toBe('uk')
  })
})

describe('prepareUnlockedVault runs the migration first', () => {
  it('migrates before anything else is written or converted', async () => {
    mockStore.set('meta:settings', { ...OLD_SETTINGS })
    const seenAtConversion: Array<boolean> = []
    stops.push(
      onConversionNeeded(() => {
        seenAtConversion.push(mockStore.has('syncedSettings'))
      }),
    )

    const result = await prepareUnlockedVault({ isNewVault: true })

    expect(result).toEqual({ recurringCreated: 0 })
    expect(ctl.setManyCalls[0]).toContain('syncedSettings')
    expect(ctl.setManyCalls[0]).not.toContain('categories')
    expect(ctl.setManyCalls[0]).not.toContain('incomeCategories')
    expect(seenAtConversion.length).toBeGreaterThan(0)
    expect(seenAtConversion.every(Boolean)).toBe(true)
    expect(plainSettings().mainCurrency).toBeUndefined()
    expect((await readSyncedRaw()).mainCurrency).toBe('EUR')
  })

  it('an existing vault is migrated too, and its return value is unchanged', async () => {
    mockStore.set('meta:settings', { ...OLD_SETTINGS })

    const result = await prepareUnlockedVault({ isNewVault: false })

    expect(result).toEqual({ recurringCreated: 0 })
    expect(await readSyncedRaw()).toMatchObject({
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })
  })

  it('the second unlock changes nothing more', async () => {
    mockStore.set('meta:settings', { ...OLD_SETTINGS })
    await prepareUnlockedVault({ isNewVault: false })
    const before = new Map(mockStore)
    ctl.setManyCalls.length = 0

    await prepareUnlockedVault({ isNewVault: false })

    expect(ctl.setManyCalls).toHaveLength(0)
    expectUnchanged(before)
  })

  it('the generated records use the migrated main currency', async () => {
    mockStore.set('meta:settings', { mainCurrency: 'EUR', fetchExchangeRates: true })
    await seed('categories', [{ id: 'cat1', name: 'Gym', icon: null, updatedAt: T0 }])
    const gym: RecurringItem = {
      id: 'r1',
      kind: 'expense',
      amount: 10,
      currency: 'EUR',
      categoryId: 'cat1',
      description: null,
      frequency: { unit: 'month', interval: 1 },
      startDate: '2026-05-01',
      end: { type: 'never' },
      mode: 'auto',
      paused: false,
      handledThrough: null,
      handledAhead: [],
      occurrenceCount: 0,
      createdAt: T0,
      updatedAt: T0,
    }
    await seed('recurring', [gym])

    const result = await prepareUnlockedVault({ isNewVault: false })

    expect(result.recurringCreated).toBe(1)
    const keys = Array.from(mockStore.keys()).filter((k) => k.startsWith('expenses_'))
    const records = (
      await Promise.all(keys.map((k) => readRaw<Expense>(k)))
    ).flat()
    expect(records).toHaveLength(1)
    expect(records[0].conversion).toMatchObject({
      mainCurrency: 'EUR',
      source: 'identity',
      mainAmount: 10,
    })
  })

  it('an unreadable syncedSettings record does not stop the migration step (it is left as it is)', async () => {
    const garbage = new Uint8Array(40)
    mockStore.set('syncedSettings', garbage)

    // The vault itself later opens the Data problem screen for this key; the
    // migration must never overwrite the bytes.
    await prepareUnlockedVault({ isNewVault: false }).catch(() => undefined)

    expect(mockStore.get('syncedSettings')).toBe(garbage)
  })
})

// ── Writing ───────────────────────────────────────────────────────────────────

describe('updateSyncedSettings', () => {
  it('stamps updatedAt and a new rev, keeps the main currency, and writes with meta:sync in one setMany', async () => {
    await seedSynced({ mainCurrency: 'EUR', fetchExchangeRates: true })
    setNow(T2)
    ctl.setManyCalls.length = 0

    await updateSyncedSettings({ fetchExchangeRates: false })

    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual(['meta:sync', 'syncedSettings'])
    expect(await readSyncedRaw()).toEqual({
      id: 'settings',
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
      updatedAt: T2,
      rev: 6,
    })
    expect(mockStore.get('meta:sync')).toEqual({ localRev: 6 })
  })

  it('announces syncedSettings and asks for a conversion', async () => {
    await seedSynced()
    const channel = fakeChannel()
    setSyncChannel(channel)
    const listener = listen()

    await updateSyncedSettings({ fetchExchangeRates: false })

    expect(postedKeys(channel)).toEqual(['syncedSettings'])
    expect(listener).toHaveBeenCalled()
  })

  it('on an unmigrated store it also strips the legacy fields from meta:settings', async () => {
    mockStore.set('meta:settings', { ...OLD_SETTINGS })
    const channel = fakeChannel()
    setSyncChannel(channel)
    ctl.setManyCalls.length = 0

    await updateSyncedSettings({ fetchExchangeRates: true })

    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual([
      'meta:settings',
      'meta:sync',
      'syncedSettings',
    ])
    expect(await readSyncedRaw()).toMatchObject({
      mainCurrency: 'EUR',
      fetchExchangeRates: true,
      updatedAt: T1,
      rev: 1,
    })
    expect('mainCurrency' in plainSettings()).toBe(false)
    expect('fetchExchangeRates' in plainSettings()).toBe(false)
    expect(plainSettings()).toMatchObject(PER_DEVICE)
    expect(postedKeys(channel)).toEqual(expect.arrayContaining(['syncedSettings', 'meta:settings']))
  })

  it('creates the record from the defaults when nothing exists yet', async () => {
    await updateSyncedSettings({ fetchExchangeRates: false })

    expect(await readSyncedRaw()).toEqual({
      id: 'settings',
      mainCurrency: 'UAH',
      fetchExchangeRates: false,
      updatedAt: T1,
      rev: 1,
    })
    expect(await getLocalRev()).toBe(1)
  })

  it('an empty patch writes nothing and announces nothing', async () => {
    await seedSynced()
    const before = new Map(mockStore)
    const channel = fakeChannel()
    setSyncChannel(channel)
    ctl.setManyCalls.length = 0

    await updateSyncedSettings({})

    expect(ctl.setManyCalls).toHaveLength(0)
    expect(channel.postMessage).not.toHaveBeenCalled()
    expectUnchanged(before)
  })

  it('a patch value that is not a boolean is ignored', async () => {
    await seedSynced()
    const before = new Map(mockStore)
    const junk = { fetchExchangeRates: 'no' } as unknown as { fetchExchangeRates: boolean }

    await updateSyncedSettings(junk)

    expect(ctl.setManyCalls).toHaveLength(0)
    expectUnchanged(before)
  })

  it('a DecryptError propagates and the bytes are untouched', async () => {
    const garbage = new Uint8Array(40)
    mockStore.set('syncedSettings', garbage)

    await expect(updateSyncedSettings({ fetchExchangeRates: false })).rejects.toBeInstanceOf(
      DecryptError,
    )

    expect(mockStore.get('syncedSettings')).toBe(garbage)
    expect(mockStore.has('meta:sync')).toBe(false)
  })

  it('a failed transaction changes nothing', async () => {
    await seedSynced()
    const before = new Map(mockStore)
    ctl.failSetMany = 1

    await expect(updateSyncedSettings({ fetchExchangeRates: false })).rejects.toThrow(
      'transaction aborted',
    )

    expectUnchanged(before)
  })

  it('two concurrent updates get consecutive revs', async () => {
    await seedSynced()

    await Promise.all([
      updateSyncedSettings({ fetchExchangeRates: false }),
      updateSyncedSettings({ fetchExchangeRates: true }),
    ])

    expect((await readSyncedRaw()).rev).toBe(7)
    expect(await getLocalRev()).toBe(7)
  })
})

describe('the decrypt error of syncedSettings is never hidden', () => {
  it('a save reads the main currency and fails with DecryptError instead of assuming UAH', async () => {
    mockStore.set('syncedSettings', new Uint8Array(40))

    const err = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: 'c1',
      createdAt: '2026-05-10T10:00:00.000Z',
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DecryptError)
    expect((err as DecryptError).storageKey).toBe('syncedSettings')
    expect(mockStore.has('expenses_2026_05')).toBe(false)
  })

  it('after a quarantine the defaults are back and the next write creates a fresh record', async () => {
    mockStore.set('syncedSettings', new Uint8Array(40))
    await quarantineKey('syncedSettings')

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
    })
    await updateSyncedSettings({ fetchExchangeRates: false })

    expect(await readSyncedRaw()).toMatchObject({
      mainCurrency: 'UAH',
      fetchExchangeRates: false,
    })
    expect(
      Array.from(mockStore.keys()).some((k) => k.startsWith('quarantine:syncedSettings:')),
    ).toBe(true)
  })

  it('the migration writes a fresh record at the next unlock after a quarantine', async () => {
    mockStore.set('syncedSettings', new Uint8Array(40))
    await quarantineKey('syncedSettings')

    expect(await migrateSyncedSettings()).toBe(true)

    expect(await readSyncedRaw()).toMatchObject({ id: 'settings', mainCurrency: 'UAH' })
  })

  it('syncedSettings alone counts as local data', async () => {
    expect(await hasLocalData()).toBe(false)

    await seedSynced()

    expect(await hasLocalData()).toBe(true)
  })
})

// ── convertBudgets and changeMainCurrency ─────────────────────────────────────

describe('convertBudgets writes the synced settings record', () => {
  const rates = { UAH: 1, USD: 40, EUR: 50 }

  it('with setMainCurrency the record, the budgets and meta:sync commit together, with fresh revs', async () => {
    await seed('budgets', [
      { id: 'b1', categoryId: 'c1', monthlyLimit: 100, currency: 'UAH', updatedAt: T0 },
      { id: 'b2', categoryId: 'c2', monthlyLimit: 10, currency: 'USD', updatedAt: T0 },
      { id: 'b3', categoryId: 'c3', monthlyLimit: 5, currency: 'EUR', updatedAt: T0 },
    ])
    mockStore.set('meta:settings', { ...OLD_SETTINGS, mainCurrency: 'UAH', fetchExchangeRates: true })
    setNow(T2)
    ctl.setManyCalls.length = 0

    const converted = await convertBudgets('EUR', (from) => rates[from] / rates.EUR, {
      setMainCurrency: true,
    })

    expect(converted).toBe(2)
    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual([
      'budgets',
      'meta:settings',
      'meta:sync',
      'syncedSettings',
    ])
    const record = await readSyncedRaw()
    expect(record).toMatchObject({
      id: 'settings',
      mainCurrency: 'EUR',
      fetchExchangeRates: true,
      updatedAt: T2,
    })
    const budgets = await readRaw<BudgetEntry & { rev?: number }>('budgets')
    const revs = [record.rev as number, ...budgets.filter((b) => b.id !== 'b3').map((b) => b.rev as number)]
    expect([...revs].sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect(budgets.find((b) => b.id === 'b3')?.rev).toBeUndefined()
    expect(budgets.every((b) => b.currency === 'EUR')).toBe(true)
    expect(plainSettings()).toMatchObject(PER_DEVICE)
  })

  it('changeMainCurrency converts the budgets and writes the settings atomically, bumping rev on both', async () => {
    await seed('budgets', [
      { id: 'b1', categoryId: 'c1', monthlyLimit: 100, currency: 'UAH', updatedAt: T0 },
      { id: 'b2', categoryId: 'c2', monthlyLimit: 10, currency: 'USD', updatedAt: T0 },
    ])
    await seedSynced({ mainCurrency: 'UAH', fetchExchangeRates: true })
    const table: RateTable = { base: 'UAH', effectiveDate: TODAY, perBase: rates }
    const provider: RateProvider = {
      id: 'nbu',
      getRates: vi.fn(() => Promise.resolve(table)),
    }

    const result = await changeMainCurrency('EUR', { provider, today: TODAY })

    expect(result.budgetsConverted).toBe(2)
    const record = await readSyncedRaw()
    expect(record.mainCurrency).toBe('EUR')
    expect(record.rev as number).toBeGreaterThan(5)
    const budgets = await readRaw<BudgetEntry & { rev?: number }>('budgets')
    for (const b of budgets) {
      expect(b.currency).toBe('EUR')
      expect(b.rev as number).toBeGreaterThan(5)
      expect(b.updatedAt).not.toBe(T0)
    }
    const allRevs = [record.rev as number, ...budgets.map((b) => b.rev as number)]
    expect(new Set(allRevs).size).toBe(3)
    expect((await getAllBudgets()).map((b) => b.currency)).toEqual(['EUR', 'EUR'])
  })

  it('without setMainCurrency (the one-time budget fix) stamps rev and writes no settings', async () => {
    await seedSynced({ mainCurrency: 'UAH' })
    await seed('budgets', [
      { id: 'b1', categoryId: 'c1', monthlyLimit: 10, currency: 'USD', updatedAt: T0 },
    ])
    const recordBefore = mockStore.get('syncedSettings')
    ctl.setManyCalls.length = 0

    await convertBudgets('UAH', () => 40, { setMainCurrency: false })

    expect([...ctl.setManyCalls[0]].sort()).toEqual(['budgets', 'meta:sync'])
    expect(mockStore.get('syncedSettings')).toBe(recordBefore)
    const [budget] = await readRaw<BudgetEntry & { rev?: number }>('budgets')
    expect(budget.rev).toBe(6)
    expect(await getLocalRev()).toBe(6)
  })

  it('an unreadable syncedSettings makes convertBudgets fail with DecryptError and write nothing', async () => {
    mockStore.set('syncedSettings', new Uint8Array(40))
    await seed('budgets', [
      { id: 'b1', categoryId: 'c1', monthlyLimit: 10, currency: 'USD', updatedAt: T0 },
    ])
    const budgetsBlob = mockStore.get('budgets')

    await expect(
      convertBudgets('EUR', () => 1, { setMainCurrency: true }),
    ).rejects.toBeInstanceOf(DecryptError)

    expect(mockStore.get('budgets')).toBe(budgetsBlob)
    expect(ctl.setManyCalls).toHaveLength(0)
  })
})

// ── Per-device settings and the language ──────────────────────────────────────

describe('the per-device settings and the language are never touched', () => {
  it('survive the migration, a settings update, a main-currency change and ordinary writes', async () => {
    localStorage.setItem('minima_lang', 'uk')
    mockStore.set('meta:settings', { ...OLD_SETTINGS })

    await migrateSyncedSettings()
    await updateSyncedSettings({ fetchExchangeRates: true })
    const cat = await addCategory({ name: 'Food' })
    await upsertBudget({ categoryId: cat.id, monthlyLimit: 10, currency: 'UAH' })
    await convertBudgets('USD', () => 0.025, { setMainCurrency: true })
    await addExpense({
      amount: 1,
      currency: 'USD',
      categoryId: cat.id,
      createdAt: '2026-05-10T10:00:00.000Z',
    })

    expect(plainSettings()).toMatchObject(PER_DEVICE)
    expect('mainCurrency' in plainSettings()).toBe(false)
    expect('fetchExchangeRates' in plainSettings()).toBe(false)
    expect(localStorage.getItem('minima_lang')).toBe('uk')
    expect((await readSyncedRaw()).mainCurrency).toBe('USD')
    expect(await getAllCategories()).toHaveLength(1)
  })

  it('a data write only adds lastDataChangeAt to meta:settings', async () => {
    mockStore.set('meta:settings', { autoLockMinutes: 5 })

    await addCategory({ name: 'Food' })

    expect(plainSettings()).toEqual({ autoLockMinutes: 5, lastDataChangeAt: T1 })
  })
})
