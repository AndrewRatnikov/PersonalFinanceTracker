// No CONTRACT_GAPs: BackupPayload.settings (mainCurrency, fetchExchangeRates),
// raw conversion / manualRate records, replace/merge settings rules and the
// post-restore conversion request are fully specified in the Interface
// Contract (module: backup) and plan section 12.
//
// Integration style (as backup.test.ts): real crypto, real vault, real
// localDb, idb-keyval backed by a Map. A backup from before this change is
// built by re-encrypting a created payload without the new fields.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackupPayload, MinimaBackupV1 } from '@/lib/backup'
import type { Expense, IncomeEntry } from '@/lib/domain'
import type { RateProvider, RateTable } from '@/lib/rates/types'
import { getCurrencySettings, updateCurrencySettings } from '@/lib/appSettings'
import {
  createBackup,
  restoreBackup,
  serializeBackup,
} from '@/lib/backup'
import { convertPending } from '@/lib/conversion'
import { base64ToBytes, bytesToBase64, decryptValue, encryptValue } from '@/lib/crypto'
import {
  addCategory,
  addExpense,
  addIncome,
  addIncomeCategory,
  applyEntryConversions,
  convertBudgets,
  deleteExpense,
  getAllExpenses,
  getAllIncome,
  getLocalDbKey,
  onConversionNeeded,
  upsertBudget,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'
import {
  META_SETTINGS_KEY,
  createVault,
  lockVault,
  openHeaderWithSecret,
} from '@/lib/vault'

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
vi.mock('@/lib/fileDownload', () => ({ saveFile: vi.fn() }))

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const PW = 'correct horse battery'
const T1 = '2026-03-01T10:00:00.000Z'
const T2 = '2026-03-02T10:00:00.000Z'
const FEB_3 = '2026-02-03T08:00:00.000Z'
const FEB_4 = '2026-02-04T08:00:00.000Z'
const FEB_CHUNK = 'expenses_2026_02'
const RATES = { UAH: 1, USD: 41.52, EUR: 45.1 }

let stops: Array<() => void> = []

function table(date: string): RateTable {
  return { base: 'UAH', effectiveDate: date, perBase: RATES }
}

function fakeProvider(): RateProvider {
  return {
    id: 'nbu',
    getRates: vi.fn((date: string) => Promise.resolve(table(date))),
  }
}

async function setupDevice(): Promise<void> {
  await createVault(PW)
}

function wipe() {
  lockVault()
  mockStore.clear()
}

function storedSettings() {
  return mockStore.get(META_SETTINGS_KEY) as Record<string, unknown>
}

async function readPayload(
  backup: MinimaBackupV1,
  secret = PW,
): Promise<BackupPayload> {
  const dek = await openHeaderWithSecret(backup.vault, secret)
  if (!dek) throw new Error('the secret did not open the backup')
  let bytes = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(backup.payload.iv) },
      dek,
      base64ToBytes(backup.payload.ct),
    ),
  )
  if (backup.payload.enc === 'gzip+aes-gcm') {
    const body = new Response(bytes).body
    if (!body) throw new Error('no body')
    bytes = new Uint8Array(
      await new Response(
        body.pipeThrough(new DecompressionStream('gzip')),
      ).arrayBuffer(),
    )
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as BackupPayload
}

// Re-encrypts a changed payload with the backup's own key (plain aes-gcm).
async function rewritePayload(
  backup: MinimaBackupV1,
  mutate: (payload: BackupPayload) => unknown,
): Promise<MinimaBackupV1> {
  const payload = await readPayload(backup)
  const dek = await openHeaderWithSecret(backup.vault, PW)
  if (!dek) throw new Error('the secret did not open the backup')
  const bytes = new TextEncoder().encode(JSON.stringify(mutate(payload)))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, bytes),
  )
  return {
    ...backup,
    payload: { enc: 'aes-gcm', iv: bytesToBase64(iv), ct: bytesToBase64(ct) },
  }
}

function withoutConversionFields<T extends object>(record: T): T {
  const copy: Record<string, unknown> = { ...record }
  delete copy.conversion
  delete copy.manualRate
  return copy as T
}

