// No CONTRACT_GAPs: backup.ts, the vault additions (getVaultHeader,
// openHeaderWithSecret) and the integration setup are fully specified in the
// Interface Contract (modules: backup, vault additions). The vault additions
// are tested here because the plan lists no separate vault test file.
//
// Integration style: real crypto, real vault, real localDb, idb-keyval backed
// by a Map. setMany applies all entries or none and can be made to reject.
//
// The validation-fixes run replaces the old "rejects an orphaned device" case
// with positive orphaned-restore cases (header adopted, every blob moved to
// quarantine byte-identical inside the one setMany) and adds
// recoveryKeyConfirmed cases. createVault now writes meta:vault and
// meta:settings with one setMany, so tests that count setMany calls reset the
// counter after setup.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackupPayload, MinimaBackupV1 } from '@/lib/backup'
import { getAppSettings, updateAppSettings } from '@/lib/appSettings'
import {
  APP_VERSION,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupError,
  backupFileName,
  createBackup,
  defaultRestoreMode,
  downloadBackup,
  formatRestoreSummary,
  parseBackupFile,
  restoreBackup,
  serializeBackup,
} from '@/lib/backup'
import { getBackupSettings, updateBackupSettings } from '@/lib/backupReminder'
import {
  base64ToBytes,
  bytesToBase64,
  decryptValue,
  encodeRecoveryKey,
} from '@/lib/crypto'
import { DecryptError } from '@/lib/dataErrors'
import { saveFile } from '@/lib/fileDownload'
import {
  addCategory,
  addExpense,
  addIncome,
  deleteExpense,
  deleteIncome,
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getLocalDbKey,
  provisionDefaultCategories,
  updateCategory,
  updateExpense,
  upsertBudget,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'
import {
  META_SETTINGS_KEY,
  META_VAULT_KEY,
  VaultError,
  changePassword,
  createVault,
  getVaultHeader,
  getVaultState,
  lockVault,
  openHeaderWithSecret,
  unlockWithPassword,
  unlockWithRecoveryKey,
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
const WRONG = 'wrong password 123'

const T1 = '2026-03-01T10:00:00.000Z'
const T2 = '2026-03-02T10:00:00.000Z'
const T3 = '2026-03-03T10:00:00.000Z'
const T4 = '2026-03-04T10:00:00.000Z'

function setNow(iso: string) {
  vi.setSystemTime(new Date(iso))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupDevice(password = PW): Promise<string> {
  const { recoveryKey } = await createVault(password)
  return recoveryKey
}

// "Remove data": lock and clear everything.
function wipe() {
  lockVault()
  mockStore.clear()
}

async function seed() {
  const food = await addCategory({ name: 'Food', icon: '🍔' })
  const taxi = await addCategory({ name: 'Taxi' })
  const lunch = await addExpense({
    amount: 10.5,
    currency: 'UAH',
    categoryId: food.id,
    description: 'lunch\nwith colleagues',
    createdAt: '2026-01-15T10:20:30.123Z',
  })
  const ride = await addExpense({
    amount: 7,
    currency: 'USD',
    categoryId: taxi.id,
    createdAt: '2026-02-03T08:00:00.000Z',
  })
  const dinner = await addExpense({
    amount: 22.25,
    currency: 'EUR',
    categoryId: food.id,
    description: 'dinner',
    createdAt: '2026-02-20T23:59:59.000Z',
  })
  const salary = await addIncome({
    source: 'Job',
    amount: 1000,
    currency: 'USD',
    createdAt: '2026-02-01T09:15:00.000Z',
  })
  const budget = await upsertBudget({
    categoryId: food.id,
    monthlyLimit: 500,
    currency: 'UAH',
  })
  return { food, taxi, lunch, ride, dinner, salary, budget }
}

function omit(record: object, drop: Array<string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !drop.includes(key)),
  )
}

function sortById(rows: Array<Record<string, unknown>>) {
  return [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

// The stored records, without the fields getters join in.
async function snapshot() {
  return {
    expenses: sortById((await getAllExpenses()).map((e) => omit(e, ['category']))),
    income: sortById((await getAllIncome()).map((i) => omit(i, []))),
    categories: sortById((await getAllCategories()).map((c) => omit(c, []))),
    budgets: sortById(
      (await getAllBudgets()).map((b) =>
        omit(b, ['categoryName', 'categoryIcon']),
      ),
    ),
  }
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

function expectStoreEquals(before: Map<string, unknown>) {
  expect(Array.from(mockStore.keys()).sort()).toEqual(
    Array.from(before.keys()).sort(),
  )
  for (const [key, value] of before) {
    const now = mockStore.get(key)
    if (value instanceof Uint8Array) {
      expect(now).toBeInstanceOf(Uint8Array)
      expect(Array.from(now as Uint8Array)).toEqual(Array.from(value))
    } else {
      expect(now).toEqual(value)
    }
  }
}

async function readRaw(key: string): Promise<unknown> {
  const dek = getLocalDbKey()
  const raw = mockStore.get(key)
  if (!dek || !(raw instanceof Uint8Array)) {
    throw new Error(`cannot read ${key}`)
  }
  return decryptValue(dek, raw)
}

function storedSettings() {
  return mockStore.get(META_SETTINGS_KEY) as
    | Record<string, unknown>
    | undefined
}

async function expectBackupError(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(BackupError)
  expect((err as BackupError).code).toBe(code)
  expect((err as BackupError).name).toBe('BackupError')
}

function flipBase64(b64: string): string {
  const bytes = base64ToBytes(b64)
  bytes[0] ^= 0xff
  return bytesToBase64(bytes)
}

async function readPayload(
  backup: MinimaBackupV1,
  secret = PW,
): Promise<BackupPayload> {
  const dek = await openHeaderWithSecret(backup.vault, secret)
  if (!dek) throw new Error('the secret did not open the backup')
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(backup.payload.iv) },
      dek,
      base64ToBytes(backup.payload.ct),
    ),
  )
  let bytes = plain
  if (backup.payload.enc === 'gzip+aes-gcm') {
    const body = new Response(plain).body
    if (!body) throw new Error('no body')
    bytes = new Uint8Array(
      await new Response(
        body.pipeThrough(new DecompressionStream('gzip')),
      ).arrayBuffer(),
    )
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as BackupPayload
}

function readText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  mockStore.clear()
  localStorage.clear()
  lockVault()
  ctl.failSetMany = false
  ctl.setManyCalls.length = 0
  setSyncChannel(null)
  vi.mocked(saveFile).mockReset().mockResolvedValue('saved')
  vi.useFakeTimers({ toFake: ['Date'] })
  setNow(T1)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ── vault additions ───────────────────────────────────────────────────────────

describe('getVaultHeader', () => {
  it('returns the stored header', async () => {
    await setupDevice()

    const header = await getVaultHeader()

    expect(header).toEqual(mockStore.get(META_VAULT_KEY))
    expect(header.v).toBe(2)
  })

  it('throws invalid-state when there is no vault', async () => {
    await expect(getVaultHeader()).rejects.toMatchObject({
      name: 'VaultError',
      code: 'invalid-state',
    })
  })

  it('throws damaged for a malformed header', async () => {
    mockStore.set(META_VAULT_KEY, { v: 2 })

    await expect(getVaultHeader()).rejects.toMatchObject({ code: 'damaged' })
  })
})

describe('openHeaderWithSecret', () => {
  it('opens a header with the password: a non-extractable key that decrypts the data', async () => {
    await setupDevice()
    await addIncome({ source: 'Job', amount: 5, currency: 'UAH' })
    const header = await getVaultHeader()

    const key = await openHeaderWithSecret(header, PW)

    expect(key).not.toBeNull()
    expect(key?.extractable).toBe(false)
    const income = await decryptValue(
      key as CryptoKey,
      mockStore.get('income') as Uint8Array,
    )
    expect(income).toHaveLength(1)
  })

  it('opens a header with the recovery key in any case, with spaces instead of dashes', async () => {
    const recoveryKey = await setupDevice()
    await addIncome({ source: 'Job', amount: 5, currency: 'UAH' })
    const header = await getVaultHeader()

    for (const variant of [
      recoveryKey,
      recoveryKey.toLowerCase(),
      recoveryKey.replace(/-/g, ' '),
    ]) {
      const key = await openHeaderWithSecret(header, variant)
      expect(key).not.toBeNull()
      const income = await decryptValue(
        key as CryptoKey,
        mockStore.get('income') as Uint8Array,
      )
      expect(income).toHaveLength(1)
    }
  })

  it('returns null for a wrong password and for a wrong recovery key', async () => {
    await setupDevice()
    const header = await getVaultHeader()
    const otherKey = encodeRecoveryKey(crypto.getRandomValues(new Uint8Array(20)))

    expect(await openHeaderWithSecret(header, WRONG)).toBeNull()
    expect(await openHeaderWithSecret(header, otherKey)).toBeNull()
    expect(await openHeaderWithSecret(header, '')).toBeNull()
  })

  it('never touches the brute-force counter', async () => {
    await setupDevice()
    mockStore.set(META_SETTINGS_KEY, {
      failedUnlockAttempts: 3,
      unlockBlockedUntil: null,
    })
    const header = await getVaultHeader()

    await openHeaderWithSecret(header, WRONG)
    await openHeaderWithSecret(header, PW)

    expect(storedSettings()).toEqual({
      failedUnlockAttempts: 3,
      unlockBlockedUntil: null,
    })
  })

  it('is not blocked by an active throttle on the local vault', async () => {
    await setupDevice()
    mockStore.set(META_SETTINGS_KEY, {
      failedUnlockAttempts: 9,
      unlockBlockedUntil: '2030-01-01T00:00:00.000Z',
    })
    const header = await getVaultHeader()

    expect(await openHeaderWithSecret(header, PW)).not.toBeNull()
  })

  it('throws damaged when the secret opens the DEK but the verifier fails', async () => {
    await setupDevice()
    const header = await getVaultHeader()
    const tampered = {
      ...header,
      verifier: { ...header.verifier, ct: flipBase64(header.verifier.ct) },
    }

    await expect(openHeaderWithSecret(tampered, PW)).rejects.toMatchObject({
      code: 'damaged',
    })
  })
})

// ── createBackup ──────────────────────────────────────────────────────────────

describe('BackupError', () => {
  it('carries a code and its own name', () => {
    const err = new BackupError('wrong-secret', 'nope')

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('BackupError')
    expect(err.code).toBe('wrong-secret')
    expect(err.message).toBe('nope')
  })
})

describe('createBackup', () => {
  it('produces the §7.1 file format', async () => {
    await setupDevice()
    await seed()
    const header = await getVaultHeader()

    const backup = await createBackup()

    expect(BACKUP_FORMAT).toBe('minima-backup')
    expect(BACKUP_VERSION).toBe(1)
    expect(backup.format).toBe('minima-backup')
    expect(backup.version).toBe(1)
    expect(backup.createdAt).toBe(T1)
    expect(backup.appVersion).toBe(APP_VERSION)
    expect(APP_VERSION.length).toBeGreaterThan(0)
    expect(Object.keys(backup.vault).sort()).toEqual([
      'kdf',
      'recovery',
      'vaultId',
      'verifier',
      'wrappedByPassword',
    ])
    expect(backup.vault.vaultId).toBe(header.vaultId)
    expect(backup.vault.kdf).toEqual(header.kdf)
    expect(backup.vault.wrappedByPassword).toEqual(header.wrappedByPassword)
    expect(backup.vault.recovery).toEqual(header.recovery)
    expect(backup.vault.verifier).toEqual(header.verifier)
    expect(Object.keys(backup.payload).sort()).toEqual(['ct', 'enc', 'iv'])
    expect(base64ToBytes(backup.payload.iv)).toHaveLength(12)
    expect(base64ToBytes(backup.payload.ct).length).toBeGreaterThan(16)
    expect('skipped' in backup).toBe(false)
  })

  it('gzips then encrypts by default', async () => {
    await setupDevice()

    const backup = await createBackup()

    expect(backup.payload.enc).toBe('gzip+aes-gcm')
  })

  it('uses plain aes-gcm when CompressionStream is unavailable', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    await setupDevice()
    await seed()

    const backup = await createBackup()

    expect(backup.payload.enc).toBe('aes-gcm')
    const payload = await readPayload(backup)
    expect(payload.expenses).toHaveLength(3)
  })

  it('the payload holds the raw records, without the joined category', async () => {
    await setupDevice()
    const s = await seed()

    const payload = await readPayload(await createBackup())

    expect(payload.schemaVersion).toBe(1)
    expect(payload.categories.map((c) => c.id).sort()).toEqual(
      [s.food.id, s.taxi.id].sort(),
    )
    expect(payload.expenses).toHaveLength(3)
    for (const e of payload.expenses) expect('category' in e).toBe(false)
    const lunch = payload.expenses.find((e) => e.id === s.lunch.id)
    expect(lunch?.createdAt).toBe('2026-01-15T10:20:30.123Z')
    expect(lunch?.updatedAt).toBe(T1)
    expect(lunch?.description).toBe('lunch\nwith colleagues')
    expect(payload.income).toHaveLength(1)
    expect(payload.income[0].createdAt).toBe('2026-02-01T09:15:00.000Z')
    expect(payload.budgets).toHaveLength(1)
    expect(payload.budgets[0].monthlyLimit).toBe(500)
  })

  it('the payload carries the auto-lock and reminder settings', async () => {
    await setupDevice()
    expect((await readPayload(await createBackup())).settings).toEqual({
      autoLockMinutes: 15,
      backupReminderDays: 14,
    })

    await updateAppSettings({ autoLockMinutes: 5 })
    await updateBackupSettings({ backupReminderDays: 30 })

    expect((await readPayload(await createBackup())).settings).toEqual({
      autoLockMinutes: 5,
      backupReminderDays: 30,
    })
  })

  it('an empty vault gives empty collections', async () => {
    await setupDevice()

    const payload = await readPayload(await createBackup())

    expect(payload.categories).toEqual([])
    expect(payload.expenses).toEqual([])
    expect(payload.income).toEqual([])
    expect(payload.budgets).toEqual([])
  })

  it('does not leak plaintext into the file', async () => {
    await setupDevice()
    await seed()

    const text = serializeBackup(await createBackup())

    expect(text).not.toContain('colleagues')
    expect(text).not.toContain('Food')
    expect(text).not.toContain('Job')
  })

  it('uses a fresh IV for every backup', async () => {
    await setupDevice()

    const a = await createBackup()
    const b = await createBackup()

    expect(a.payload.iv).not.toBe(b.payload.iv)
    expect(a.payload.ct).not.toBe(b.payload.ct)
  })

  it('requires an unlocked app', async () => {
    await setupDevice()
    lockVault()

    await expectBackupError(createBackup(), 'invalid-state')
  })

  it('never includes quarantine or meta keys', async () => {
    await setupDevice()
    await seed()
    mockStore.set(
      'quarantine:expenses_2026_02:2026-01-01T00:00:00.000Z',
      crypto.getRandomValues(new Uint8Array(64)),
    )

    const backup = await createBackup()

    expect(backup.skipped).toBeUndefined()
    const payload = await readPayload(backup)
    expect(payload.expenses).toHaveLength(3)
  })

  it('rethrows DecryptError for an unreadable key by default', async () => {
    await setupDevice()
    await seed()
    mockStore.set('expenses_2026_02', crypto.getRandomValues(new Uint8Array(64)))

    const err = await createBackup().then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(DecryptError)
    expect((err as DecryptError).storageKey).toBe('expenses_2026_02')
  })

  it('with allowPartial lists every unreadable key in skipped and keeps the rest', async () => {
    await setupDevice()
    const s = await seed()
    mockStore.set('expenses_2026_02', crypto.getRandomValues(new Uint8Array(64)))

    const backup = await createBackup({ allowPartial: true })

    expect(backup.skipped).toEqual(['expenses_2026_02'])
    const payload = await readPayload(backup)
    expect(payload.expenses.map((e) => e.id)).toEqual([s.lunch.id])
    expect(payload.income).toHaveLength(1)
    expect(payload.categories).toHaveLength(2)
    expect(payload.budgets).toHaveLength(1)
  })

  it('skipped lists several keys in key order', async () => {
    await setupDevice()
    await seed()
    mockStore.set('income', crypto.getRandomValues(new Uint8Array(64)))
    mockStore.set('expenses_2026_02', crypto.getRandomValues(new Uint8Array(64)))

    const backup = await createBackup({ allowPartial: true })

    expect(backup.skipped).toEqual(['expenses_2026_02', 'income'])
  })
})

// ── serialize / parse ─────────────────────────────────────────────────────────

describe('serializeBackup and parseBackupFile', () => {
  const VALID: MinimaBackupV1 = {
    format: 'minima-backup',
    version: 1,
    createdAt: '2026-03-01T10:00:00.000Z',
    appVersion: '1.0.0',
    vault: {
      vaultId: '2a0f6f3e-6f51-4c8f-9a43-0a3b8b1c9d11',
      kdf: { alg: 'PBKDF2-SHA256', iterations: 600000, salt: 'c2FsdHNhbHQ=' },
      wrappedByPassword: { iv: 'aXZpdml2aXZpdml2', ct: 'Y3RjdGN0Y3Q=' },
      recovery: { salt: 'c2FsdHNhbHQ=', iv: 'aXZpdml2aXZpdml2', ct: 'Y3Q=' },
      verifier: { iv: 'aXZpdml2aXZpdml2', ct: 'Y3Q=' },
    },
    payload: { enc: 'gzip+aes-gcm', iv: 'aXZpdml2aXZpdml2', ct: 'Y3RjdGN0' },
  }

  function clone(): MinimaBackupV1 {
    return JSON.parse(JSON.stringify(VALID)) as MinimaBackupV1
  }

  function parseError(text: string): BackupError {
    try {
      parseBackupFile(text)
    } catch (err) {
      expect(err).toBeInstanceOf(BackupError)
      return err as BackupError
    }
    throw new Error('parseBackupFile did not throw')
  }

  it('serializes to JSON that parses back to the same backup', async () => {
    await setupDevice()
    await seed()
    const backup = await createBackup({ allowPartial: true })

    const text = serializeBackup(backup)

    expect(JSON.parse(text)).toEqual(backup)
    expect(parseBackupFile(text)).toEqual(backup)
  })

  it('keeps the skipped list', () => {
    const withSkipped = { ...clone(), skipped: ['income'] }

    expect(parseBackupFile(JSON.stringify(withSkipped)).skipped).toEqual([
      'income',
    ])
  })

  it.each(['this is not json', '', '[]', 'null', '42', '"text"', '{'])(
    'rejects %j as not a backup',
    (text) => {
      const err = parseError(text)

      expect(err.code).toBe('invalid-file')
      expect(err.message).toBe("This file isn't a MinimaSpend backup")
    },
  )

  it('rejects another format', () => {
    const other = { ...clone(), format: 'some-other-app' }

    expect(parseError(JSON.stringify(other)).code).toBe('invalid-file')
  })

  it('rejects a missing format', () => {
    const noFormat: Record<string, unknown> = { ...clone() }
    Reflect.deleteProperty(noFormat, 'format')

    expect(parseError(JSON.stringify(noFormat)).code).toBe('invalid-file')
  })

  it.each([2, 99])('rejects version %i as made by a newer app', (version) => {
    const err = parseError(JSON.stringify({ ...clone(), version }))

    expect(err.code).toBe('unsupported-version')
    expect(err.message).toBe(
      'This backup was made by a newer version of MinimaSpend',
    )
  })

  it('rejects a missing vault or payload', () => {
    const noVault: Record<string, unknown> = { ...clone() }
    Reflect.deleteProperty(noVault, 'vault')
    const noPayload: Record<string, unknown> = { ...clone() }
    Reflect.deleteProperty(noPayload, 'payload')

    expect(parseError(JSON.stringify(noVault)).code).toBe('invalid-file')
    expect(parseError(JSON.stringify(noPayload)).code).toBe('invalid-file')
  })

  it.each([
    ['kdf.salt', (b: MinimaBackupV1) => Reflect.deleteProperty(b.vault.kdf, 'salt')],
    [
      'kdf.iterations',
      (b: MinimaBackupV1) => Reflect.deleteProperty(b.vault.kdf, 'iterations'),
    ],
    [
      'wrappedByPassword.ct',
      (b: MinimaBackupV1) =>
        Reflect.deleteProperty(b.vault.wrappedByPassword, 'ct'),
    ],
    [
      'recovery.ct',
      (b: MinimaBackupV1) => Reflect.deleteProperty(b.vault.recovery, 'ct'),
    ],
    [
      'verifier.ct',
      (b: MinimaBackupV1) => Reflect.deleteProperty(b.vault.verifier, 'ct'),
    ],
    ['payload.iv', (b: MinimaBackupV1) => Reflect.deleteProperty(b.payload, 'iv')],
    ['payload.ct', (b: MinimaBackupV1) => Reflect.deleteProperty(b.payload, 'ct')],
  ])('rejects a backup without %s', (_name, mutate) => {
    const broken = clone()
    mutate(broken)

    expect(parseError(JSON.stringify(broken)).code).toBe('invalid-file')
  })

  it('treats a missing payload.enc as aes-gcm', () => {
    const noEnc = clone()
    Reflect.deleteProperty(noEnc.payload, 'enc')

    expect(parseBackupFile(JSON.stringify(noEnc)).payload.enc).toBe('aes-gcm')
  })

  it('keeps an explicit payload.enc', () => {
    expect(parseBackupFile(JSON.stringify(VALID)).payload.enc).toBe(
      'gzip+aes-gcm',
    )
  })
})

describe('backupFileName', () => {
  it('is minima-backup-YYYY-MM-DD.minima for the local date', () => {
    expect(backupFileName(new Date(2026, 2, 5, 12))).toBe(
      'minima-backup-2026-03-05.minima',
    )
    expect(backupFileName(new Date(2025, 11, 31, 12))).toBe(
      'minima-backup-2025-12-31.minima',
    )
  })

  it('defaults to today', () => {
    expect(backupFileName()).toMatch(/^minima-backup-\d{4}-\d{2}-\d{2}\.minima$/)
  })
})

describe('formatRestoreSummary', () => {
  it('follows the §7.3 text', () => {
    expect(
      formatRestoreSummary({
        mode: 'merge',
        expenses: 12,
        income: 3,
        categories: 5,
        budgets: 2,
        added: 10,
        updated: 4,
        conflicts: 1,
        skipped: [],
        adoptedVault: false,
      }),
    ).toBe(
      '12 expenses, 3 income, 5 categories, 2 budgets restored (4 updated, 1 conflicts)',
    )
  })

  it('reflects each number', () => {
    expect(
      formatRestoreSummary({
        mode: 'replace',
        expenses: 0,
        income: 1,
        categories: 0,
        budgets: 9,
        added: 10,
        updated: 0,
        conflicts: 0,
        skipped: ['income'],
        adoptedVault: true,
      }),
    ).toBe(
      '0 expenses, 1 income, 0 categories, 9 budgets restored (0 updated, 0 conflicts)',
    )
  })
})

// ── defaultRestoreMode ────────────────────────────────────────────────────────

describe('defaultRestoreMode', () => {
  it('is replace on a device with no vault', async () => {
    expect(await defaultRestoreMode()).toBe('replace')
  })

  it('is replace for an empty vault', async () => {
    await setupDevice()

    expect(await defaultRestoreMode()).toBe('replace')
  })

  it('is replace when only the default categories exist', async () => {
    await setupDevice()
    await provisionDefaultCategories()
    expect((await getAllCategories()).length).toBeGreaterThan(0)

    expect(await defaultRestoreMode()).toBe('replace')
  })

  it('is merge once there is an expense', async () => {
    await setupDevice()
    const cat = await addCategory({ name: 'Food' })
    await addExpense({ amount: 1, currency: 'UAH', categoryId: cat.id })

    expect(await defaultRestoreMode()).toBe('merge')
  })

  it('is merge once there is income', async () => {
    await setupDevice()
    await addIncome({ source: 'Job', amount: 1, currency: 'UAH' })

    expect(await defaultRestoreMode()).toBe('merge')
  })

  it('is merge once there is a budget', async () => {
    await setupDevice()
    const cat = await addCategory({ name: 'Food' })
    await upsertBudget({ categoryId: cat.id, monthlyLimit: 5, currency: 'UAH' })

    expect(await defaultRestoreMode()).toBe('merge')
  })
})

// ── restore: fresh device ─────────────────────────────────────────────────────

describe('restoreBackup on a fresh device', () => {
  it('backup, remove all data, restore: identical records (ids, createdAt with time, updatedAt)', async () => {
    await setupDevice()
    await seed()
    const before = await snapshot()
    expect(before.expenses).toHaveLength(3)
    const text = serializeBackup(await createBackup())
    wipe()
    expect(await getVaultState()).toBe('none')

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary).toEqual({
      mode: 'replace',
      expenses: 3,
      income: 1,
      categories: 2,
      budgets: 1,
      added: 7,
      updated: 0,
      conflicts: 0,
      skipped: [],
      adoptedVault: true,
    })
    expect(await getVaultState()).toBe('v2')
    expect(getLocalDbKey()).not.toBeNull()
    const after = await snapshot()
    expect(after).toEqual(before)
    expect(after.expenses.map((e) => e.createdAt)).toContain(
      '2026-01-15T10:20:30.123Z',
    )
    expect(after.expenses.every((e) => e.updatedAt === T1)).toBe(true)
  })

  it('adopts the backup vault header and keeps the same recovery key and password', async () => {
    const recoveryKey = await setupDevice()
    await seed()
    const before = await snapshot()
    const backup = await createBackup()
    wipe()

    await restoreBackup(serializeBackup(backup), PW, 'replace')

    expect(mockStore.get(META_VAULT_KEY)).toEqual({
      v: 2,
      createdAt: backup.createdAt,
      ...backup.vault,
    })
    lockVault()
    expect(getLocalDbKey()).toBeNull()
    await unlockWithPassword(PW)
    expect(await snapshot()).toEqual(before)
    lockVault()
    await unlockWithRecoveryKey(recoveryKey)
    expect(await snapshot()).toEqual(before)
  })

  it('forces replace even when merge is asked for', async () => {
    await setupDevice()
    await seed()
    const text = serializeBackup(await createBackup())
    wipe()

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary.mode).toBe('replace')
    expect(summary.adoptedVault).toBe(true)
    expect(summary.added).toBe(7)
  })

  it('accepts the recovery key as the secret', async () => {
    const recoveryKey = await setupDevice()
    await seed()
    const before = await snapshot()
    const text = serializeBackup(await createBackup())
    wipe()

    await restoreBackup(text, recoveryKey.toLowerCase(), 'replace')

    expect(await snapshot()).toEqual(before)
    lockVault()
    await unlockWithPassword(PW)
  })

  it('accepts a Blob as well as text', async () => {
    await setupDevice()
    await seed()
    const before = await snapshot()
    const text = serializeBackup(await createBackup())
    wipe()
    const blob = Object.assign(new Blob([text]), {
      text: () => Promise.resolve(text),
    })

    await restoreBackup(blob, PW, 'replace')

    expect(await snapshot()).toEqual(before)
  })

  it('does not take lastBackupAt from the file and marks a data change', async () => {
    await setupDevice()
    await seed()
    await updateBackupSettings({ lastBackupAt: '2026-02-01T00:00:00.000Z' })
    const text = serializeBackup(await createBackup())
    wipe()
    setNow(T3)

    await restoreBackup(text, PW, 'replace')

    const settings = await getBackupSettings()
    expect(settings.lastBackupAt).toBeNull()
    expect(settings.lastDataChangeAt).toBe(T3)
  })

  it('restores an empty backup too', async () => {
    await setupDevice()
    const text = serializeBackup(await createBackup())
    wipe()

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary).toMatchObject({
      expenses: 0,
      income: 0,
      categories: 0,
      budgets: 0,
      adoptedVault: true,
    })
    expect(await getVaultState()).toBe('v2')
  })

  it('writes everything in one transaction', async () => {
    await setupDevice()
    await seed()
    const text = serializeBackup(await createBackup())
    wipe()
    ctl.setManyCalls.length = 0

    await restoreBackup(text, PW, 'replace')

    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0]).toEqual(
      expect.arrayContaining([
        META_VAULT_KEY,
        META_SETTINGS_KEY,
        'categories',
        'income',
        'budgets',
        'expenses_2026_01',
        'expenses_2026_02',
      ]),
    )
  })

  it('a failed transaction leaves the empty device empty and locked', async () => {
    await setupDevice()
    await seed()
    const text = serializeBackup(await createBackup())
    wipe()
    ctl.failSetMany = true

    await expect(restoreBackup(text, PW, 'replace')).rejects.toThrow(
      'transaction aborted',
    )

    expect(mockStore.size).toBe(0)
    expect(await getVaultState()).toBe('none')
    expect(getLocalDbKey()).toBeNull()
  })

  it('drops a stale recoveryKeyConfirmed: false so the adopted vault does not nag', async () => {
    await setupDevice()
    const text = serializeBackup(await createBackup())
    wipe()
    mockStore.set(META_SETTINGS_KEY, { recoveryKeyConfirmed: false })
    expect(await getVaultState()).toBe('none')

    await restoreBackup(text, PW, 'replace')

    const settings = storedSettings()
    expect(settings).toBeDefined()
    expect('recoveryKeyConfirmed' in (settings ?? {})).toBe(false)
    expect((await getAppSettings()).recoveryKeyConfirmed).toBe(true)
  })
})

