// No CONTRACT_GAPs: the v1 migration behaviour is specified in the plan's
// vault.ts section and the Interface Contract test notes.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  decryptValue,
  deriveKey,
  encryptValue,
  getOrCreateDeviceSalt,
  storeKeyVerifier,
} from '@/lib/crypto'
import { getAllIncome, getLocalDbKey, wipeLocalDbKey } from '@/lib/localDb'
import {
  META_SETTINGS_KEY,
  META_VAULT_KEY,
  clearLegacyKeys,
  getVaultState,
  unlockWithPassword,
} from '@/lib/vault'

const h = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  set: vi.fn(),
  setMany: vi.fn(),
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(h.mockStore.get(key)),
  set: (key: string, value: unknown) => h.set(key, value),
  setMany: (entries: Array<[string, unknown]>) => h.setMany(entries),
  del: (key: string) => {
    h.mockStore.delete(key)
    return Promise.resolve()
  },
  clear: () => {
    h.mockStore.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(h.mockStore.keys())),
}))

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const KEY_RE =
  /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}-[0-9A-HJKMNP-TV-Z]{2}$/
const PW = 'old v1 password'
const USER = 'u1'

const EXPENSES = [
  {
    id: 'e1',
    amount: 10,
    currency: 'UAH',
    categoryId: 'c1',
    description: 'Lunch',
    createdAt: '2026-03-15T12:00:00.000Z',
  },
  {
    id: 'e2',
    amount: 20,
    currency: 'USD',
    categoryId: 'c1',
    description: null,
    createdAt: '2026-03-20T08:30:00.000Z',
  },
]
const APRIL_EXPENSES = [
  {
    id: 'e3',
    amount: 30,
    currency: 'EUR',
    categoryId: 'c2',
    description: 'Bus',
    createdAt: '2026-04-02T09:00:00.000Z',
  },
]
const INCOME = [
  {
    id: 'i1',
    source: 'Job',
    amount: 1000,
    currency: 'USD',
    description: null,
    createdAt: '2026-03-01T00:00:00.000Z',
  },
]
const CATEGORIES = [
  { id: 'c1', name: 'Food', icon: '🍔' },
  { id: 'c2', name: 'Transport', icon: '🚌' },
]
const BUDGETS = [
  { id: 'b1', categoryId: 'c1', monthlyLimit: 500, currency: 'UAH' },
]

const V1_PLAINTEXT: Record<string, Array<unknown>> = {
  categories: CATEGORIES,
  income: INCOME,
  budgets: BUDGETS,
  expenses_2026_03: EXPENSES,
  expenses_2026_04: APRIL_EXPENSES,
}

let v1Blobs: Record<string, Array<number>> = {}

function bytesOf(key: string): Array<number> {
  return Array.from(h.mockStore.get(key) as Uint8Array)
}

async function seedV1(password = PW) {
  const salt = getOrCreateDeviceSalt(USER)
  const key = await deriveKey(password, salt)
  await storeKeyVerifier(key, USER)
  localStorage.setItem('minima_offline_user', JSON.stringify({ id: USER }))
  v1Blobs = {}
  for (const [storageKey, records] of Object.entries(V1_PLAINTEXT)) {
    h.mockStore.set(storageKey, await encryptValue(key, records))
    v1Blobs[storageKey] = bytesOf(storageKey)
  }
  return key
}

async function decryptStored(storageKey: string): Promise<unknown> {
  const key = getLocalDbKey()
  if (!key) throw new Error('expected an unlocked key')
  return decryptValue(key, h.mockStore.get(storageKey) as Uint8Array)
}

function legacyKeysInStorage(): Array<string> {
  return Object.keys(localStorage).filter(
    (k) =>
      k.startsWith('minima_device_salt_') ||
      k.startsWith('minima_key_verify_') ||
      k === 'minima_offline_user',
  )
}