// Writes a patch into one stored record (for fields no public function sets).
async function patchStoredRecord(
  storageKey: string,
  id: string,
  patch: Partial<Expense> | Partial<IncomeEntry>,
) {
  const dek = getLocalDbKey()
  const raw = mockStore.get(storageKey)
  if (!dek || !(raw instanceof Uint8Array)) throw new Error('cannot patch')
  const list = (await decryptValue(dek, raw)) as Array<{ id: string }>
  mockStore.set(
    storageKey,
    await encryptValue(
      dek,
      list.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    ),
  )
}

async function seedConverted() {
  const food = await addCategory({ name: 'Food' })
  const job = await addIncomeCategory({ name: 'Job' })
  const usd = await addExpense({
    amount: 20,
    currency: 'USD',
    categoryId: food.id,
    createdAt: FEB_3,
  })
  const uah = await addExpense({
    amount: 100,
    currency: 'UAH',
    categoryId: food.id,
    createdAt: FEB_4,
  })
  const salary = await addIncome({
    categoryId: job.id,
    amount: 50,
    currency: 'EUR',
    createdAt: FEB_3,
  })
  await applyEntryConversions(FEB_CHUNK, 'UAH', [
    {
      id: usd.id,
      amount: 20,
      currency: 'USD',
      createdAt: FEB_3,
      conversion: {
        mainCurrency: 'UAH',
        rate: 41.52,
        mainAmount: 20 * 41.52,
        rateDate: '2026-02-03',
        source: 'nbu',
      },
    },
  ])
  await applyEntryConversions('income', 'UAH', [
    {
      id: salary.id,
      amount: 50,
      currency: 'EUR',
      createdAt: FEB_3,
      conversion: {
        mainCurrency: 'UAH',
        rate: 45.1,
        mainAmount: 50 * 45.1,
        rateDate: '2026-02-03',
        source: 'nbu',
      },
    },
  ])
  await patchStoredRecord(FEB_CHUNK, uah.id, {
    manualRate: { mainCurrency: 'EUR', rate: 0.0222 },
  })
  return { food, job, usd, uah, salary }
}

beforeEach(() => {
  mockStore.clear()
  localStorage.clear()
  lockVault()
  stops = []
  setSyncChannel(null)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(T1))
})

afterEach(() => {
  for (const stop of stops) stop()
  vi.useRealTimers()
  setSyncChannel(undefined)
})

describe('createBackup settings and records', () => {
  it('carries mainCurrency and fetchExchangeRates in payload.settings', async () => {
    await setupDevice()

    const defaults = (await readPayload(await createBackup())).settings
    expect(defaults.mainCurrency).toBe('UAH')
    expect(defaults.fetchExchangeRates).toBe(true)

    await convertBudgets('EUR', () => 1, { setMainCurrency: true })
    await updateCurrencySettings({ fetchExchangeRates: false })

    const changed = (await readPayload(await createBackup())).settings
    expect(changed.mainCurrency).toBe('EUR')
    expect(changed.fetchExchangeRates).toBe(false)
    expect(typeof changed.autoLockMinutes).toBe('number')
    expect(typeof changed.backupReminderDays).toBe('number')
  })

  it('keeps conversion and manualRate on the raw records and leaves the version at 1', async () => {
    await setupDevice()
    const s = await seedConverted()

    const backup = await createBackup()
    const payload = await readPayload(backup)

    expect(backup.version).toBe(1)
    expect(payload.schemaVersion).toBe(1)
    const usd = payload.expenses.find((e) => e.id === s.usd.id)
    const uah = payload.expenses.find((e) => e.id === s.uah.id)
    expect(usd?.conversion).toEqual({
      mainCurrency: 'UAH',
      rate: 41.52,
      mainAmount: 20 * 41.52,
      rateDate: '2026-02-03',
      source: 'nbu',
    })
    expect(uah?.conversion?.source).toBe('identity')
    expect(uah?.manualRate).toEqual({ mainCurrency: 'EUR', rate: 0.0222 })
    expect(payload.income[0].conversion?.mainAmount).toBe(50 * 45.1)
  })

  it('round trip: conversion fields come back unchanged', async () => {
    await setupDevice()
    await seedConverted()
    const beforeExpenses = await getAllExpenses()
    const beforeIncome = await getAllIncome()
    const text = serializeBackup(await createBackup())
    wipe()

    await restoreBackup(text, PW, 'replace')

    const expenses = await getAllExpenses()
    const income = await getAllIncome()
    expect(expenses.map((e) => e.conversion)).toEqual(
      beforeExpenses.map((e) => e.conversion),
    )
    expect(expenses.map((e) => e.manualRate)).toEqual(
      beforeExpenses.map((e) => e.manualRate),
    )
    expect(income.map((i) => i.conversion)).toEqual(
      beforeIncome.map((i) => i.conversion),
    )
    expect(expenses.some((e) => e.conversion?.source === 'nbu')).toBe(true)
  })
})

