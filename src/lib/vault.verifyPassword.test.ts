// No CONTRACT_GAPs: verifyPassword and its error codes are fully specified in
// the Interface Contract (module: vault, new export verifyPassword).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MetaSettings } from '@/lib/vault'
import { getLocalDbKey } from '@/lib/localDb'
import {
  META_SETTINGS_KEY,
  META_VAULT_KEY,
  VaultError,
  createVault,
  lockVault,
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
const WRONG = 'wrong password 123'

function settings(): MetaSettings | undefined {
  return mockStore.get(META_SETTINGS_KEY) as MetaSettings | undefined
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(VaultError)
    return (err as VaultError).code
  }
  throw new Error('expected the promise to reject')
}

beforeEach(() => {
  mockStore.clear()
  localStorage.clear()
  lockVault()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('verifyPassword', () => {
  it('resolves for the correct password', async () => {
    await createVault(PW)

    await expect(verifyPassword(PW)).resolves.toBeUndefined()
  })

  it('rejects a wrong password with incorrect-password', async () => {
    await createVault(PW)

    expect(await codeOf(verifyPassword(WRONG))).toBe('incorrect-password')
  })

  it('rejects with invalid-state when there is no vault', async () => {
    expect(await codeOf(verifyPassword(PW))).toBe('invalid-state')
  })

  it('does not unlock the vault: the in-memory key stays null', async () => {
    await createVault(PW)
    lockVault()
    expect(getLocalDbKey()).toBeNull()

    await verifyPassword(PW)

    expect(getLocalDbKey()).toBeNull()
  })

  it('does not replace the key of an unlocked vault', async () => {
    await createVault(PW)
    const before = getLocalDbKey()
    expect(before).not.toBeNull()

    await verifyPassword(PW)

    expect(getLocalDbKey()).toBe(before)
  })

  it('does not rewrite the vault header', async () => {
    await createVault(PW)
    const before = JSON.stringify(mockStore.get(META_VAULT_KEY))

    await verifyPassword(PW)
    await verifyPassword(WRONG).catch(() => {})

    expect(JSON.stringify(mockStore.get(META_VAULT_KEY))).toBe(before)
  })

  it('counts a wrong password toward the brute-force counter', async () => {
    await createVault(PW)

    await verifyPassword(WRONG).catch(() => {})
    expect(settings()?.failedUnlockAttempts).toBe(1)

    await verifyPassword(WRONG).catch(() => {})
    expect(settings()?.failedUnlockAttempts).toBe(2)
  })

  it('resets the counter on success', async () => {
    await createVault(PW)
    await verifyPassword(WRONG).catch(() => {})
    await verifyPassword(WRONG).catch(() => {})
    expect(settings()?.failedUnlockAttempts).toBe(2)

    await verifyPassword(PW)

    expect(settings()?.failedUnlockAttempts).toBe(0)
    expect(settings()?.unlockBlockedUntil).toBeNull()
  })

  it('rejects with throttled while the unlock block is active', async () => {
    await createVault(PW)
    mockStore.set(META_SETTINGS_KEY, {
      failedUnlockAttempts: 5,
      unlockBlockedUntil: new Date(Date.now() + 60_000).toISOString(),
    })

    expect(await codeOf(verifyPassword(PW))).toBe('throttled')
  })
})