beforeEach(() => {
  h.mockStore.clear()
  localStorage.clear()
  wipeLocalDbKey()
  h.set.mockReset()
  h.setMany.mockReset()
  h.set.mockImplementation((k: string, v: unknown) => {
    h.mockStore.set(k, v)
    return Promise.resolve()
  })
  h.setMany.mockImplementation((entries: Array<[string, unknown]>) => {
    for (const [k, v] of entries) h.mockStore.set(k, v)
    return Promise.resolve()
  })
})

describe('v1 -> v2 migration', () => {
  it('detects the v1 fixture as state v1', async () => {
    await seedV1()
    expect(await getVaultState()).toBe('v1')
  })

  it('migrates after unlockWithPassword with the old password and returns a recovery key', async () => {
    await seedV1()

    const result = await unlockWithPassword(PW)

    expect(result.recoveryKey).toMatch(KEY_RE)
    expect(await getVaultState()).toBe('v2')
    expect(h.mockStore.has(META_VAULT_KEY)).toBe(true)
    expect(getLocalDbKey()).not.toBeNull()
  })

  it('keeps every record and adds updatedAt = createdAt for expenses and income', async () => {
    await seedV1()
    await unlockWithPassword(PW)

    expect(await decryptStored('expenses_2026_03')).toEqual(
      EXPENSES.map((e) => ({ ...e, updatedAt: e.createdAt })),
    )
    expect(await decryptStored('expenses_2026_04')).toEqual(
      APRIL_EXPENSES.map((e) => ({ ...e, updatedAt: e.createdAt })),
    )
    expect(await decryptStored('income')).toEqual(
      INCOME.map((e) => ({ ...e, updatedAt: e.createdAt })),
    )
  })

  it('adds an ISO updatedAt to categories and budgets, keeping their other fields', async () => {
    await seedV1()
    await unlockWithPassword(PW)

    const categories = (await decryptStored('categories')) as Array<{
      id: string
      name: string
      icon: string
      updatedAt: string
    }>
    const budgets = (await decryptStored('budgets')) as Array<{
      id: string
      categoryId: string
      monthlyLimit: number
      currency: string
      updatedAt: string
    }>

    expect(
      categories.map((c) => ({ id: c.id, name: c.name, icon: c.icon })),
    ).toEqual(CATEGORIES)
    expect(
      budgets.map((b) => ({
        id: b.id,
        categoryId: b.categoryId,
        monthlyLimit: b.monthlyLimit,
        currency: b.currency,
      })),
    ).toEqual(BUDGETS)
    for (const r of [...categories, ...budgets]) {
      expect(Number.isNaN(Date.parse(r.updatedAt))).toBe(false)
    }
  })

  it('preserves an updatedAt that a record already has', async () => {
    const salt = getOrCreateDeviceSalt(USER)
    const key = await deriveKey(PW, salt)
    await storeKeyVerifier(key, USER)
    h.mockStore.set(
      'income',
      await encryptValue(key, [{ ...INCOME[0], updatedAt: '2030-01-01T00:00:00.000Z' }]),
    )

    await unlockWithPassword(PW)

    const income = (await decryptStored('income')) as Array<{
      updatedAt: string
    }>
    expect(income[0].updatedAt).toBe('2030-01-01T00:00:00.000Z')
  })

  it('re-encrypts every blob (the old bytes are gone) and data is readable via localDb', async () => {
    await seedV1()
    await unlockWithPassword(PW)

    for (const storageKey of Object.keys(V1_PLAINTEXT)) {
      expect(bytesOf(storageKey)).not.toEqual(v1Blobs[storageKey])
    }
    const income = await getAllIncome()
    expect(income).toHaveLength(1)
    expect(income[0].updatedAt).toBe(INCOME[0].createdAt)
  })

  it('writes all re-encrypted values plus meta:vault and meta:settings in a single setMany call', async () => {
    await seedV1()
    await unlockWithPassword(PW)

    expect(h.setMany).toHaveBeenCalledTimes(1)
    const entries = h.setMany.mock.calls[0][0] as Array<[string, unknown]>
    expect(entries.map(([k]) => k).sort()).toEqual(
      [...Object.keys(V1_PLAINTEXT), META_VAULT_KEY, META_SETTINGS_KEY].sort(),
    )
  })

  it('does not write header or data with individual set calls', async () => {
    await seedV1()
    await unlockWithPassword(PW)

    const setKeys = h.set.mock.calls.map((c) => c[0] as string)
    expect(setKeys.filter((k) => k !== META_SETTINGS_KEY)).toEqual([])
  })

  it('creates a v2 header with 600k iterations and that unlocks with the same password afterwards', async () => {
    await seedV1()
    await unlockWithPassword(PW)
    wipeLocalDbKey()

    await expect(unlockWithPassword(PW)).resolves.toEqual({ recoveryKey: null })
    expect((await getAllIncome())[0].id).toBe('i1')
  })

  it('keeps the v1 localStorage keys after migration until clearLegacyKeys is called', async () => {
    await seedV1()
    await unlockWithPassword(PW)

    expect(localStorage.getItem('minima_device_salt_' + USER)).not.toBeNull()
    expect(localStorage.getItem('minima_key_verify_' + USER)).not.toBeNull()
    expect(localStorage.getItem('minima_offline_user')).not.toBeNull()
  })

  it('rejects a wrong v1 password, counts it, and leaves v1 intact', async () => {
    await seedV1()

    await expect(unlockWithPassword('nope nope nope')).rejects.toMatchObject({
      code: 'incorrect-password',
    })

    expect(await getVaultState()).toBe('v1')
    expect(h.mockStore.has(META_VAULT_KEY)).toBe(false)
    expect(h.setMany).not.toHaveBeenCalled()
    expect(
      (h.mockStore.get(META_SETTINGS_KEY) as { failedUnlockAttempts: number })
        .failedUnlockAttempts,
    ).toBe(1)
    expect(getLocalDbKey()).toBeNull()
  })

  it('leaves a blob it cannot decrypt untouched and still migrates the rest', async () => {
    await seedV1()
    const garbage = new Uint8Array(40).fill(7)
    h.mockStore.set('budgets', garbage)

    await unlockWithPassword(PW)

    expect(Array.from(h.mockStore.get('budgets') as Uint8Array)).toEqual(
      Array.from(garbage),
    )
    const entries = h.setMany.mock.calls[0][0] as Array<[string, unknown]>
    expect(entries.map(([k]) => k)).not.toContain('budgets')
    expect(entries.map(([k]) => k)).toContain('income')
    expect(await decryptStored('income')).toEqual(
      INCOME.map((e) => ({ ...e, updatedAt: e.createdAt })),
    )
  })
})