describe('restoring the currency settings', () => {
  async function backupWithMain(main: 'EUR' | 'USD', fetchRates: boolean) {
    await convertBudgets(main, () => 1, { setMainCurrency: true })
    await updateCurrencySettings({ fetchExchangeRates: fetchRates })
    return createBackup()
  }

  function setLocalCurrencySettings(main: string, fetchRates: boolean) {
    mockStore.set(META_SETTINGS_KEY, {
      ...storedSettings(),
      mainCurrency: main,
      fetchExchangeRates: fetchRates,
    })
  }

  it('replace restores them', async () => {
    await setupDevice()
    const text = serializeBackup(await backupWithMain('EUR', false))
    setLocalCurrencySettings('UAH', true)
    await upsertBudget({ categoryId: 'c1', monthlyLimit: 5, currency: 'UAH' })

    await restoreBackup(text, PW, 'replace')

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })
  })

  it('replace on a fresh device restores them too', async () => {
    await setupDevice()
    const text = serializeBackup(await backupWithMain('USD', false))
    wipe()

    await restoreBackup(text, PW, 'replace')

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'USD',
      fetchExchangeRates: false,
    })
  })

  it('replace keeps the local values when the payload values are invalid', async () => {
    await setupDevice()
    const backup = await backupWithMain('EUR', false)
    const broken = await rewritePayload(backup, (p) => ({
      ...p,
      settings: { ...p.settings, mainCurrency: 'GBP', fetchExchangeRates: 'yes' },
    }))
    setLocalCurrencySettings('USD', true)

    await restoreBackup(serializeBackup(broken), PW, 'replace')

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'USD',
      fetchExchangeRates: true,
    })
  })

  it('replace keeps the local values when the payload has none (a backup from before this change)', async () => {
    await setupDevice()
    const backup = await backupWithMain('EUR', false)
    const legacy = await rewritePayload(backup, (p) => {
      const settings: Record<string, unknown> = { ...p.settings }
      delete settings.mainCurrency
      delete settings.fetchExchangeRates
      return { ...p, settings }
    })
    setLocalCurrencySettings('USD', true)

    await restoreBackup(serializeBackup(legacy), PW, 'replace')

    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'USD',
      fetchExchangeRates: true,
    })
  })

  it('merge keeps the local values', async () => {
    await setupDevice()
    const food = await addCategory({ name: 'Food' })
    const e = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: food.id,
      createdAt: FEB_3,
    })
    const text = serializeBackup(await backupWithMain('EUR', false))
    setLocalCurrencySettings('USD', true)
    await deleteExpense(e.id, e.createdAt)

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary.added).toBeGreaterThan(0)
    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'USD',
      fetchExchangeRates: true,
    })
  })
})

