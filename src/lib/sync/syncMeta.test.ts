// No CONTRACT_GAPs: syncMeta exports, the field list and the "user writes keep
// the sync fields" rule are specified in plan section 2 and the Interface
// Contract (module: meta:sync). Integration style as localDb.rev.test.ts: real
// crypto, real vault and localDb, idb-keyval backed by a Map.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBackup, restoreBackup, serializeBackup } from '@/lib/backup'
import {
  SYNC_META_KEY,
  addCategory,
  addExpense,
  deleteExpense,
  getAllExpenses,
  getLocalRev,
  syncMetaEntry,
} from '@/lib/localDb'
import {
  SYNC_FIELD_NAMES,
  clearSyncFields,
  isSyncOn,
  parseSyncMeta,
  readSyncMeta,
  updateSyncMeta,
} from '@/lib/sync/syncMeta'
import { createVault, lockVault } from '@/lib/vault'

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

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const PW = 'correct horse battery'

const FULL = {
  localRev: 7,
  enabled: true,
  userId: 'user-1',
  vaultId: 'vault-1',
  deviceId: 'device-1',
  pushedRev: 5,
  pullCursor: 40,
  headerRev: 2,
  lastSyncAt: '2026-10-24T10:00:00.000Z',
  lastError: null,
}

const SYNC_ONLY = {
  enabled: true,
  userId: 'user-1',
  vaultId: 'vault-1',
  deviceId: 'device-1',
  pushedRev: 5,
  pullCursor: 40,
  headerRev: 2,
  lastSyncAt: null,
  lastError: null,
}

function stored(): Record<string, unknown> {
  return mockStore.get(SYNC_META_KEY) as Record<string, unknown>
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-24T09:00:00.000Z'))
  mockStore.clear()
  localStorage.clear()
  lockVault()
  await createVault(PW)
})

afterEach(() => {
  vi.useRealTimers()
  lockVault()
})

describe('parseSyncMeta', () => {
  it.each([undefined, null, 'x', 5, [], true])('treats %j as no meta', (raw) => {
    expect(parseSyncMeta(raw)).toEqual({ localRev: 0 })
  })

  it('keeps a complete valid object', () => {
    expect(parseSyncMeta(FULL)).toEqual(FULL)
  })

  it('parses localRev like localDb: a non-negative integer, else 0', () => {
    expect(parseSyncMeta({ localRev: 12 }).localRev).toBe(12)
    expect(parseSyncMeta({ localRev: 0 }).localRev).toBe(0)
    expect(parseSyncMeta({ localRev: -1 }).localRev).toBe(0)
    expect(parseSyncMeta({ localRev: 1.5 }).localRev).toBe(0)
    expect(parseSyncMeta({ localRev: '4' }).localRev).toBe(0)
  })

  it('drops ill-typed fields and keeps the good ones', () => {
    const parsed = parseSyncMeta({
      ...FULL,
      enabled: 'yes',
      pushedRev: 'x',
      userId: 12,
      lastError: 'boom',
    })
    expect(parsed.enabled).toBeUndefined()
    expect(parsed.pushedRev).toBeUndefined()
    expect(parsed.userId).toBeUndefined()
    expect(parsed.lastError).toBeUndefined()
    expect(parsed.vaultId).toBe('vault-1')
    expect(parsed.pullCursor).toBe(40)
    expect(parsed.localRev).toBe(7)
  })

  it('ignores unknown keys', () => {
    expect(parseSyncMeta({ localRev: 3, extra: 1 })).toEqual({ localRev: 3 })
  })

  it('keeps a well-formed lastError', () => {
    const lastError = { code: 'undecryptable', count: 2, at: '2026-10-24T10:00:00.000Z' }
    expect(parseSyncMeta({ localRev: 1, lastError }).lastError).toEqual(lastError)
  })
})

describe('SYNC_FIELD_NAMES', () => {
  it('lists the sync fields and not localRev', () => {
    for (const name of [
      'enabled',
      'userId',
      'vaultId',
      'deviceId',
      'pushedRev',
      'pullCursor',
      'headerRev',
      'lastSyncAt',
      'lastError',
    ]) {
      expect(SYNC_FIELD_NAMES).toContain(name)
    }
    expect(SYNC_FIELD_NAMES as ReadonlyArray<string>).not.toContain('localRev')
  })
})

describe('isSyncOn', () => {
  it('is true for a complete enabled meta', () => {
    expect(isSyncOn(parseSyncMeta(FULL))).toBe(true)
  })

  it('is false for the plain counter and for missing fields', () => {
    expect(isSyncOn({ localRev: 4 })).toBe(false)
    for (const field of ['userId', 'vaultId', 'deviceId', 'pushedRev', 'pullCursor', 'headerRev']) {
      const meta = parseSyncMeta({ ...FULL, [field]: undefined })
      expect(isSyncOn(meta), field).toBe(false)
    }
  })

  it('is false when enabled is false or an id is empty', () => {
    expect(isSyncOn(parseSyncMeta({ ...FULL, enabled: false }))).toBe(false)
    expect(isSyncOn(parseSyncMeta({ ...FULL, userId: '' }))).toBe(false)
    expect(isSyncOn(parseSyncMeta({ ...FULL, vaultId: '' }))).toBe(false)
    expect(isSyncOn(parseSyncMeta({ ...FULL, deviceId: '' }))).toBe(false)
  })
})