// ── restore: secrets and validation ───────────────────────────────────────────

describe('restoreBackup rejects without writing', () => {
  it('a wrong secret on a fresh device', async () => {
    await setupDevice()
    await seed()
    const text = serializeBackup(await createBackup())
    wipe()

    await expectBackupError(restoreBackup(text, WRONG, 'replace'), 'wrong-secret')

    expect(mockStore.size).toBe(0)
    expect(await getVaultState()).toBe('none')
    expect(getLocalDbKey()).toBeNull()
  })

  it('a wrong secret on an existing device, without counting as a failed unlock', async () => {
    await setupDevice()
    await seed()
    const text = serializeBackup(await createBackup())
    await addIncome({ source: 'Later', amount: 1, currency: 'UAH' })
    const before = cloneStore()
    ctl.setManyCalls.length = 0

    await expectBackupError(restoreBackup(text, WRONG, 'merge'), 'wrong-secret')
    await expectBackupError(restoreBackup(text, WRONG, 'replace'), 'wrong-secret')

    expectStoreEquals(before)
    expect(Number(storedSettings()?.failedUnlockAttempts ?? 0)).toBe(0)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('a recovery key that belongs to another vault', async () => {
    await setupDevice()
    const text = serializeBackup(await createBackup())
    wipe()
    const stranger = encodeRecoveryKey(crypto.getRandomValues(new Uint8Array(20)))

    await expectBackupError(restoreBackup(text, stranger, 'replace'), 'wrong-secret')

    expect(mockStore.size).toBe(0)
  })

  it('text that is not a backup', async () => {
    await expectBackupError(restoreBackup('not json', PW, 'replace'), 'invalid-file')
    await expectBackupError(
      restoreBackup(JSON.stringify({ format: 'other', version: 1 }), PW, 'replace'),
      'invalid-file',
    )

    expect(mockStore.size).toBe(0)
  })

  it('a newer file version', async () => {
    await setupDevice()
    const backup = await createBackup()
    wipe()

    await expectBackupError(
      restoreBackup(JSON.stringify({ ...backup, version: 2 }), PW, 'replace'),
      'unsupported-version',
    )

    expect(mockStore.size).toBe(0)
  })

  it('a tampered payload', async () => {
    await setupDevice()
    await seed()
    const backup = await createBackup()
    wipe()
    const tampered = {
      ...backup,
      payload: { ...backup.payload, ct: flipBase64(backup.payload.ct) },
    }

    await expectBackupError(
      restoreBackup(JSON.stringify(tampered), PW, 'replace'),
      'damaged',
    )

    expect(mockStore.size).toBe(0)
    expect(getLocalDbKey()).toBeNull()
  })

  it('a tampered verifier', async () => {
    await setupDevice()
    const backup = await createBackup()
    wipe()
    const tampered = {
      ...backup,
      vault: {
        ...backup.vault,
        verifier: {
          ...backup.vault.verifier,
          ct: flipBase64(backup.vault.verifier.ct),
        },
      },
    }

    await expectBackupError(
      restoreBackup(JSON.stringify(tampered), PW, 'replace'),
      'damaged',
    )

    expect(mockStore.size).toBe(0)
  })

  it('a compressed backup in a browser without DecompressionStream', async () => {
    await setupDevice()
    await seed()
    const backup = await createBackup()
    expect(backup.payload.enc).toBe('gzip+aes-gcm')
    wipe()
    vi.stubGlobal('DecompressionStream', undefined)

    await expectBackupError(
      restoreBackup(serializeBackup(backup), PW, 'replace'),
      'invalid-file',
    )

    expect(mockStore.size).toBe(0)
  })

  it('a locked app', async () => {
    await setupDevice()
    await seed()
    const text = serializeBackup(await createBackup())
    lockVault()
    const before = cloneStore()

    await expectBackupError(restoreBackup(text, PW, 'merge'), 'invalid-state')
    await expectBackupError(restoreBackup(text, PW, 'replace'), 'invalid-state')

    expectStoreEquals(before)
  })

  it('a v1 device', async () => {
    await setupDevice()
    const text = serializeBackup(await createBackup())
    wipe()
    localStorage.setItem('minima_key_verify_u1', 'abcd')
    expect(await getVaultState()).toBe('v1')

    await expectBackupError(restoreBackup(text, PW, 'replace'), 'invalid-state')

    expect(mockStore.size).toBe(0)
  })
})

// ── restore: orphaned device (data without a header) ──────────────────────────

describe('restoreBackup on an orphaned device', () => {
  // Data keys of the backup: categories, income, budgets, expenses_2026_01,
  // expenses_2026_02. expenses_2025_12 is NOT in the backup.
  const BACKUP_KEYS = [
    'categories',
    'income',
    'budgets',
    'expenses_2026_01',
    'expenses_2026_02',
  ]
  const ORPHAN_KEYS = [...BACKUP_KEYS, 'expenses_2025_12']

  async function makeBackup() {
    const recoveryKey = await setupDevice()
    await seed()
    const before = await snapshot()
    const backup = await createBackup()
    const text = serializeBackup(backup)
    wipe()
    return { recoveryKey, before, backup, text }
  }

  // Data blobs nobody can open (different random bytes per key), and stale
  // settings from the lost vault.
  function plantOrphan(): Map<string, Array<number>> {
    const planted = new Map<string, Array<number>>()
    for (const key of ORPHAN_KEYS) {
      const bytes = crypto.getRandomValues(new Uint8Array(48))
      mockStore.set(key, bytes)
      planted.set(key, Array.from(bytes))
    }
    mockStore.set(META_SETTINGS_KEY, {
      recoveryKeyConfirmed: false,
      autoLockMinutes: 60,
    })
    return planted
  }

  it('is detected as orphaned and locked before the restore', async () => {
    await makeBackup()
    plantOrphan()

    expect(await getVaultState()).toBe('orphaned')
    expect(getLocalDbKey()).toBeNull()
  })

  it('adopts the backup vault, restores every record and unlocks', async () => {
    const { before, backup, text } = await makeBackup()
    plantOrphan()
    setNow(T2)

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary).toEqual({
      mode: 'replace',
      expenses: 3,
      income: 1,
      categories: 2,
      budgets: 1,
      added: 7,
      updated: 0,
      conflicts: 0,
      skipped: [],
      adoptedVault: true,
    })
    expect(await getVaultState()).toBe('v2')
    expect(getLocalDbKey()).not.toBeNull()
    expect(mockStore.get(META_VAULT_KEY)).toEqual({
      v: 2,
      createdAt: backup.createdAt,
      ...backup.vault,
    })
    expect(await snapshot()).toEqual(before)
  })

  it('forces replace even when merge is asked for', async () => {
    const { before, text } = await makeBackup()
    plantOrphan()

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary.mode).toBe('replace')
    expect(summary.adoptedVault).toBe(true)
    expect(await snapshot()).toEqual(before)
  })

  it('moves every pre-existing blob to quarantine, byte-identical, with one timestamp', async () => {
    const { text } = await makeBackup()
    const planted = plantOrphan()
    setNow(T2)

    await restoreBackup(text, PW, 'replace')

    for (const key of ORPHAN_KEYS) {
      const quarantined = mockStore.get(`quarantine:${key}:${T2}`)
      expect(quarantined).toBeInstanceOf(Uint8Array)
      expect(Array.from(quarantined as Uint8Array)).toEqual(planted.get(key))
    }
    const quarantineKeys = Array.from(mockStore.keys()).filter((k) =>
      k.startsWith('quarantine:'),
    )
    expect(quarantineKeys).toHaveLength(ORPHAN_KEYS.length)
    // Different keys carry different bytes: nothing was swapped around.
    expect(planted.get('income')).not.toEqual(planted.get('budgets'))
  })

  it('leaves no orphaned blob readable under its original key', async () => {
    const { text } = await makeBackup()
    const planted = plantOrphan()

    await restoreBackup(text, PW, 'replace')

    for (const key of ORPHAN_KEYS) {
      expect(Array.from(mockStore.get(key) as Uint8Array)).not.toEqual(
        planted.get(key),
      )
    }
  })

  it('overwrites an orphaned key the backup does not cover with an encrypted empty list', async () => {
    const { text } = await makeBackup()
    plantOrphan()

    await restoreBackup(text, PW, 'replace')

    expect(mockStore.get('expenses_2025_12')).toBeInstanceOf(Uint8Array)
    expect(await readRaw('expenses_2025_12')).toEqual([])
  })

  it('writes the header, settings, records and quarantine copies in one setMany', async () => {
    const { text } = await makeBackup()
    plantOrphan()
    ctl.setManyCalls.length = 0
    setNow(T2)

    await restoreBackup(text, PW, 'replace')

    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0]).toEqual(
      expect.arrayContaining([
        META_VAULT_KEY,
        META_SETTINGS_KEY,
        ...BACKUP_KEYS,
        ...ORPHAN_KEYS.map((key) => `quarantine:${key}:${T2}`),
      ]),
    )
  })

  it('removes the stale recoveryKeyConfirmed flag and marks a data change', async () => {
    const { text } = await makeBackup()
    plantOrphan()
    setNow(T2)

    await restoreBackup(text, PW, 'replace')

    const settings = storedSettings()
    expect(settings).toBeDefined()
    expect('recoveryKeyConfirmed' in (settings ?? {})).toBe(false)
    expect((await getAppSettings()).recoveryKeyConfirmed).toBe(true)
    expect(settings?.lastDataChangeAt).toBe(T2)
  })

  it('the adopted vault unlocks with the backup password and with its recovery key', async () => {
    const { recoveryKey, before, text } = await makeBackup()
    plantOrphan()

    await restoreBackup(text, PW, 'replace')

    lockVault()
    await unlockWithPassword(PW)
    expect(await snapshot()).toEqual(before)
    lockVault()
    await unlockWithRecoveryKey(recoveryKey)
    expect(await snapshot()).toEqual(before)
  })

  it('accepts the recovery key as the secret', async () => {
    const { recoveryKey, before, text } = await makeBackup()
    plantOrphan()

    await restoreBackup(text, recoveryKey.toLowerCase(), 'replace')

    expect(await snapshot()).toEqual(before)
  })

  it('quarantines a stored value that is not binary, unchanged', async () => {
    const { text } = await makeBackup()
    plantOrphan()
    mockStore.set('income', 'not a blob')
    setNow(T2)

    await restoreBackup(text, PW, 'replace')

    expect(mockStore.get(`quarantine:income:${T2}`)).toBe('not a blob')
    expect(mockStore.get('income')).toBeInstanceOf(Uint8Array)
  })

  it('a failed transaction leaves the store byte-identical, still orphaned and locked', async () => {
    const { text } = await makeBackup()
    plantOrphan()
    const before = cloneStore()
    ctl.failSetMany = true

    await expect(restoreBackup(text, PW, 'replace')).rejects.toThrow(
      'transaction aborted',
    )

    expectStoreEquals(before)
    expect(await getVaultState()).toBe('orphaned')
    expect(getLocalDbKey()).toBeNull()
  })

  it('a wrong secret writes nothing and leaves the device orphaned', async () => {
    const { text } = await makeBackup()
    plantOrphan()
    const before = cloneStore()
    ctl.setManyCalls.length = 0

    await expectBackupError(restoreBackup(text, WRONG, 'replace'), 'wrong-secret')

    expectStoreEquals(before)
    expect(ctl.setManyCalls).toHaveLength(0)
    expect(await getVaultState()).toBe('orphaned')
    expect(getLocalDbKey()).toBeNull()
  })

  it('a text that is not a backup writes nothing', async () => {
    await makeBackup()
    plantOrphan()
    const before = cloneStore()

    await expectBackupError(restoreBackup('not json', PW, 'replace'), 'invalid-file')

    expectStoreEquals(before)
  })

  it('a smaller orphan (one stray blob) is quarantined unchanged too', async () => {
    const { before, text } = await makeBackup()
    mockStore.set('income', new Uint8Array([1, 2, 3]))
    expect(await getVaultState()).toBe('orphaned')
    setNow(T3)

    await restoreBackup(text, PW, 'replace')

    expect(
      Array.from(mockStore.get(`quarantine:income:${T3}`) as Uint8Array),
    ).toEqual([1, 2, 3])
    expect(await snapshot()).toEqual(before)
  })
})