describe('a backup from before this change', () => {
  async function legacyBackup() {
    const s = await seedConverted()
    const backup = await createBackup()
    return rewritePayload(backup, (p) => {
      const settings: Record<string, unknown> = { ...p.settings }
      delete settings.mainCurrency
      delete settings.fetchExchangeRates
      return {
        ...p,
        expenses: p.expenses.map(withoutConversionFields),
        income: p.income.map(withoutConversionFields),
        settings,
      }
    }).then((b) => ({ backup: b, ...s }))
  }

  it('restores with no conversion on any record (so everything is pending)', async () => {
    await setupDevice()
    const { backup } = await legacyBackup()
    wipe()

    await restoreBackup(serializeBackup(backup), PW, 'replace')

    const expenses = await getAllExpenses()
    expect(expenses).toHaveLength(2)
    expect(expenses.every((e) => e.conversion === undefined)).toBe(true)
    expect(expenses.every((e) => e.manualRate === undefined)).toBe(true)
    expect((await getAllIncome()).every((i) => i.conversion === undefined)).toBe(true)
    expect(await getCurrencySettings()).toEqual({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
    })
  })

  it('is converted by the next conversion run', async () => {
    await setupDevice()
    const { backup } = await legacyBackup()
    wipe()
    await restoreBackup(serializeBackup(backup), PW, 'replace')
    const provider = fakeProvider()

    const result = await convertPending({ provider, today: '2026-03-02' })

    expect(result).toEqual({ converted: 3, stillPending: 0 })
    const expenses = await getAllExpenses()
    expect(expenses.find((e) => e.currency === 'USD')?.conversion?.mainAmount).toBe(
      20 * 41.52,
    )
    expect(expenses.find((e) => e.currency === 'UAH')?.conversion?.source).toBe(
      'identity',
    )
  })

  it('merged records of another main currency are converted into the local one', async () => {
    await setupDevice()
    const food = await addCategory({ name: 'Food' })
    const seeded = await addExpense({
      amount: 20,
      currency: 'USD',
      categoryId: food.id,
      createdAt: FEB_3,
    })
    await applyEntryConversions(FEB_CHUNK, 'UAH', [
      {
        id: seeded.id,
        amount: 20,
        currency: 'USD',
        createdAt: FEB_3,
        conversion: {
          mainCurrency: 'UAH',
          rate: 41.52,
          mainAmount: 830.4,
          rateDate: '2026-02-03',
          source: 'nbu',
        },
      },
    ])
    const text = serializeBackup(await createBackup())
    await deleteExpense(seeded.id, seeded.createdAt)
    await convertBudgets('EUR', () => 1, { setMainCurrency: true })

    await restoreBackup(text, PW, 'merge')
    const stored = (await getAllExpenses())[0]
    expect(stored.conversion?.mainCurrency).toBe('UAH') // stale for EUR: pending
    await convertPending({ provider: fakeProvider(), today: '2026-03-02' })

    const converted = (await getAllExpenses())[0]
    expect(converted.conversion?.mainCurrency).toBe('EUR')
    expect(converted.conversion?.rate).toBeCloseTo(41.52 / 45.1, 12)
  })
})

describe('restoreBackup asks for a conversion run', () => {
  function listen() {
    const listener = vi.fn()
    stops.push(onConversionNeeded(listener))
    return listener
  }

  it('after a replace restore on a fresh device', async () => {
    await setupDevice()
    await seedConverted()
    const text = serializeBackup(await createBackup())
    wipe()
    const listener = listen()

    await restoreBackup(text, PW, 'replace')

    expect(listener).toHaveBeenCalled()
  })

  it('after a replace restore on an existing device', async () => {
    await setupDevice()
    await seedConverted()
    const text = serializeBackup(await createBackup())
    const listener = listen()

    await restoreBackup(text, PW, 'replace')

    expect(listener).toHaveBeenCalled()
  })

  it('after a merge that wrote, but not after a merge that wrote nothing', async () => {
    await setupDevice()
    const s = await seedConverted()
    const text = serializeBackup(await createBackup())
    await deleteExpense(s.usd.id, s.usd.createdAt)
    const listener = listen()

    await restoreBackup(text, PW, 'merge')
    expect(listener).toHaveBeenCalled()

    listener.mockClear()
    vi.setSystemTime(new Date(T2))
    await restoreBackup(text, PW, 'merge')
    expect(listener).not.toHaveBeenCalled()
  })

  it('not when the restore is rejected', async () => {
    await setupDevice()
    await seedConverted()
    const text = serializeBackup(await createBackup())
    const listener = listen()

    await expect(restoreBackup(text, 'wrong password 123', 'replace')).rejects.toThrow()

    expect(listener).not.toHaveBeenCalled()
  })
})
