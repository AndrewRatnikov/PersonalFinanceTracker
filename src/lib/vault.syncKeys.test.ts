// No CONTRACT_GAPs: getSyncKeys and its behaviour across unlock paths are
// specified in plan section 2 (decision D2) and the Interface Contract (module:
// vault.ts). The setup mirrors vault.test.ts (Map-backed idb-keyval mock).

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { VaultHeaderV2 } from '@/lib/vault'
import type { SyncRecord } from '@/lib/syncRecords'
import {
  decryptSyncRecord,
  encryptSyncRecord,
  recordKeyFor,
} from '@/lib/cloud/recordCrypto'
import { getLocalDbKey, unlockLocalDb } from '@/lib/localDb'
import {
  META_VAULT_KEY,
  VaultError,
  changePassword,
  createVault,
  getSyncKeys,
  getVaultHeader,
  lockVault,
  openHeaderWithSecret,
  resetPasswordWithRecoveryKey,
  unlockWithPassword,
  unlockWithRecoveryKey,
  verifyPassword,
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
    for (const [k, v] of entries) mockStore.set(k, v)
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

const RECORD: SyncRecord = {
  type: 'expense',
  id: 'e1',
  updatedAt: '2026-10-23T10:00:00.000Z',
  data: { amount: 500 },
}

beforeEach(() => {
  mockStore.clear()
  localStorage.clear()
  lockVault()
})

async function currentRecordKey(): Promise<string> {
  return recordKeyFor(await getSyncKeys(), 'expense', 'e1')
}

async function expectInvalidState(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(VaultError)
  expect((err as VaultError).code).toBe('invalid-state')
}

describe('getSyncKeys', () => {
  it('derives keys after createVault', async () => {
    await createVault(PW)

    const key = await currentRecordKey()

    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('rejects with invalid-state when the vault is locked', async () => {
    await createVault(PW)
    await getSyncKeys()

    lockVault()

    await expectInvalidState(getSyncKeys())
  })

  it('rejects with invalid-state when no vault was ever unlocked', async () => {
    await expectInvalidState(getSyncKeys())
  })

  it('returns the same keys object for repeated calls in one session', async () => {
    await createVault(PW)
    const first = await getSyncKeys()
    const second = await getSyncKeys()
    expect(second).toBe(first)
  })

  it('exposes only the two purpose-bound keys, never the DEK', async () => {
    await createVault(PW)
    const keys = await getSyncKeys()

    expect(Object.keys(keys).sort()).toEqual(['data', 'index'])
    expect(keys.index.extractable).toBe(false)
    expect(keys.data.extractable).toBe(false)

    const dek = getLocalDbKey()
    expect(dek).not.toBeNull()
    expect(dek?.extractable).toBe(false)
    expect(dek?.algorithm.name).toBe('AES-GCM')
    await expect(crypto.subtle.exportKey('raw', dek as CryptoKey)).rejects.toThrow()
    await expect(crypto.subtle.exportKey('raw', keys.data)).rejects.toThrow()
  })

  it('gives the same record key after unlocking with the password', async () => {
    await createVault(PW)
    const before = await currentRecordKey()

    lockVault()
    await unlockWithPassword(PW)

    expect(await currentRecordKey()).toBe(before)
  })

  it('gives the same record key after unlocking with the recovery key', async () => {
    const { recoveryKey } = await createVault(PW)
    const before = await currentRecordKey()

    lockVault()
    await unlockWithRecoveryKey(recoveryKey)

    expect(await currentRecordKey()).toBe(before)
  })

  it('gives the same record key after changePassword and a fresh unlock', async () => {
    await createVault(PW)
    const before = await currentRecordKey()

    await changePassword(PW, 'a brand new passphrase')
    expect(await currentRecordKey()).toBe(before)

    lockVault()
    await unlockWithPassword('a brand new passphrase')
    expect(await currentRecordKey()).toBe(before)
  })

  it('gives the same record key after resetting the password with the recovery key', async () => {
    const { recoveryKey } = await createVault(PW)
    const before = await currentRecordKey()

    lockVault()
    await resetPasswordWithRecoveryKey(recoveryKey, 'reset passphrase 42')

    expect(await currentRecordKey()).toBe(before)
  })

  it('keeps the keys when verifyPassword runs while unlocked', async () => {
    await createVault(PW)
    const keys = await getSyncKeys()

    await verifyPassword(PW)

    expect(await getSyncKeys()).toBe(keys)
  })

  it('works on a fresh device that adopts a backup header (openHeaderWithSecret)', async () => {
    await createVault(PW)
    const before = await currentRecordKey()
    const backupHeader = structuredClone(await getVaultHeader())

    // A second device: nothing stored, nothing unlocked.
    lockVault()
    mockStore.clear()
    await expectInvalidState(getSyncKeys())

    const dek = await openHeaderWithSecret(backupHeader, PW)
    expect(dek).not.toBeNull()
    unlockLocalDb(dek as CryptoKey)

    expect(await currentRecordKey()).toBe(before)
  })

  it('a different vault gives different keys', async () => {
    await createVault(PW)
    const first = await currentRecordKey()

    lockVault()
    mockStore.clear()
    await createVault(PW)
    const second = await currentRecordKey()

    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second).not.toBe(first)
  })

  it('records encrypted in one session decrypt in the next', async () => {
    await createVault(PW)
    const row = await encryptSyncRecord(await getSyncKeys(), RECORD)

    lockVault()
    await unlockWithPassword(PW)

    expect(await decryptSyncRecord(await getSyncKeys(), row)).toEqual(RECORD)
  })

  it('a different vault cannot decrypt those records', async () => {
    await createVault(PW)
    const row = await encryptSyncRecord(await getSyncKeys(), RECORD)

    lockVault()
    mockStore.clear()
    await createVault(PW)

    await expect(decryptSyncRecord(await getSyncKeys(), row)).rejects.toMatchObject({
      name: 'SyncRecordError',
      code: 'decrypt-failed',
    })
  })
})

describe('the vault header format is unchanged', () => {
  it('has exactly the v2 keys and nothing about sync', async () => {
    await createVault(PW)

    const header = mockStore.get(META_VAULT_KEY) as VaultHeaderV2
    expect(Object.keys(header).sort()).toEqual([
      'createdAt',
      'kdf',
      'recovery',
      'v',
      'vaultId',
      'verifier',
      'wrappedByPassword',
    ])
    expect(header.v).toBe(2)
  })

  it('stays the same keys after unlocking and changing the password', async () => {
    await createVault(PW)
    await getSyncKeys()
    await changePassword(PW, 'another passphrase 7')
    lockVault()
    await unlockWithPassword('another passphrase 7')
    await getSyncKeys()

    const header = mockStore.get(META_VAULT_KEY) as VaultHeaderV2
    expect(Object.keys(header).sort()).toEqual([
      'createdAt',
      'kdf',
      'recovery',
      'v',
      'vaultId',
      'verifier',
      'wrappedByPassword',
    ])
  })
})