// ── restore: both encodings ───────────────────────────────────────────────────

describe('restoreBackup encodings', () => {
  it('restores a gzip+aes-gcm backup', async () => {
    await setupDevice()
    await seed()
    const before = await snapshot()
    const backup = await createBackup()
    expect(backup.payload.enc).toBe('gzip+aes-gcm')
    wipe()

    await restoreBackup(serializeBackup(backup), PW, 'replace')

    expect(await snapshot()).toEqual(before)
  })

  it('restores a plain aes-gcm backup', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    await setupDevice()
    await seed()
    const before = await snapshot()
    const backup = await createBackup()
    expect(backup.payload.enc).toBe('aes-gcm')
    wipe()

    await restoreBackup(serializeBackup(backup), PW, 'replace')

    expect(await snapshot()).toEqual(before)
  })

  it('restores a plain aes-gcm backup in a browser that has compression again', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    await setupDevice()
    await seed()
    const before = await snapshot()
    const text = serializeBackup(await createBackup())
    vi.unstubAllGlobals()
    wipe()

    await restoreBackup(text, PW, 'replace')

    expect(await snapshot()).toEqual(before)
  })
})

// ── restore: replace on an existing device ────────────────────────────────────

describe('restoreBackup replace on an existing device', () => {
  it('makes the local data equal the backup', async () => {
    await setupDevice()
    const s = await seed()
    const before = await snapshot()
    const header = await getVaultHeader()
    const text = serializeBackup(await createBackup())
    setNow(T2)
    await addExpense({
      amount: 3,
      currency: 'UAH',
      categoryId: s.food.id,
      createdAt: '2026-03-10T10:00:00.000Z',
    })
    await updateCategory({ id: s.food.id, name: 'Meals' })
    await deleteExpense(s.lunch.id, s.lunch.createdAt)
    await deleteIncome(s.salary.id)

    const summary = await restoreBackup(text, PW, 'replace')

    expect(await snapshot()).toEqual(before)
    expect(summary).toEqual({
      mode: 'replace',
      expenses: 3,
      income: 1,
      categories: 2,
      budgets: 1,
      added: 2,
      updated: 5,
      conflicts: 0,
      skipped: [],
      adoptedVault: false,
    })
    expect(await getVaultHeader()).toEqual(header)
  })

  it('overwrites local keys the backup does not cover with an encrypted empty list', async () => {
    await setupDevice()
    const s = await seed()
    const text = serializeBackup(await createBackup())
    await addExpense({
      amount: 3,
      currency: 'UAH',
      categoryId: s.food.id,
      createdAt: '2026-03-10T10:00:00.000Z',
    })
    expect(await readRaw('expenses_2026_03')).toHaveLength(1)

    await restoreBackup(text, PW, 'replace')

    expect(mockStore.get('expenses_2026_03')).toBeInstanceOf(Uint8Array)
    expect(await readRaw('expenses_2026_03')).toEqual([])
    expect((await getAllExpenses()).map((e) => e.createdAt)).not.toContain(
      '2026-03-10T10:00:00.000Z',
    )
  })

  it('writes everything in one transaction', async () => {
    await setupDevice()
    await seed()
    const text = serializeBackup(await createBackup())
    await addIncome({ source: 'Later', amount: 1, currency: 'UAH' })
    ctl.setManyCalls.length = 0

    await restoreBackup(text, PW, 'replace')

    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0]).toContain(META_SETTINGS_KEY)
    expect(ctl.setManyCalls[0]).not.toContain(META_VAULT_KEY)
  })

  it('a failed transaction leaves the local data unchanged', async () => {
    await setupDevice()
    const s = await seed()
    const text = serializeBackup(await createBackup())
    await addExpense({
      amount: 3,
      currency: 'UAH',
      categoryId: s.food.id,
      createdAt: '2026-03-10T10:00:00.000Z',
    })
    await deleteExpense(s.lunch.id, s.lunch.createdAt)
    const before = cloneStore()
    const snapBefore = await snapshot()
    ctl.failSetMany = true

    await expect(restoreBackup(text, PW, 'replace')).rejects.toThrow(
      'transaction aborted',
    )

    expectStoreEquals(before)
    expect(await snapshot()).toEqual(snapBefore)
  })

  it('moves an unreadable local blob to quarantine instead of destroying it', async () => {
    await setupDevice()
    await seed()
    const before = await snapshot()
    const text = serializeBackup(await createBackup())
    const garbage = crypto.getRandomValues(new Uint8Array(64))
    mockStore.set('expenses_2026_02', garbage)
    setNow(T2)

    await restoreBackup(text, PW, 'replace')

    expect(await snapshot()).toEqual(before)
    const quarantined = Array.from(mockStore.keys()).filter((k) =>
      k.startsWith('quarantine:expenses_2026_02:'),
    )
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]).toBe(`quarantine:expenses_2026_02:${T2}`)
    expect(Array.from(mockStore.get(quarantined[0]) as Uint8Array)).toEqual(
      Array.from(garbage),
    )
  })

  it('the Data problem path: the blob that raised DecryptError is quarantined unchanged in the same setMany as the restored records', async () => {
    await setupDevice()
    await seed()
    const before = await snapshot()
    const text = serializeBackup(await createBackup())
    const garbage = crypto.getRandomValues(new Uint8Array(64))
    mockStore.set('expenses_2026_02', garbage)
    // The corrupted blob is what the app trips over.
    await expect(getAllExpenses()).rejects.toBeInstanceOf(DecryptError)
    ctl.setManyCalls.length = 0
    setNow(T2)

    const summary = await restoreBackup(text, PW, 'replace')

    expect(summary.mode).toBe('replace')
    expect(summary.adoptedVault).toBe(false)
    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0]).toEqual(
      expect.arrayContaining([
        'expenses_2026_02',
        `quarantine:expenses_2026_02:${T2}`,
        META_SETTINGS_KEY,
      ]),
    )
    expect(ctl.setManyCalls[0]).not.toContain(META_VAULT_KEY)
    expect(
      Array.from(
        mockStore.get(`quarantine:expenses_2026_02:${T2}`) as Uint8Array,
      ),
    ).toEqual(Array.from(garbage))
    expect(await snapshot()).toEqual(before)
  })

  it('restores the auto-lock and reminder settings, but never lastBackupAt', async () => {
    await setupDevice()
    await seed()
    await updateAppSettings({ autoLockMinutes: 5 })
    await updateBackupSettings({ backupReminderDays: 30 })
    const text = serializeBackup(await createBackup())
    await updateAppSettings({ autoLockMinutes: 60 })
    await updateBackupSettings({
      backupReminderDays: 7,
      lastBackupAt: '2026-02-15T00:00:00.000Z',
    })
    mockStore.set(META_SETTINGS_KEY, {
      ...storedSettings(),
      failedUnlockAttempts: 2,
    })
    setNow(T3)

    await restoreBackup(text, PW, 'replace')

    expect((await getAppSettings()).autoLockMinutes).toBe(5)
    const backupSettings = await getBackupSettings()
    expect(backupSettings.backupReminderDays).toBe(30)
    expect(backupSettings.lastBackupAt).toBe('2026-02-15T00:00:00.000Z')
    expect(backupSettings.lastDataChangeAt).toBe(T3)
    expect(storedSettings()?.failedUnlockAttempts).toBe(2)
  })

  it('leaves recoveryKeyConfirmed as it was (false stays false, true stays true)', async () => {
    await setupDevice()
    await seed()
    const text = serializeBackup(await createBackup())
    expect(storedSettings()?.recoveryKeyConfirmed).toBe(false)

    await restoreBackup(text, PW, 'replace')
    expect(storedSettings()?.recoveryKeyConfirmed).toBe(false)

    await updateAppSettings({ recoveryKeyConfirmed: true })
    await restoreBackup(text, PW, 'replace')
    expect(storedSettings()?.recoveryKeyConfirmed).toBe(true)
  })
})