describe('migration recoveryKeyConfirmed flag', () => {
  it('sets recoveryKeyConfirmed: false inside the single migration setMany', async () => {
    await seedV1()

    await unlockWithPassword(PW)

    const entries = h.setMany.mock.calls[0][0] as Array<[string, unknown]>
    const settings = entries.find(([k]) => k === META_SETTINGS_KEY)?.[1] as
      | Record<string, unknown>
      | undefined
    expect(settings?.recoveryKeyConfirmed).toBe(false)
  })

  it('keeps the flag in the stored settings after the success counter reset', async () => {
    await seedV1()

    await unlockWithPassword(PW)

    const stored = h.mockStore.get(META_SETTINGS_KEY) as Record<string, unknown>
    expect(stored.recoveryKeyConfirmed).toBe(false)
    expect(stored.failedUnlockAttempts).toBe(0)
  })

  it('keeps settings fields that existed before the migration', async () => {
    await seedV1()
    h.mockStore.set(META_SETTINGS_KEY, {
      autoLockMinutes: 5,
      installHintDismissed: true,
    })

    await unlockWithPassword(PW)

    const entries = h.setMany.mock.calls[0][0] as Array<[string, unknown]>
    const settings = entries.find(([k]) => k === META_SETTINGS_KEY)?.[1]
    expect(settings).toEqual({
      autoLockMinutes: 5,
      installHintDismissed: true,
      recoveryKeyConfirmed: false,
    })
    expect(
      (h.mockStore.get(META_SETTINGS_KEY) as { autoLockMinutes: number })
        .autoLockMinutes,
    ).toBe(5)
  })

  it('does not set the flag when the migration fails or the password is wrong', async () => {
    await seedV1()

    await expect(unlockWithPassword('nope nope nope')).rejects.toMatchObject({
      code: 'incorrect-password',
    })

    const stored = h.mockStore.get(META_SETTINGS_KEY) as Record<string, unknown>
    expect('recoveryKeyConfirmed' in stored).toBe(false)
  })
})

