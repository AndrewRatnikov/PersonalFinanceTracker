// CONTRACT_GAP 6 (plan): a tombstone in a backup for an id the device has never
//   seen is stored and counts as `added`. Tested as stated in the plan.
// CONTRACT_GAP: the plan does not say how the restore summary counts a record
//   that was written because the backup won a same-time conflict (it says only
//   "counted in the per-collection count, not in added / updated"). Tested as
//   stated: the per-collection count and `conflicts` go up, added and updated
//   do not.
// CONTRACT_GAP: the plan does not give the order of the records inside a key
//   after a replace restore (backup records, then local tombstones). Records
//   are looked up by id.
//
// Integration style (as backup.test.ts): real crypto, real vault, real
// localDb, idb-keyval backed by a Map. Two "branches" of one device are built
// with cloneStore / revertTo so the same clock gives equal timestamps.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackupPayload, MinimaBackupV1 } from '@/lib/backup'
import type { SyncChannel } from '@/lib/syncChannel'
import {
  BACKUP_VERSION,
  createBackup,
  defaultRestoreMode,
  parseBackupFile,
  restoreBackup,
  serializeBackup,
} from '@/lib/backup'
import { base64ToBytes, bytesToBase64, decryptValue } from '@/lib/crypto'
import { DecryptError } from '@/lib/dataErrors'
import {
  addCategory,
  addExpense,
  addIncome,
  addIncomeCategory,
  addRecurring,
  convertBudgets,
  deleteBudget,
  deleteCategory,
  deleteExpense,
  deleteIncome,
  deleteIncomeCategory,
  deleteRecurring,
  ensureIncomeCategories,
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getAllIncomeCategories,
  getAllRecurring,
  getLocalDbKey,
  getLocalRev,
  listChangedRecords,
  readSyncedSettings,
  updateExpense,
  updateSyncedSettings,
  upsertBudget,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'
import {
  META_SETTINGS_KEY,
  createVault,
  getVaultState,
  lockVault,
  openHeaderWithSecret,
} from '@/lib/vault'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: {
    failSetMany: false,
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
vi.mock('@/lib/fileDownload', () => ({ saveFile: vi.fn() }))

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const PW = 'correct horse battery'
const PW2 = 'second password 456'

const T1 = '2026-03-01T10:00:00.000Z'
const T2 = '2026-03-02T10:00:00.000Z'
const T3 = '2026-03-03T10:00:00.000Z'
const T4 = '2026-03-04T10:00:00.000Z'
const FEB_3 = '2026-02-03T08:00:00.000Z'
const FEB_CHUNK = 'expenses_2026_02'

function setNow(iso: string) {
  vi.setSystemTime(new Date(iso))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupDevice(password = PW): Promise<void> {
  await createVault(password)
}

function wipe() {
  lockVault()
  mockStore.clear()
}

function cloneStore(): Map<string, unknown> {
  const copy = new Map<string, unknown>()
  for (const [key, value] of mockStore) {
    copy.set(
      key,
      value instanceof Uint8Array
        ? new Uint8Array(value)
        : JSON.parse(JSON.stringify(value)),
    )
  }
  return copy
}

function revertTo(saved: Map<string, unknown>) {
  mockStore.clear()
  for (const [key, value] of saved) {
    mockStore.set(
      key,
      value instanceof Uint8Array
        ? new Uint8Array(value)
        : JSON.parse(JSON.stringify(value)),
    )
  }
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

async function readRaw<T = Record<string, unknown>>(key: string): Promise<Array<T>> {
  const dek = getLocalDbKey()
  const raw = mockStore.get(key)
  if (!dek || !(raw instanceof Uint8Array)) throw new Error(`cannot read ${key}`)
  return (await decryptValue(dek, raw)) as Array<T>
}

async function readSyncedRaw(): Promise<Record<string, unknown>> {
  const dek = getLocalDbKey()
  const raw = mockStore.get('syncedSettings')
  if (!dek || !(raw instanceof Uint8Array)) throw new Error('cannot read syncedSettings')
  return (await decryptValue(dek, raw)) as Record<string, unknown>
}

async function readPayload(backup: MinimaBackupV1, secret = PW): Promise<BackupPayload> {
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

// A small vault: one category, one income category, one expense (a USD ride on
// Feb 3), one income and one budget.
async function seedSmall() {
  const food = await addCategory({ name: 'Food', icon: '🍔' })
  const job = await addIncomeCategory({ name: 'Job' })
  const ride = await addExpense({
    amount: 7,
    currency: 'USD',
    categoryId: food.id,
    createdAt: FEB_3,
  })
  const salary = await addIncome({
    categoryId: job.id,
    amount: 1000,
    currency: 'USD',
    createdAt: '2026-02-01T09:15:00.000Z',
  })
  const budget = await upsertBudget({
    categoryId: food.id,
    monthlyLimit: 500,
    currency: 'UAH',
  })
  return { food, job, ride, salary, budget }
}

beforeEach(() => {
  mockStore.clear()
  localStorage.clear()
  lockVault()
  ctl.failSetMany = false
  ctl.setManyCalls.length = 0
  setSyncChannel(null)
  vi.useFakeTimers({ toFake: ['Date'] })
  setNow(T1)
})

afterEach(() => {
  vi.useRealTimers()
  setSyncChannel(undefined)
})

// ── What goes into the file ───────────────────────────────────────────────────

describe('createBackup: tombstones in, rev out', () => {
  it('rev never appears in the payload, although the stored records carry it', async () => {
    await setupDevice()
    const s = await seedSmall()
    await addRecurring(
      {
        kind: 'expense',
        amount: 5,
        currency: 'UAH',
        categoryId: s.food.id,
        frequency: { unit: 'month', interval: 1 },
        startDate: '2026-02-15',
        end: { type: 'never' },
        mode: 'auto',
      },
      { createThroughToday: true, today: '2026-03-01' },
    )
    await updateSyncedSettings({ fetchExchangeRates: false })
    const stored = await readRaw<{ rev?: number }>('categories')
    expect(typeof stored[0].rev).toBe('number')
    expect(typeof (await readSyncedRaw()).rev).toBe('number')

    const payload = await readPayload(await createBackup())

    const text = JSON.stringify(payload)
    expect(text).not.toContain('"rev"')
    expect(payload.expenses.length).toBeGreaterThan(1)
    expect(payload.recurring?.length).toBe(1)
    for (const list of [
      payload.categories,
      payload.incomeCategories ?? [],
      payload.expenses,
      payload.income,
      payload.budgets,
      payload.recurring ?? [],
    ]) {
      for (const record of list) expect('rev' in record).toBe(false)
    }
  })

  it('keeps deletedAt on tombstones of every type', async () => {
    await setupDevice()
    const s = await seedSmall()
    const spareCategory = await addCategory({ name: 'Spare' })
    const spareIncomeCategory = await addIncomeCategory({ name: 'Spare income' })
    const item = await addRecurring(
      {
        kind: 'expense',
        amount: 5,
        currency: 'UAH',
        categoryId: s.food.id,
        frequency: { unit: 'month', interval: 1 },
        startDate: '2026-03-15',
        end: { type: 'never' },
        mode: 'ask',
      },
      { createThroughToday: false, today: '2026-03-01' },
    )
    setNow(T2)
    await deleteExpense(s.ride.id, s.ride.createdAt)
    await deleteIncome(s.salary.id)
    await deleteBudget(s.budget.id)
    await deleteCategory(spareCategory.id)
    await deleteIncomeCategory(spareIncomeCategory.id)
    await deleteRecurring(item.id)

    const payload = await readPayload(await createBackup())

    const tomb = <T extends { id: string }>(list: Array<T>, id: string) =>
      list.find((r) => r.id === id) as (T & { deletedAt?: string; updatedAt?: string }) | undefined
    expect(tomb(payload.expenses, s.ride.id)?.deletedAt).toBe(T2)
    expect(tomb(payload.income, s.salary.id)?.deletedAt).toBe(T2)
    expect(tomb(payload.budgets, s.budget.id)?.deletedAt).toBe(T2)
    expect(tomb(payload.categories, spareCategory.id)?.deletedAt).toBe(T2)
    expect(tomb(payload.incomeCategories ?? [], spareIncomeCategory.id)?.deletedAt).toBe(T2)
    expect(tomb(payload.recurring ?? [], item.id)?.deletedAt).toBe(T2)
    // A tombstone keeps its updatedAt too, and live records have no deletedAt.
    expect(tomb(payload.expenses, s.ride.id)?.updatedAt).toBe(T2)
    expect('deletedAt' in (tomb(payload.categories, s.food.id) ?? {})).toBe(false)
  })

  it('keeps the version at 1 and the schema at 1', async () => {
    await setupDevice()
    await seedSmall()

    const backup = await createBackup()
    const payload = await readPayload(backup)

    expect(BACKUP_VERSION).toBe(1)
    expect(backup.version).toBe(1)
    expect(payload.schemaVersion).toBe(1)
    expect(parseBackupFile(serializeBackup(backup)).version).toBe(1)
  })

  it('takes the currency settings from the syncedSettings record', async () => {
    await setupDevice()
    await convertBudgets('EUR', () => 1, { setMainCurrency: true })
    await updateSyncedSettings({ fetchExchangeRates: false })

    const { settings } = await readPayload(await createBackup())

    expect(settings.mainCurrency).toBe('EUR')
    expect(settings.fetchExchangeRates).toBe(false)
  })

  it('falls back to the legacy plaintext fields while the record does not exist', async () => {
    await setupDevice()
    mockStore.set(META_SETTINGS_KEY, {
      ...(mockStore.get(META_SETTINGS_KEY) as Record<string, unknown>),
      mainCurrency: 'USD',
      fetchExchangeRates: false,
    })

    const { settings } = await readPayload(await createBackup())

    expect(settings.mainCurrency).toBe('USD')
    expect(settings.fetchExchangeRates).toBe(false)
  })

  it('the settings record is not mistaken for a list of records', async () => {
    await setupDevice()
    await seedSmall()
    await updateSyncedSettings({ fetchExchangeRates: false })

    const payload = await readPayload(await createBackup())

    for (const list of [payload.expenses, payload.income, payload.budgets, payload.categories]) {
      expect(list.map((r) => r.id)).not.toContain('settings')
    }
  })

  it('an unreadable syncedSettings fails the backup, and with allowPartial it is skipped and the currency fields are left out', async () => {
    await setupDevice()
    await seedSmall()
    mockStore.set('syncedSettings', crypto.getRandomValues(new Uint8Array(64)))

    const err = await createBackup().then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(DecryptError)
    expect((err as DecryptError).storageKey).toBe('syncedSettings')

    const backup = await createBackup({ allowPartial: true })
    expect(backup.skipped).toEqual(['syncedSettings'])
    const { settings } = await readPayload(backup)
    expect('mainCurrency' in settings).toBe(false)
    expect('fetchExchangeRates' in settings).toBe(false)
    expect(typeof settings.autoLockMinutes).toBe('number')
  })
})

// ── Restoring: rev and old backups ────────────────────────────────────────────

describe('restoreBackup: rev is local bookkeeping', () => {
  it('a rev inside the file is dropped: the restored records get fresh revs', async () => {
    await setupDevice()
    await seedSmall()
    const backup = await createBackup()
    const withRev = await rewritePayload(backup, (p) => {
      const mark = (list: Array<object>) => list.map((r) => ({ ...r, rev: 999 }))
      return {
        ...p,
        categories: mark(p.categories),
        incomeCategories: mark(p.incomeCategories ?? []),
        expenses: mark(p.expenses),
        income: mark(p.income),
        budgets: mark(p.budgets),
      }
    })
    wipe()

    await restoreBackup(serializeBackup(withRev), PW, 'replace')

    const revs: Array<unknown> = []
    for (const key of ['categories', 'incomeCategories', 'income', 'budgets', FEB_CHUNK]) {
      for (const record of await readRaw<{ rev?: number }>(key)) revs.push(record.rev)
    }
    expect(revs.length).toBe(5)
    expect(revs.every((rev) => typeof rev === 'number' && rev !== 999)).toBe(true)
    expect(new Set(revs).size).toBe(5)
    expect(JSON.stringify(await getAllExpenses())).not.toContain('"rev"')
  })

  it('a backup made before this change (no deletedAt, no rev, no currency settings) restores unchanged', async () => {
    await setupDevice()
    await seedSmall()
    const before = await getAllExpenses()
    const old = await rewritePayload(await createBackup(), (p) => {
      const settings: Record<string, unknown> = { ...p.settings }
      delete settings.mainCurrency
      delete settings.fetchExchangeRates
      return { ...p, settings }
    })
    wipe()

    const summary = await restoreBackup(serializeBackup(old), PW, 'replace')

    expect(summary).toMatchObject({
      mode: 'replace',
      expenses: 1,
      income: 1,
      categories: 1,
      incomeCategories: 1,
      budgets: 1,
      conflicts: 0,
    })
    expect(await getAllExpenses()).toEqual(before)
    expect(await readSyncedSettings()).toMatchObject({
      mainCurrency: 'UAH',
      fetchExchangeRates: true,
    })
  })

  it('every restored record is a local change: consecutive revs and a matching meta:sync, in the one setMany', async () => {
    await setupDevice()
    await seedSmall()
    const text = serializeBackup(await createBackup())
    wipe()
    ctl.setManyCalls.length = 0

    await restoreBackup(text, PW, 'replace')

    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0]).toContain('meta:sync')
    expect(ctl.setManyCalls[0]).toContain('syncedSettings')
    const { records, maxRev } = await listChangedRecords(0)
    expect(maxRev).toBe(await getLocalRev())
    expect(maxRev).toBeGreaterThan(0)
    // Five records and the settings record: no gaps and no duplicates.
    expect(records).toHaveLength(6)
    expect(maxRev).toBe(6)
  })

  it('a tombstone in the backup is restored as a tombstone, with its own deletedAt', async () => {
    await setupDevice()
    const s = await seedSmall()
    setNow(T2)
    await deleteExpense(s.ride.id, s.ride.createdAt)
    const text = serializeBackup(await createBackup())
    wipe()
    setNow(T3)

    await restoreBackup(text, PW, 'replace')

    expect(await getAllExpenses()).toEqual([])
    const [raw] = await readRaw<{ id: string; deletedAt?: string; updatedAt?: string }>(
      FEB_CHUNK,
    )
    expect(raw.id).toBe(s.ride.id)
    expect(raw.deletedAt).toBe(T2)
    expect(raw.updatedAt).toBe(T2)
  })
})

// ── Merge ─────────────────────────────────────────────────────────────────────

describe('restoreBackup merge: tombstones and ties', () => {
  // The device at T1 with one category and one USD ride.
  async function baseDevice() {
    await setupDevice()
    const food = await addCategory({ name: 'Food' })
    const ride = await addExpense({
      amount: 7,
      currency: 'USD',
      categoryId: food.id,
      createdAt: FEB_3,
    })
    return { food, ride, base: cloneStore() }
  }

  it('a newer tombstone in the backup deletes the local record', async () => {
    const { ride, base } = await baseDevice()
    setNow(T2)
    await deleteExpense(ride.id, ride.createdAt)
    const text = serializeBackup(await createBackup())
    revertTo(base)
    setNow(T3)
    const revBefore = await getLocalRev()
    ctl.setManyCalls.length = 0

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary).toMatchObject({
      mode: 'merge',
      expenses: 1,
      added: 0,
      updated: 1,
      conflicts: 0,
    })
    expect(await getAllExpenses()).toEqual([])
    const [raw] = await readRaw<{ id: string; deletedAt?: string; updatedAt?: string; rev?: number }>(
      FEB_CHUNK,
    )
    expect(raw.id).toBe(ride.id)
    // It keeps its own times and gets a fresh rev in the same setMany as meta:sync.
    expect(raw.deletedAt).toBe(T2)
    expect(raw.updatedAt).toBe(T2)
    expect(raw.rev).toBe(revBefore + 1)
    expect(await getLocalRev()).toBe(revBefore + 1)
    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0]).toEqual(expect.arrayContaining([FEB_CHUNK, 'meta:sync']))
    expect((await listChangedRecords(revBefore)).records.map((r) => r.id)).toEqual([ride.id])
  })

  it('an older tombstone in the backup does not delete a newer local edit', async () => {
    const { ride, base } = await baseDevice()
    setNow(T2)
    await deleteExpense(ride.id, ride.createdAt)
    const text = serializeBackup(await createBackup())
    revertTo(base)
    setNow(T3)
    await updateExpense(ride.id, ride.createdAt, { amount: 99 })
    ctl.setManyCalls.length = 0

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary).toMatchObject({ expenses: 0, added: 0, updated: 0, conflicts: 0 })
    expect((await getAllExpenses())[0].amount).toBe(99)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('a tombstone wins an equal-time tie: the record is deleted and the tie is counted', async () => {
    const { ride, base } = await baseDevice()
    setNow(T2)
    await deleteExpense(ride.id, ride.createdAt)
    const text = serializeBackup(await createBackup())
    revertTo(base)
    await updateExpense(ride.id, ride.createdAt, { amount: 99 })

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary).toMatchObject({ expenses: 1, added: 0, updated: 0, conflicts: 1 })
    expect(await getAllExpenses()).toEqual([])
  })

  it('a live local record also loses to a backup tombstone at the same time when it is the larger JSON', async () => {
    const { ride, base } = await baseDevice()
    setNow(T2)
    await deleteExpense(ride.id, ride.createdAt)
    const text = serializeBackup(await createBackup())
    revertTo(base)
    // zzz sorts after any tombstone field, yet the tombstone still wins.
    await updateExpense(ride.id, ride.createdAt, { description: 'zzzzzzzz' })

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary.conflicts).toBe(1)
    expect(await getAllExpenses()).toEqual([])
  })

  it('without a tombstone the larger canonical JSON wins an equal-time tie: the backup can win, and is written', async () => {
    const { ride, base } = await baseDevice()
    setNow(T2)
    await updateExpense(ride.id, ride.createdAt, { amount: 50 })
    const text = serializeBackup(await createBackup())
    revertTo(base)
    await updateExpense(ride.id, ride.createdAt, { amount: 40 })
    const revBefore = await getLocalRev()
    ctl.setManyCalls.length = 0

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary).toMatchObject({ expenses: 1, added: 0, updated: 0, conflicts: 1 })
    expect((await getAllExpenses())[0].amount).toBe(50)
    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0]).toContain('meta:sync')
    expect(await getLocalRev()).toBe(revBefore + 1)
  })

  it('a tombstone for an id this device never had is stored and counts as added', async () => {
    await setupDevice(PW)
    const food = await addCategory({ name: 'Food' })
    const ride = await addExpense({
      amount: 7,
      currency: 'USD',
      categoryId: food.id,
      createdAt: FEB_3,
    })
    setNow(T2)
    await deleteExpense(ride.id, ride.createdAt)
    const text = serializeBackup(await createBackup())
    wipe()
    await setupDevice(PW2)

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary).toMatchObject({ expenses: 1, categories: 1, added: 2, updated: 0 })
    expect(await getAllExpenses()).toEqual([])
    const [raw] = await readRaw<{ id: string; deletedAt?: string }>(FEB_CHUNK)
    expect(raw.id).toBe(ride.id)
    expect(raw.deletedAt).toBe(T2)
  })

  it('merging a newer record from the backup stamps a fresh rev next to meta:sync', async () => {
    const { ride, base } = await baseDevice()
    setNow(T2)
    await updateExpense(ride.id, ride.createdAt, { amount: 12 })
    const text = serializeBackup(await createBackup())
    revertTo(base)
    setNow(T3)
    const revBefore = await getLocalRev()

    await restoreBackup(text, PW, 'merge')

    const [raw] = await readRaw<{ amount: number; updatedAt: string; rev: number }>(FEB_CHUNK)
    expect(raw.amount).toBe(12)
    expect(raw.updatedAt).toBe(T2)
    expect(raw.rev).toBe(revBefore + 1)
  })

  it('merge leaves the local synced settings alone', async () => {
    await setupDevice(PW)
    await addCategory({ name: 'Food' })
    await convertBudgets('USD', () => 1, { setMainCurrency: true })
    const text = serializeBackup(await createBackup())
    wipe()
    await setupDevice(PW2)
    await convertBudgets('EUR', () => 1, { setMainCurrency: true })
    const recordBefore = mockStore.get('syncedSettings')
    ctl.setManyCalls.length = 0

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary.added).toBeGreaterThan(0)
    expect(ctl.setManyCalls[0]).not.toContain('syncedSettings')
    expect(mockStore.get('syncedSettings')).toBe(recordBefore)
    expect((await readSyncedSettings()).mainCurrency).toBe('EUR')
    expect(Array.isArray(await readSyncedRaw())).toBe(false)
  })

  it('merge reuses only live local income categories by name when converting a legacy payload', async () => {
    await setupDevice()
    await ensureIncomeCategories()
    const salary = (await getAllIncomeCategories()).find((c) => c.name === 'Salary')
    if (!salary) throw new Error('expected the Salary default')
    await deleteIncomeCategory(salary.id)
    const legacy = await rewritePayload(await createBackup(), (p) => {
      const copy = { ...p }
      delete copy.incomeCategories
      copy.income = [
        {
          id: 'li1',
          source: 'Salary',
          amount: 1000,
          currency: 'UAH',
          createdAt: '2026-02-01T09:00:00.000Z',
          updatedAt: '2026-01-05T08:00:00.000Z',
        },
      ] as unknown as BackupPayload['income']
      return copy
    })

    await restoreBackup(serializeBackup(legacy), PW, 'merge')

    const entry = (await getAllIncome()).find((i) => i.id === 'li1')
    expect(entry?.category?.name).toBe('Salary')
    expect(entry?.categoryId).not.toBe(salary.id)
    expect((await getAllIncomeCategories()).filter((c) => c.name === 'Salary')).toHaveLength(1)
  })
})