describe('readSyncMeta / updateSyncMeta / clearSyncFields', () => {
  it('reads the plain counter before any sync field exists', async () => {
    expect(await readSyncMeta()).toEqual({ localRev: 0 })
    await addExpense({ amount: 100, currency: 'UAH', categoryId: 'c1' })
    expect(await readSyncMeta()).toEqual({ localRev: 1 })
  })

  it('updates merge into the stored fields', async () => {
    await updateSyncMeta({ enabled: true, userId: 'user-1', vaultId: 'v', deviceId: 'd' })
    await updateSyncMeta({ pushedRev: 3, pullCursor: 9, headerRev: 1, lastSyncAt: null, lastError: null })
    const meta = await readSyncMeta()

    expect(isSyncOn(meta)).toBe(true)
    expect(meta).toMatchObject({ userId: 'user-1', pushedRev: 3, pullCursor: 9 })

    const next = await updateSyncMeta({ pushedRev: 8 })
    expect(next.pushedRev).toBe(8)
    expect(next.pullCursor).toBe(9)
    expect((await readSyncMeta()).pushedRev).toBe(8)
  })

  it('never changes the stored localRev', async () => {
    await addExpense({ amount: 100, currency: 'UAH', categoryId: 'c1' })
    await addExpense({ amount: 200, currency: 'UAH', categoryId: 'c1' })
    expect((await readSyncMeta()).localRev).toBe(2)

    const meta = await updateSyncMeta({ enabled: true, userId: 'u', vaultId: 'v', deviceId: 'd' })
    expect(meta.localRev).toBe(2)
    expect(stored().localRev).toBe(2)
    expect(await getLocalRev()).toBe(2)
  })

  it('clearSyncFields removes the sync fields and keeps localRev', async () => {
    await addExpense({ amount: 100, currency: 'UAH', categoryId: 'c1' })
    await updateSyncMeta({ enabled: true, userId: 'u', vaultId: 'v', deviceId: 'd', pushedRev: 1, pullCursor: 4, headerRev: 1, lastSyncAt: null, lastError: null })
    const cleared = await clearSyncFields()

    expect(cleared).toEqual({ localRev: 1 })
    expect(stored()).toEqual({ localRev: 1 })
    expect(isSyncOn(await readSyncMeta())).toBe(false)
  })

  it('works while the vault is locked', async () => {
    await updateSyncMeta({ enabled: true, userId: 'u', vaultId: 'v', deviceId: 'd', pushedRev: -1, pullCursor: 0, headerRev: 1, lastSyncAt: null, lastError: null })
    lockVault()
    expect(isSyncOn(await readSyncMeta())).toBe(true)
  })
})

describe('user writes keep the sync fields', () => {
  beforeEach(async () => {
    await updateSyncMeta(SYNC_ONLY)
  })

  it('addExpense bumps localRev and keeps every other field', async () => {
    await addExpense({ amount: 100, currency: 'UAH', categoryId: 'c1' })

    expect(stored()).toEqual({ ...SYNC_ONLY, localRev: 1 })
  })

  it('a later write keeps them too, with a higher localRev', async () => {
    const e = await addExpense({ amount: 100, currency: 'UAH', categoryId: 'c1' })
    await addCategory({ name: 'Food' })
    await deleteExpense(e.id, e.createdAt)

    expect(stored()).toMatchObject({ ...SYNC_ONLY })
    expect(stored().localRev).toBe(3)
  })

  it('the stored value is exactly { localRev } when no sync field exists', async () => {
    await clearSyncFields()
    await addExpense({ amount: 100, currency: 'UAH', categoryId: 'c1' })
    expect(stored()).toEqual({ localRev: 1 })
  })

  it('a merge restore keeps the sync fields and bumps localRev', async () => {
    await addExpense({ amount: 100, currency: 'UAH', categoryId: 'c1', description: 'one' })
    const file = serializeBackup(await createBackup())
    // A different local database that does not have "one", so the merge writes.
    lockVault()
    mockStore.clear()
    await createVault(PW)
    await updateSyncMeta(SYNC_ONLY)
    vi.setSystemTime(new Date('2026-10-24T09:30:00.000Z'))
    await addExpense({ amount: 300, currency: 'UAH', categoryId: 'c1', description: 'two' })
    const before = await getLocalRev()

    await restoreBackup(file, PW, 'merge')

    expect(stored()).toMatchObject(SYNC_ONLY)
    expect(stored().localRev as number).toBeGreaterThan(before)
    const descriptions = (await getAllExpenses()).map((e) => e.description).sort()
    expect(descriptions).toEqual(['one', 'two'])
  })
})

describe('syncMetaEntry', () => {
  it('returns the stored fields with localRev replaced', async () => {
    await updateSyncMeta(SYNC_ONLY)
    const [key, value] = await syncMetaEntry(42)

    expect(key).toBe(SYNC_META_KEY)
    expect(value).toEqual({ ...SYNC_ONLY, localRev: 42 })
  })

  it('is just { localRev } when nothing else is stored', async () => {
    const [key, value] = await syncMetaEntry(5)
    expect(key).toBe(SYNC_META_KEY)
    expect(value).toEqual({ localRev: 5 })
    const [, other] = await syncMetaEntry(6)
    expect(other).toEqual({ localRev: 6 })
  })
})