// ── restore: merge ────────────────────────────────────────────────────────────

describe('restoreBackup merge', () => {
  it('keeps newer local records, overwrites older ones, keeps local-only records', async () => {
    await setupDevice()
    const s = await seed()
    const older = cloneStore()
    setNow(T2)
    await updateExpense(s.ride.id, s.ride.createdAt, { amount: 99 })
    const text = serializeBackup(await createBackup())
    revertTo(older)
    setNow(T3)
    await updateExpense(s.dinner.id, s.dinner.createdAt, { amount: 77 })
    await addIncome({ source: 'Side', amount: 5, currency: 'UAH' })

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary).toEqual({
      mode: 'merge',
      expenses: 1,
      income: 0,
      categories: 0,
      budgets: 0,
      added: 0,
      updated: 1,
      conflicts: 0,
      skipped: [],
      adoptedVault: false,
    })
    const expenses = await getAllExpenses()
    expect(expenses.find((e) => e.id === s.ride.id)?.amount).toBe(99)
    expect(expenses.find((e) => e.id === s.dinner.id)?.amount).toBe(77)
    expect(expenses.find((e) => e.id === s.lunch.id)?.amount).toBe(10.5)
    expect(expenses).toHaveLength(3)
    expect((await getAllIncome()).map((i) => i.source).sort()).toEqual([
      'Job',
      'Side',
    ])
  })

  it('merging the same file twice adds and changes nothing the second time', async () => {
    await setupDevice()
    const s = await seed()
    const older = cloneStore()
    setNow(T2)
    await updateExpense(s.ride.id, s.ride.createdAt, { amount: 99 })
    const text = serializeBackup(await createBackup())
    revertTo(older)
    setNow(T3)
    const first = await restoreBackup(text, PW, 'merge')
    expect(first.updated).toBe(1)
    const afterFirst = await snapshot()
    const changeStamp = storedSettings()?.lastDataChangeAt
    expect(changeStamp).toBe(T3)
    setNow(T4)
    ctl.setManyCalls.length = 0

    const second = await restoreBackup(text, PW, 'merge')

    expect(second).toMatchObject({ added: 0, updated: 0, conflicts: 0 })
    expect(second.expenses + second.income + second.categories + second.budgets).toBe(0)
    expect(ctl.setManyCalls).toHaveLength(0)
    expect(storedSettings()?.lastDataChangeAt).toBe(T3)
    expect(await snapshot()).toEqual(afterFirst)
  })

  it('adds records that are missing locally', async () => {
    await setupDevice()
    const s = await seed()
    const before = await snapshot()
    const text = serializeBackup(await createBackup())
    await deleteExpense(s.ride.id, s.ride.createdAt)
    await deleteIncome(s.salary.id)
    setNow(T2)

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary).toMatchObject({
      mode: 'merge',
      expenses: 1,
      income: 1,
      categories: 0,
      budgets: 0,
      added: 2,
      updated: 0,
      conflicts: 0,
    })
    expect(await snapshot()).toEqual(before)
    expect(storedSettings()?.lastDataChangeAt).toBe(T2)
  })

  it('counts equal timestamps with different content as a conflict and keeps local', async () => {
    await setupDevice()
    const s = await seed()
    const older = cloneStore()
    setNow(T2)
    await updateExpense(s.ride.id, s.ride.createdAt, { amount: 50 })
    const text = serializeBackup(await createBackup())
    revertTo(older)
    await updateExpense(s.ride.id, s.ride.createdAt, { amount: 60 })
    ctl.setManyCalls.length = 0

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary).toMatchObject({ added: 0, updated: 0, conflicts: 1 })
    expect(
      (await getAllExpenses()).find((e) => e.id === s.ride.id)?.amount,
    ).toBe(60)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('moves a record to its new month and cleans up the old chunk', async () => {
    await setupDevice()
    const s = await seed()
    const older = cloneStore()
    setNow(T2)
    await updateExpense(s.lunch.id, s.lunch.createdAt, {
      createdAt: '2026-02-10T12:00:00.000Z',
    })
    const text = serializeBackup(await createBackup())
    revertTo(older)
    setNow(T3)

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary).toMatchObject({ expenses: 1, updated: 1, added: 0 })
    const lunches = (await getAllExpenses()).filter((e) => e.id === s.lunch.id)
    expect(lunches).toHaveLength(1)
    expect(lunches[0].createdAt).toBe('2026-02-10T12:00:00.000Z')
    expect(await getAllExpenses()).toHaveLength(3)
    expect(await readRaw('expenses_2026_01')).toEqual([])
  })

  it('leaves the local settings alone', async () => {
    await setupDevice()
    const s = await seed()
    await updateAppSettings({ autoLockMinutes: 5 })
    await updateBackupSettings({ backupReminderDays: 30 })
    const text = serializeBackup(await createBackup())
    await updateAppSettings({ autoLockMinutes: 60 })
    await updateBackupSettings({ backupReminderDays: 7 })
    await deleteExpense(s.ride.id, s.ride.createdAt)

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary.added).toBe(1)
    expect((await getAppSettings()).autoLockMinutes).toBe(60)
    expect((await getBackupSettings()).backupReminderDays).toBe(7)
  })

  it('leaves recoveryKeyConfirmed as it was', async () => {
    await setupDevice()
    const s = await seed()
    const text = serializeBackup(await createBackup())
    await deleteExpense(s.ride.id, s.ride.createdAt)
    expect(storedSettings()?.recoveryKeyConfirmed).toBe(false)

    await restoreBackup(text, PW, 'merge')

    expect(storedSettings()?.recoveryKeyConfirmed).toBe(false)
  })

  it('writes the data and the settings in one transaction', async () => {
    await setupDevice()
    const s = await seed()
    const text = serializeBackup(await createBackup())
    await deleteExpense(s.ride.id, s.ride.createdAt)
    ctl.setManyCalls.length = 0

    await restoreBackup(text, PW, 'merge')

    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0]).toEqual(
      expect.arrayContaining(['expenses_2026_02', META_SETTINGS_KEY]),
    )
  })

  it('a failed transaction leaves the local data unchanged', async () => {
    await setupDevice()
    const s = await seed()
    const text = serializeBackup(await createBackup())
    await deleteExpense(s.ride.id, s.ride.createdAt)
    const before = cloneStore()
    ctl.failSetMany = true

    await expect(restoreBackup(text, PW, 'merge')).rejects.toThrow(
      'transaction aborted',
    )

    expectStoreEquals(before)
  })

  it('refuses to merge into a local key it cannot decrypt, and writes nothing', async () => {
    await setupDevice()
    const s = await seed()
    const text = serializeBackup(await createBackup())
    await deleteExpense(s.lunch.id, s.lunch.createdAt)
    mockStore.set('expenses_2026_02', crypto.getRandomValues(new Uint8Array(64)))
    const before = cloneStore()

    const err = await restoreBackup(text, PW, 'merge').then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(DecryptError)
    expect((err as DecryptError).storageKey).toBe('expenses_2026_02')
    expectStoreEquals(before)
  })

  it('re-encrypts records with the local key when the backup is from another vault', async () => {
    await setupDevice(PW)
    await seed()
    const before = await snapshot()
    const text = serializeBackup(await createBackup())
    wipe()
    await setupDevice(PW2)
    await addIncome({ source: 'Local', amount: 3, currency: 'UAH' })
    const header = await getVaultHeader()

    const summary = await restoreBackup(text, PW, 'merge')

    expect(summary).toMatchObject({
      mode: 'merge',
      adoptedVault: false,
      expenses: 3,
      income: 1,
      categories: 2,
      budgets: 1,
    })
    const after = await snapshot()
    expect(after.expenses).toEqual(before.expenses)
    expect(after.categories).toEqual(before.categories)
    expect(after.budgets).toEqual(before.budgets)
    expect(after.income.map((i) => i.source).sort()).toEqual(['Job', 'Local'])
    expect(await getVaultHeader()).toEqual(header)
    lockVault()
    await expect(unlockWithPassword(PW)).rejects.toBeInstanceOf(VaultError)
    await unlockWithPassword(PW2)
    expect(await getAllExpenses()).toHaveLength(3)
  })
})