// ── Replace ───────────────────────────────────────────────────────────────────

describe('restoreBackup replace: local-only records become tombstones', () => {
  it('turns every kind of local-only live record into a tombstone in its own key and keeps the rest', async () => {
    await setupDevice()
    const s = await seedSmall()
    const text = serializeBackup(await createBackup())
    setNow(T2)
    // Local-only records, created after the backup.
    const onlyCategory = await addCategory({ name: 'Local only' })
    const onlyIncomeCategory = await addIncomeCategory({ name: 'Local income' })
    const onlyExpense = await addExpense({
      amount: 3,
      currency: 'UAH',
      categoryId: onlyCategory.id,
      createdAt: '2026-03-10T10:00:00.000Z',
    })
    const onlyIncome = await addIncome({
      categoryId: onlyIncomeCategory.id,
      amount: 4,
      currency: 'UAH',
      createdAt: '2026-03-11T10:00:00.000Z',
    })
    const onlyBudget = await upsertBudget({
      categoryId: onlyCategory.id,
      monthlyLimit: 9,
      currency: 'UAH',
    })
    const onlyItem = await addRecurring(
      {
        kind: 'expense',
        amount: 5,
        currency: 'UAH',
        categoryId: onlyCategory.id,
        frequency: { unit: 'month', interval: 1 },
        startDate: '2026-03-01',
        end: { type: 'never' },
        mode: 'ask',
      },
      { createThroughToday: false, today: '2026-03-01' },
    )
    // A local tombstone the backup does not know: it must stay as it was.
    const early = await addExpense({
      amount: 2,
      currency: 'UAH',
      categoryId: onlyCategory.id,
      createdAt: '2026-03-12T10:00:00.000Z',
    })
    setNow('2026-03-02T15:00:00.000Z')
    await deleteExpense(early.id, early.createdAt)
    const earlyBefore = (await readRaw<{ id: string; rev?: number }>('expenses_2026_03')).find(
      (e) => e.id === early.id,
    )
    setNow(T3)
    const revBefore = await getLocalRev()

    await restoreBackup(text, PW, 'replace')

    type Raw = { id: string; deletedAt?: string; updatedAt?: string; rev?: number }
    const findIn = async (key: string, id: string) =>
      (await readRaw<Raw>(key)).find((r) => r.id === id)
    for (const [key, id] of [
      ['categories', onlyCategory.id],
      ['incomeCategories', onlyIncomeCategory.id],
      ['expenses_2026_03', onlyExpense.id],
      ['income', onlyIncome.id],
      ['budgets', onlyBudget.id],
      ['recurring', onlyItem.id],
    ] as const) {
      const record = await findIn(key, id)
      expect(record?.deletedAt).toBe(T3)
      expect(record?.updatedAt).toBe(T3)
      expect(record?.rev as number).toBeGreaterThan(revBefore)
    }
    // The backup's records are back and live.
    for (const [key, id] of [
      ['categories', s.food.id],
      ['incomeCategories', s.job.id],
      [FEB_CHUNK, s.ride.id],
      ['income', s.salary.id],
      ['budgets', s.budget.id],
    ] as const) {
      const record = await findIn(key, id)
      expect(record).toBeDefined()
      expect(record && 'deletedAt' in record).toBe(false)
    }
    // The old tombstone is untouched: same deletedAt, same rev.
    const earlyAfter = await findIn('expenses_2026_03', early.id)
    expect(earlyAfter?.deletedAt).toBe('2026-03-02T15:00:00.000Z')
    expect(earlyAfter?.rev).toBe(earlyBefore?.rev)
    // The readers see exactly the backup.
    expect((await getAllCategories()).map((c) => c.id)).toEqual([s.food.id])
    expect((await getAllIncomeCategories()).map((c) => c.id)).toEqual([s.job.id])
    expect((await getAllExpenses()).map((e) => e.id)).toEqual([s.ride.id])
    expect((await getAllIncome()).map((i) => i.id)).toEqual([s.salary.id])
    expect((await getAllBudgets()).map((b) => b.id)).toEqual([s.budget.id])
    expect(await getAllRecurring()).toEqual([])
  })

  it('every record the replace wrote has its own rev, with no gap, and meta:sync matches', async () => {
    await setupDevice()
    await seedSmall()
    const text = serializeBackup(await createBackup())
    setNow(T2)
    const food = (await getAllCategories())[0]
    await addExpense({
      amount: 3,
      currency: 'UAH',
      categoryId: food.id,
      createdAt: '2026-03-10T10:00:00.000Z',
    })
    const revBefore = await getLocalRev()
    ctl.setManyCalls.length = 0
    setNow(T3)

    await restoreBackup(text, PW, 'replace')

    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0]).toContain('meta:sync')
    const { records, maxRev } = await listChangedRecords(revBefore)
    // 5 backup records + 1 tombstone + the settings record.
    expect(records).toHaveLength(7)
    expect(maxRev).toBe(revBefore + 7)
    expect(await getLocalRev()).toBe(maxRev)
  })

  it('a device with nothing to tombstone (fresh) restores only live records', async () => {
    await setupDevice()
    await seedSmall()
    const text = serializeBackup(await createBackup())
    wipe()

    await restoreBackup(text, PW, 'replace')

    const { records } = await listChangedRecords(-1)
    expect(records.length).toBeGreaterThan(0)
    expect(records.every((r) => r.deletedAt === undefined)).toBe(true)
  })

  it('an unreadable local key is quarantined and its records cannot be tombstoned', async () => {
    await setupDevice()
    await seedSmall()
    const text = serializeBackup(await createBackup())
    const garbage = crypto.getRandomValues(new Uint8Array(64))
    mockStore.set('expenses_2026_05', garbage)
    setNow(T2)

    await restoreBackup(text, PW, 'replace')

    expect(Array.from(mockStore.get(`quarantine:expenses_2026_05:${T2}`) as Uint8Array)).toEqual(
      Array.from(garbage),
    )
    expect(await readRaw('expenses_2026_05')).toEqual([])
  })

  it('the settings record is written from the backup, with updatedAt now and a rev; the legacy fields go', async () => {
    await setupDevice()
    await convertBudgets('EUR', () => 1, { setMainCurrency: true })
    await updateSyncedSettings({ fetchExchangeRates: false })
    const text = serializeBackup(await createBackup())
    mockStore.set(META_SETTINGS_KEY, {
      ...(mockStore.get(META_SETTINGS_KEY) as Record<string, unknown>),
      mainCurrency: 'USD',
      fetchExchangeRates: true,
    })
    const channel = fakeChannel()
    setSyncChannel(channel)
    setNow(T4)
    const revBefore = await getLocalRev()

    await restoreBackup(text, PW, 'replace')

    const record = await readSyncedRaw()
    expect(record).toMatchObject({
      id: 'settings',
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
      updatedAt: T4,
    })
    expect(typeof record.rev).toBe('number')
    expect(record.rev as number).toBeGreaterThan(revBefore)
    const plain = mockStore.get(META_SETTINGS_KEY) as Record<string, unknown>
    expect('mainCurrency' in plain).toBe(false)
    expect('fetchExchangeRates' in plain).toBe(false)
    expect(postedKeys(channel)).toContain('syncedSettings')
    expect(Array.isArray(record)).toBe(false)
  })

  it('without currency values in the backup the local settings are kept', async () => {
    await setupDevice()
    const text = await rewritePayload(await createBackup(), (p) => {
      const settings: Record<string, unknown> = { ...p.settings }
      delete settings.mainCurrency
      delete settings.fetchExchangeRates
      return { ...p, settings }
    })
    await convertBudgets('EUR', () => 1, { setMainCurrency: true })
    await updateSyncedSettings({ fetchExchangeRates: false })

    await restoreBackup(serializeBackup(text), PW, 'replace')

    expect(await readSyncedRaw()).toMatchObject({
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
    })
  })

  it('an unreadable local syncedSettings is quarantined and replaced by a readable record', async () => {
    await setupDevice()
    await convertBudgets('EUR', () => 1, { setMainCurrency: true })
    const text = serializeBackup(await createBackup())
    const garbage = crypto.getRandomValues(new Uint8Array(64))
    mockStore.set('syncedSettings', garbage)
    setNow(T2)

    await restoreBackup(text, PW, 'replace')

    expect(Array.from(mockStore.get(`quarantine:syncedSettings:${T2}`) as Uint8Array)).toEqual(
      Array.from(garbage),
    )
    expect(await readSyncedRaw()).toMatchObject({ id: 'settings', mainCurrency: 'EUR' })
  })

  it('an orphaned device with a stray syncedSettings blob: the blob is quarantined, a readable record is written', async () => {
    await setupDevice()
    await seedSmall()
    const text = serializeBackup(await createBackup())
    wipe()
    const garbage = crypto.getRandomValues(new Uint8Array(48))
    mockStore.set('syncedSettings', garbage)
    mockStore.set('income', crypto.getRandomValues(new Uint8Array(48)))
    expect(await getVaultState()).toBe('orphaned')
    setNow(T2)

    await restoreBackup(text, PW, 'replace')

    expect(Array.from(mockStore.get(`quarantine:syncedSettings:${T2}`) as Uint8Array)).toEqual(
      Array.from(garbage),
    )
    const record = await readSyncedRaw()
    expect(Array.isArray(record)).toBe(false)
    expect(record.id).toBe('settings')
  })

  it('a failed transaction leaves the store as it was, with no tombstones and no new revs', async () => {
    await setupDevice()
    await seedSmall()
    const text = serializeBackup(await createBackup())
    await addExpense({
      amount: 3,
      currency: 'UAH',
      categoryId: (await getAllCategories())[0].id,
      createdAt: '2026-03-10T10:00:00.000Z',
    })
    const before = cloneStore()
    ctl.failSetMany = true

    await expect(restoreBackup(text, PW, 'replace')).rejects.toThrow('transaction aborted')

    for (const [key, value] of before) {
      const now = mockStore.get(key)
      if (value instanceof Uint8Array) {
        expect(Array.from(now as Uint8Array)).toEqual(Array.from(value))
      } else {
        expect(now).toEqual(value)
      }
    }
    expect(Array.from(mockStore.keys()).sort()).toEqual(Array.from(before.keys()).sort())
  })
})