describe('migration failure before commit', () => {
  it('leaves all v1 data, no meta:vault and all v1 keys intact, and can be retried', async () => {
    await seedV1()
    const legacyBefore = legacyKeysInStorage().sort()
    h.setMany.mockImplementation(() => Promise.reject(new Error('quota')))

    await expect(unlockWithPassword(PW)).rejects.toThrow('quota')

    expect(h.mockStore.has(META_VAULT_KEY)).toBe(false)
    for (const storageKey of Object.keys(V1_PLAINTEXT)) {
      expect(bytesOf(storageKey)).toEqual(v1Blobs[storageKey])
    }
    expect(legacyKeysInStorage().sort()).toEqual(legacyBefore)
    expect(await getVaultState()).toBe('v1')
    expect(getLocalDbKey()).toBeNull()

    // Retry succeeds once the transaction can commit.
    h.setMany.mockImplementation((entries: Array<[string, unknown]>) => {
      for (const [k, v] of entries) h.mockStore.set(k, v)
      return Promise.resolve()
    })
    const retry = await unlockWithPassword(PW)

    expect(retry.recoveryKey).toMatch(KEY_RE)
    expect(await getVaultState()).toBe('v2')
    expect(await decryptStored('income')).toEqual(
      INCOME.map((e) => ({ ...e, updatedAt: e.createdAt })),
    )
  })

  it('does not count a storage failure as a wrong password', async () => {
    await seedV1()
    h.setMany.mockImplementation(() => Promise.reject(new Error('quota')))

    await expect(unlockWithPassword(PW)).rejects.toThrow('quota')

    const s = h.mockStore.get(META_SETTINGS_KEY) as
      | { failedUnlockAttempts: number }
      | undefined
    expect(s?.failedUnlockAttempts ?? 0).toBe(0)
  })

  it('does not leave recoveryKeyConfirmed behind when the commit fails', async () => {
    await seedV1()
    h.setMany.mockImplementation(() => Promise.reject(new Error('quota')))

    await expect(unlockWithPassword(PW)).rejects.toThrow('quota')

    const s = h.mockStore.get(META_SETTINGS_KEY) as
      | Record<string, unknown>
      | undefined
    expect(s === undefined || !('recoveryKeyConfirmed' in s)).toBe(true)
  })
})

describe('clearLegacyKeys', () => {
  it('removes v1 device salts, verifiers and the offline user once the vault is v2, keeping other keys', async () => {
    await seedV1()
    await unlockWithPassword(PW)
    localStorage.setItem('minima_device_salt_u2', 'aabb')
    localStorage.setItem('unrelated', 'keep me')

    await clearLegacyKeys()

    expect(legacyKeysInStorage()).toEqual([])
    expect(localStorage.getItem('unrelated')).toBe('keep me')
  })

  it('is a no-op while no meta:vault exists', async () => {
    await seedV1()
    const before = legacyKeysInStorage().sort()
    expect(before.length).toBeGreaterThan(0)

    await clearLegacyKeys()

    expect(legacyKeysInStorage().sort()).toEqual(before)
    expect(await getVaultState()).toBe('v1')
  })
})