// ── password change (AC8) ─────────────────────────────────────────────────────

describe('a backup made before a password change', () => {
  it('opens with the old password and the recovery key, not the new password', async () => {
    const recoveryKey = await setupDevice(PW)
    await seed()
    const before = await snapshot()
    const old = serializeBackup(await createBackup())
    await changePassword(PW, PW2)

    wipe()
    await expectBackupError(restoreBackup(old, PW2, 'replace'), 'wrong-secret')
    expect(mockStore.size).toBe(0)

    await restoreBackup(old, PW, 'replace')
    expect(await snapshot()).toEqual(before)
    lockVault()
    await expect(unlockWithPassword(PW2)).rejects.toMatchObject({
      code: 'incorrect-password',
    })
    await unlockWithPassword(PW)

    wipe()
    await restoreBackup(old, recoveryKey, 'replace')
    expect(await snapshot()).toEqual(before)
  })

  it('a backup made after the change opens with the new password only', async () => {
    await setupDevice(PW)
    await seed()
    await changePassword(PW, PW2)
    const fresh = serializeBackup(await createBackup())
    wipe()

    await expectBackupError(restoreBackup(fresh, PW, 'replace'), 'wrong-secret')
    await restoreBackup(fresh, PW2, 'replace')

    expect(await getAllExpenses()).toHaveLength(3)
  })

  it('merging into the changed vault keeps the local header and password', async () => {
    await setupDevice(PW)
    const s = await seed()
    const old = serializeBackup(await createBackup())
    await changePassword(PW, PW2)
    await deleteExpense(s.ride.id, s.ride.createdAt)
    const header = await getVaultHeader()

    const summary = await restoreBackup(old, PW, 'merge')

    expect(summary.added).toBe(1)
    expect(await getVaultHeader()).toEqual(header)
    lockVault()
    await unlockWithPassword(PW2)
    expect(await getAllExpenses()).toHaveLength(3)
  })
})