// ── Default restore mode ──────────────────────────────────────────────────────

describe('defaultRestoreMode counts live records only', () => {
  it('a device that only holds tombstones restores in replace mode', async () => {
    await setupDevice()
    const food = await addCategory({ name: 'Food' })
    const ride = await addExpense({
      amount: 7,
      currency: 'USD',
      categoryId: food.id,
      createdAt: FEB_3,
    })
    const salary = await addIncome({ categoryId: 'ic1', amount: 1, currency: 'UAH' })
    const budget = await upsertBudget({ categoryId: food.id, monthlyLimit: 5, currency: 'UAH' })
    expect(await defaultRestoreMode()).toBe('merge')

    await deleteExpense(ride.id, ride.createdAt)
    await deleteIncome(salary.id)
    await deleteBudget(budget.id)

    expect(await defaultRestoreMode()).toBe('replace')
  })

  it('one live record among tombstones is enough for merge', async () => {
    await setupDevice()
    const food = await addCategory({ name: 'Food' })
    const gone = await addExpense({
      amount: 7,
      currency: 'USD',
      categoryId: food.id,
      createdAt: FEB_3,
    })
    await deleteExpense(gone.id, gone.createdAt)
    await addExpense({ amount: 1, currency: 'UAH', categoryId: food.id })

    expect(await defaultRestoreMode()).toBe('merge')
  })

  it('the synced settings record does not count as data', async () => {
    await setupDevice()
    await updateSyncedSettings({ fetchExchangeRates: false })
    expect(mockStore.has('syncedSettings')).toBe(true)

    expect(await defaultRestoreMode()).toBe('replace')
  })
})