// ── partial backup (AC9) ──────────────────────────────────────────────────────

describe('partial backup round trip', () => {
  it('keeps every readable record, lists the corrupted key, and restores the rest', async () => {
    await setupDevice()
    const s = await seed()
    const before = await snapshot()
    mockStore.set('expenses_2026_02', crypto.getRandomValues(new Uint8Array(64)))
    const backup = await createBackup({ allowPartial: true })
    expect(backup.skipped).toEqual(['expenses_2026_02'])
    wipe()

    const summary = await restoreBackup(serializeBackup(backup), PW, 'replace')

    expect(summary.skipped).toEqual(['expenses_2026_02'])
    expect(summary).toMatchObject({
      expenses: 1,
      income: 1,
      categories: 2,
      budgets: 1,
    })
    const after = await snapshot()
    expect(after.expenses.map((e) => e.id)).toEqual([s.lunch.id])
    expect(after.income).toEqual(before.income)
    expect(after.categories).toEqual(before.categories)
    expect(after.budgets).toEqual(before.budgets)
  })

  it('a full backup restores with an empty skipped list', async () => {
    await setupDevice()
    await seed()
    const text = serializeBackup(await createBackup())
    wipe()

    expect((await restoreBackup(text, PW, 'replace')).skipped).toEqual([])
  })
})

// ── downloadBackup ────────────────────────────────────────────────────────────

describe('downloadBackup', () => {
  it('saves a .minima file through the share-capable helper and records lastBackupAt', async () => {
    await setupDevice()
    await seed()
    await updateBackupSettings({
      backupReminderSnoozedUntil: '2030-01-01T00:00:00.000Z',
    })
    setNow(T2)

    const result = await downloadBackup()

    expect(result.status).toBe('saved')
    expect(result.filename).toMatch(/^minima-backup-\d{4}-\d{2}-\d{2}\.minima$/)
    expect(result.skipped).toEqual([])
    expect(saveFile).toHaveBeenCalledTimes(1)
    const [blob, filename, options] = vi.mocked(saveFile).mock.calls[0]
    expect(filename).toBe(result.filename)
    expect(options).toEqual({ share: true })
    expect(blob.type).toBe('application/octet-stream')
    const parsed = parseBackupFile(await readText(blob))
    expect(parsed.format).toBe('minima-backup')
    expect(parsed.createdAt).toBe(T2)
    const settings = await getBackupSettings()
    expect(settings.lastBackupAt).toBe(T2)
    expect(settings.backupReminderSnoozedUntil).toBeNull()
  })

  it('the saved file restores on an empty device', async () => {
    await setupDevice()
    await seed()
    const before = await snapshot()
    await downloadBackup()
    const text = await readText(vi.mocked(saveFile).mock.calls[0][0])
    wipe()

    await restoreBackup(text, PW, 'replace')

    expect(await snapshot()).toEqual(before)
  })

  it('does not record lastBackupAt when the user cancels', async () => {
    await setupDevice()
    vi.mocked(saveFile).mockResolvedValue('cancelled')

    const result = await downloadBackup()

    expect(result.status).toBe('cancelled')
    expect((await getBackupSettings()).lastBackupAt).toBeNull()
  })

  it('does not record lastBackupAt when saving fails', async () => {
    await setupDevice()
    vi.mocked(saveFile).mockRejectedValue(new Error('share exploded'))

    await expect(downloadBackup()).rejects.toThrow('share exploded')

    expect((await getBackupSettings()).lastBackupAt).toBeNull()
  })

  it('records lastBackupAt only after saveFile has resolved', async () => {
    await setupDevice()
    const gate = deferred<'saved' | 'cancelled'>()
    vi.mocked(saveFile).mockReturnValue(gate.promise)
    setNow(T3)

    const pending = downloadBackup()
    await vi.waitFor(() => {
      expect(saveFile).toHaveBeenCalledTimes(1)
    })
    expect((await getBackupSettings()).lastBackupAt).toBeNull()

    gate.resolve('saved')
    await pending

    expect((await getBackupSettings()).lastBackupAt).toBe(T3)
  })

  it('without partial it fails on an unreadable key and saves nothing', async () => {
    await setupDevice()
    await seed()
    mockStore.set('expenses_2026_02', crypto.getRandomValues(new Uint8Array(64)))

    await expect(downloadBackup()).rejects.toBeInstanceOf(DecryptError)

    expect(saveFile).not.toHaveBeenCalled()
    expect((await getBackupSettings()).lastBackupAt).toBeNull()
  })

  it('with partial it saves the readable data and reports the skipped keys', async () => {
    await setupDevice()
    await seed()
    mockStore.set('expenses_2026_02', crypto.getRandomValues(new Uint8Array(64)))

    const result = await downloadBackup({ partial: true })

    expect(result.status).toBe('saved')
    expect(result.skipped).toEqual(['expenses_2026_02'])
    const parsed = parseBackupFile(await readText(vi.mocked(saveFile).mock.calls[0][0]))
    expect(parsed.skipped).toEqual(['expenses_2026_02'])
    expect((await getBackupSettings()).lastBackupAt).not.toBeNull()
  })
})
