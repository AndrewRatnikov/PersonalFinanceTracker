// No CONTRACT_GAPs: vault.ts exports, storage layout and error codes are fully
// specified in the Interface Contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MetaSettings, VaultHeaderV2 } from '@/lib/vault'
import {
  base64ToBytes,
  bytesToBase64,
  encodeRecoveryKey,
} from '@/lib/crypto'
import { addIncome, getAllIncome, getLocalDbKey } from '@/lib/localDb'
import {
  META_SETTINGS_KEY,
  META_VAULT_KEY,
  PBKDF2_ITERATIONS,
  VaultError,
  changePassword,
  createVault,
  getVaultState,
  lockVault,
  regenerateRecoveryKey,
  resetPasswordWithRecoveryKey,
  unlockDelayMs,
  unlockWithPassword,
  unlockWithRecoveryKey,
} from '@/lib/vault'

const { mockStore, setManyCalls } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  setManyCalls: [] as Array<Array<string>>,
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: (key: string, value: unknown) => {
    mockStore.set(key, value)
    return Promise.resolve()
  },
  setMany: (entries: Array<[string, unknown]>) => {
    setManyCalls.push(entries.map(([k]) => k))
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

const KEY_RE =
  /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}-[0-9A-HJKMNP-TV-Z]{2}$/
const PW = 'correct horse battery'
const WRONG = 'wrong password 123'

function header(): VaultHeaderV2 {
  return mockStore.get(META_VAULT_KEY) as VaultHeaderV2
}

function settings(): MetaSettings | undefined {
  return mockStore.get(META_SETTINGS_KEY) as MetaSettings | undefined
}

function rawSettings(): Record<string, unknown> | undefined {
  return mockStore.get(META_SETTINGS_KEY) as Record<string, unknown> | undefined
}

function randomRecoveryKey(): string {
  return encodeRecoveryKey(crypto.getRandomValues(new Uint8Array(20)))
}

function incomeBlob(): Array<number> {
  return Array.from(mockStore.get('income') as Uint8Array)
}

// Every stored value that is not a binary data blob, as one string.
function plainStoreText(): string {
  const parts: Array<string> = []
  for (const [key, value] of mockStore) {
    if (value instanceof Uint8Array) continue
    parts.push(key, JSON.stringify(value))
  }
  return parts.join('\n')
}

beforeEach(() => {
  mockStore.clear()
  setManyCalls.length = 0
  localStorage.clear()
  lockVault()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('unlockDelayMs', () => {
  it('is 0 below 5 failures', () => {
    for (const n of [0, 1, 2, 3, 4]) expect(unlockDelayMs(n)).toBe(0)
  })

  it('starts at 5 s on the 5th failure and doubles', () => {
    expect(unlockDelayMs(5)).toBe(5000)
    expect(unlockDelayMs(6)).toBe(10000)
    expect(unlockDelayMs(7)).toBe(20000)
    expect(unlockDelayMs(10)).toBe(160000)
  })

  it('is capped at 5 minutes', () => {
    expect(unlockDelayMs(11)).toBe(300000)
    expect(unlockDelayMs(50)).toBe(300000)
  })
})

describe('getVaultState', () => {
  it("is 'none' for an empty store", async () => {
    expect(await getVaultState()).toBe('none')
  })

  it("is 'v1' when only a v1 verifier is in localStorage", async () => {
    localStorage.setItem('minima_key_verify_u1', 'abcd')
    expect(await getVaultState()).toBe('v1')
  })

  it("is 'v2' after createVault", async () => {
    await createVault(PW)
    expect(await getVaultState()).toBe('v2')
  })

  it("is 'v2' when meta:vault exists even if stale v1 keys remain", async () => {
    await createVault(PW)
    localStorage.setItem('minima_key_verify_u1', 'abcd')
    expect(await getVaultState()).toBe('v2')
  })

  it("is 'orphaned' when data keys exist without a header or v1 verifier", async () => {
    mockStore.set('income', new Uint8Array([1, 2, 3]))
    expect(await getVaultState()).toBe('orphaned')
  })

  it("is 'orphaned' for an expenses chunk key too", async () => {
    mockStore.set('expenses_2026_03', new Uint8Array([1, 2, 3]))
    expect(await getVaultState()).toBe('orphaned')
  })

  it("is 'none' when the store only holds quarantine copies", async () => {
    mockStore.set('quarantine:income:2026-01-01T00:00:00.000Z', new Uint8Array(3))
    expect(await getVaultState()).toBe('none')
  })

  it("prefers 'v1' over 'orphaned' when a v1 verifier and data keys both exist", async () => {
    localStorage.setItem('minima_key_verify_u1', 'abcd')
    mockStore.set('income', new Uint8Array([1, 2, 3]))
    expect(await getVaultState()).toBe('v1')
  })
})

describe('createVault', () => {
  it('returns a formatted recovery key', async () => {
    const { recoveryKey } = await createVault(PW)
    expect(recoveryKey).toMatch(KEY_RE)
  })

  it('returns a different recovery key for each vault', async () => {
    const a = await createVault(PW)
    mockStore.clear()
    lockVault()
    const b = await createVault(PW)
    expect(a.recoveryKey).not.toBe(b.recoveryKey)
  })

  it('stores a VaultHeaderV2 with 600k PBKDF2 iterations and a 16-byte salt', async () => {
    await createVault(PW)
    const h = header()
    expect(PBKDF2_ITERATIONS).toBe(600000)
    expect(h.v).toBe(2)
    expect(typeof h.vaultId).toBe('string')
    expect(h.vaultId.length).toBeGreaterThan(0)
    expect(Number.isNaN(Date.parse(h.createdAt))).toBe(false)
    expect(h.kdf.alg).toBe('PBKDF2-SHA256')
    expect(h.kdf.iterations).toBe(600000)
    expect(base64ToBytes(h.kdf.salt)).toHaveLength(16)
    expect(base64ToBytes(h.wrappedByPassword.iv)).toHaveLength(12)
    expect(base64ToBytes(h.recovery.salt)).toHaveLength(16)
    expect(base64ToBytes(h.recovery.iv)).toHaveLength(12)
    expect(base64ToBytes(h.verifier.iv)).toHaveLength(12)
    // Raw 32-byte DEK + 16-byte GCM tag.
    expect(base64ToBytes(h.wrappedByPassword.ct)).toHaveLength(48)
    expect(base64ToBytes(h.recovery.ct)).toHaveLength(48)
  })

  it('does not store the password or the raw recovery key in the header', async () => {
    const { recoveryKey } = await createVault(PW)
    const json = JSON.stringify(header())
    expect(json).not.toContain(PW)
    expect(json).not.toContain(recoveryKey)
  })

  it('keeps the header and settings out of localStorage and does not need a userId', async () => {
    await createVault(PW)
    expect(localStorage.length).toBe(0)
    expect(mockStore.has(META_VAULT_KEY)).toBe(true)
  })

  it('unlocks the data layer with a non-extractable DEK', async () => {
    await createVault(PW)
    const key = getLocalDbKey()
    if (!key) throw new Error('expected an unlocked key')
    expect(key.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })

  it('uses a fresh salt per vault', async () => {
    await createVault(PW)
    const saltA = header().kdf.salt
    mockStore.clear()
    lockVault()
    await createVault(PW)
    expect(header().kdf.salt).not.toBe(saltA)
  })

  it("rejects with 'invalid-state' when a vault already exists", async () => {
    await createVault(PW)
    const before = JSON.stringify(header())
    await expect(createVault('another password')).rejects.toMatchObject({
      code: 'invalid-state',
    })
    expect(JSON.stringify(header())).toBe(before)
  })

  it("never creates over orphaned data", async () => {
    mockStore.set('income', new Uint8Array([1, 2, 3]))
    await expect(createVault(PW)).rejects.toMatchObject({
      code: 'invalid-state',
    })
    expect(mockStore.has(META_VAULT_KEY)).toBe(false)
  })

  it('never creates over v1 data', async () => {
    localStorage.setItem('minima_key_verify_u1', 'abcd')
    await expect(createVault(PW)).rejects.toMatchObject({
      code: 'invalid-state',
    })
    expect(mockStore.has(META_VAULT_KEY)).toBe(false)
  })
})

describe('recoveryKeyConfirmed flag', () => {
  it('createVault stores recoveryKeyConfirmed: false in meta:settings', async () => {
    await createVault(PW)

    expect(rawSettings()?.recoveryKeyConfirmed).toBe(false)
  })

  it('createVault writes the header and the flag in one setMany', async () => {
    await createVault(PW)

    const together = setManyCalls.filter(
      (keys) =>
        keys.includes(META_VAULT_KEY) && keys.includes(META_SETTINGS_KEY),
    )
    expect(together).toHaveLength(1)
    // The header is never written without the flag.
    expect(
      setManyCalls.filter(
        (keys) =>
          keys.includes(META_VAULT_KEY) && !keys.includes(META_SETTINGS_KEY),
      ),
    ).toHaveLength(0)
  })

  it('createVault keeps the existing settings fields', async () => {
    mockStore.set(META_SETTINGS_KEY, {
      autoLockMinutes: 5,
      installHintDismissed: true,
    })

    await createVault(PW)

    expect(rawSettings()).toEqual({
      autoLockMinutes: 5,
      installHintDismissed: true,
      recoveryKeyConfirmed: false,
    })
  })

  it('unlocking later keeps the flag as it was (false stays false, true stays true)', async () => {
    await createVault(PW)
    lockVault()
    await unlockWithPassword(PW)
    expect(rawSettings()?.recoveryKeyConfirmed).toBe(false)

    mockStore.set(META_SETTINGS_KEY, {
      ...rawSettings(),
      recoveryKeyConfirmed: true,
    })
    lockVault()
    await unlockWithPassword(PW)
    expect(rawSettings()?.recoveryKeyConfirmed).toBe(true)
  })

  it('regenerateRecoveryKey sets the flag back to false, in the same setMany as the new header', async () => {
    await createVault(PW)
    mockStore.set(META_SETTINGS_KEY, {
      ...rawSettings(),
      autoLockMinutes: 5,
      recoveryKeyConfirmed: true,
    })
    setManyCalls.length = 0

    await regenerateRecoveryKey(PW)

    expect(rawSettings()?.recoveryKeyConfirmed).toBe(false)
    expect(rawSettings()?.autoLockMinutes).toBe(5)
    expect(
      setManyCalls.filter(
        (keys) =>
          keys.includes(META_VAULT_KEY) && keys.includes(META_SETTINGS_KEY),
      ),
    ).toHaveLength(1)
    expect(
      setManyCalls.filter(
        (keys) =>
          keys.includes(META_VAULT_KEY) && !keys.includes(META_SETTINGS_KEY),
      ),
    ).toHaveLength(0)
  })

  it('a failed regenerateRecoveryKey (wrong password) leaves the flag alone', async () => {
    await createVault(PW)
    mockStore.set(META_SETTINGS_KEY, {
      ...rawSettings(),
      recoveryKeyConfirmed: true,
    })

    await expect(regenerateRecoveryKey(WRONG)).rejects.toMatchObject({
      code: 'incorrect-password',
    })

    expect(rawSettings()?.recoveryKeyConfirmed).toBe(true)
  })

  it('changePassword does not touch the flag', async () => {
    await createVault(PW)
    mockStore.set(META_SETTINGS_KEY, {
      ...rawSettings(),
      recoveryKeyConfirmed: true,
    })

    await changePassword(PW, 'second password!')

    expect(rawSettings()?.recoveryKeyConfirmed).toBe(true)
  })

  it('no stored non-binary value contains the recovery key, with or without dashes, or any of its groups', async () => {
    const { recoveryKey } = await createVault(PW)

    const text = plainStoreText()
    expect(text).not.toContain(recoveryKey)
    expect(text).not.toContain(recoveryKey.replace(/-/g, ''))
    for (const group of recoveryKey.split('-').slice(0, 6)) {
      expect(text).not.toContain(group)
    }
  })

  it('regenerateRecoveryKey does not store the new key either', async () => {
    await createVault(PW)

    const { recoveryKey } = await regenerateRecoveryKey(PW)

    const text = plainStoreText()
    expect(text).not.toContain(recoveryKey)
    expect(text).not.toContain(recoveryKey.replace(/-/g, ''))
    for (const group of recoveryKey.split('-').slice(0, 6)) {
      expect(text).not.toContain(group)
    }
  })
})

describe('create, reload, unlock', () => {
  it('unlocks with the same password after a simulated reload', async () => {
    await createVault(PW)
    lockVault()
    expect(getLocalDbKey()).toBeNull()

    const result = await unlockWithPassword(PW)

    expect(result).toEqual({ recoveryKey: null })
    const key = getLocalDbKey()
    if (!key) throw new Error('expected an unlocked key')
    expect(key.extractable).toBe(false)
  })

  it('decrypts data written before the reload', async () => {
    await createVault(PW)
    await addIncome({ source: 'Job', amount: 100, currency: 'USD' })
    lockVault()
    await unlockWithPassword(PW)

    const income = await getAllIncome()

    expect(income).toHaveLength(1)
    expect(income[0].source).toBe('Job')
    expect(income[0].amount).toBe(100)
  })

  it("rejects a wrong password with 'Incorrect password' and stays locked", async () => {
    await createVault(PW)
    lockVault()

    const err = await unlockWithPassword(WRONG).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(VaultError)
    expect(err).toMatchObject({
      code: 'incorrect-password',
      message: 'Incorrect password',
      name: 'VaultError',
    })
    expect(getLocalDbKey()).toBeNull()
  })

  it("rejects with 'invalid-state' when no vault exists", async () => {
    await expect(unlockWithPassword(PW)).rejects.toMatchObject({
      code: 'invalid-state',
    })
  })
})

describe('brute-force protection', () => {
  const T0 = new Date('2026-05-01T12:00:00.000Z')

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    await createVault(PW)
    lockVault()
  })

  async function fail(times: number) {
    for (let i = 0; i < times; i++) {
      await expect(unlockWithPassword(WRONG)).rejects.toMatchObject({
        code: 'incorrect-password',
      })
    }
  }

  it('does not delay the first 4 failures and counts them in meta:settings', async () => {
    await fail(4)
    expect(settings()).toEqual({
      recoveryKeyConfirmed: false,
      failedUnlockAttempts: 4,
      unlockBlockedUntil: null,
    })
    // Still allowed to try the right password.
    await expect(unlockWithPassword(PW)).resolves.toEqual({ recoveryKey: null })
  })

  it('blocks for 5 s after the 5th failure and persists it', async () => {
    await fail(5)

    const s = settings()
    expect(s?.failedUnlockAttempts).toBe(5)
    expect(Date.parse(s?.unlockBlockedUntil ?? '') - Date.now()).toBe(5000)

    // Even the correct password is rejected while blocked.
    const err = await unlockWithPassword(PW).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VaultError)
    expect(err).toMatchObject({ code: 'throttled', retryAfterMs: 5000 })
    expect((err as Error).message.startsWith('Too many attempts')).toBe(true)
    expect(getLocalDbKey()).toBeNull()
  })

  it('does not count throttled attempts', async () => {
    await fail(5)
    await expect(unlockWithPassword(WRONG)).rejects.toMatchObject({
      code: 'throttled',
    })
    expect(settings()?.failedUnlockAttempts).toBe(5)
  })

  it('reports the remaining time as time passes', async () => {
    await fail(5)
    vi.setSystemTime(new Date(T0.getTime() + 2000))
    await expect(unlockWithPassword(PW)).rejects.toMatchObject({
      code: 'throttled',
      retryAfterMs: 3000,
    })
  })

  it('doubles the delay on the 6th failure', async () => {
    await fail(5)
    vi.setSystemTime(new Date(T0.getTime() + 5001))

    await fail(1)

    const s = settings()
    expect(s?.failedUnlockAttempts).toBe(6)
    expect(Date.parse(s?.unlockBlockedUntil ?? '') - Date.now()).toBe(10000)
  })

  it('unlocks again after the delay and resets the counter and delay', async () => {
    await fail(5)
    vi.setSystemTime(new Date(T0.getTime() + 5001))

    await expect(unlockWithPassword(PW)).resolves.toEqual({ recoveryKey: null })

    expect(settings()).toEqual({
      recoveryKeyConfirmed: false,
      failedUnlockAttempts: 0,
      unlockBlockedUntil: null,
    })
  })

  it('resets a partial failure count on success', async () => {
    await fail(3)
    await unlockWithPassword(PW)
    expect(settings()).toEqual({
      recoveryKeyConfirmed: false,
      failedUnlockAttempts: 0,
      unlockBlockedUntil: null,
    })
    lockVault()
    // A fresh run of 4 failures is again undelayed.
    await fail(4)
    expect(settings()?.unlockBlockedUntil).toBeNull()
  })

  it('shares the counter between wrong passwords and wrong recovery keys', async () => {
    await fail(3)
    for (let i = 0; i < 2; i++) {
      await expect(
        unlockWithRecoveryKey(randomRecoveryKey()),
      ).rejects.toMatchObject({ code: 'incorrect-recovery-key' })
    }

    expect(settings()?.failedUnlockAttempts).toBe(5)
    // The wrong-attempt delay now also blocks the password path.
    await expect(unlockWithPassword(PW)).rejects.toMatchObject({
      code: 'throttled',
    })
  })

  it('throttles a correct recovery key while blocked', async () => {
    // Recover the real key by recreating state: create anew to know the key.
    mockStore.clear()
    lockVault()
    const { recoveryKey } = await createVault(PW)
    lockVault()
    await fail(5)

    await expect(unlockWithRecoveryKey(recoveryKey)).rejects.toMatchObject({
      code: 'throttled',
    })
    expect(getLocalDbKey()).toBeNull()
  })

  it('keeps the block across a simulated reload (state lives in the store)', async () => {
    await fail(5)
    lockVault()
    await expect(unlockWithPassword(PW)).rejects.toMatchObject({
      code: 'throttled',
    })
  })
})

describe('recovery key', () => {
  it('unlocks with the exact recovery key', async () => {
    const { recoveryKey } = await createVault(PW)
    lockVault()

    await unlockWithRecoveryKey(recoveryKey)

    const key = getLocalDbKey()
    if (!key) throw new Error('expected an unlocked key')
    expect(key.extractable).toBe(false)
  })

  it('unlocks with a lowercased, space- and dash-mangled recovery key', async () => {
    const { recoveryKey } = await createVault(PW)
    lockVault()
    const mangled = ' ' + recoveryKey.toLowerCase().replace(/-/g, '  ') + ' '

    await unlockWithRecoveryKey(mangled)

    expect(getLocalDbKey()).not.toBeNull()
  })

  it('can read data written under the password after unlocking with the recovery key', async () => {
    const { recoveryKey } = await createVault(PW)
    await addIncome({ source: 'Gift', amount: 7, currency: 'EUR' })
    lockVault()

    await unlockWithRecoveryKey(recoveryKey)

    expect((await getAllIncome()).map((i) => i.source)).toEqual(['Gift'])
  })

  it("rejects a well-formed but wrong recovery key with the right message", async () => {
    await createVault(PW)
    lockVault()

    const err = await unlockWithRecoveryKey(randomRecoveryKey()).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(VaultError)
    expect(err).toMatchObject({
      code: 'incorrect-recovery-key',
      message: "This recovery key doesn't match",
    })
    expect(getLocalDbKey()).toBeNull()
  })

  it('rejects malformed recovery keys the same way', async () => {
    await createVault(PW)
    lockVault()
    for (const bad of ['', 'not a key', '12345']) {
      await expect(unlockWithRecoveryKey(bad)).rejects.toMatchObject({
        code: 'incorrect-recovery-key',
      })
    }
  })

  it("rejects with 'invalid-state' when no vault exists", async () => {
    await expect(unlockWithRecoveryKey(randomRecoveryKey())).rejects.toMatchObject(
      { code: 'invalid-state' },
    )
  })
})

describe('resetPasswordWithRecoveryKey', () => {
  it('sets a new password: the old one fails, the new one works', async () => {
    const { recoveryKey } = await createVault(PW)
    lockVault()

    await resetPasswordWithRecoveryKey(recoveryKey, 'brand new password')

    expect(getLocalDbKey()).not.toBeNull()
    lockVault()
    await expect(unlockWithPassword(PW)).rejects.toMatchObject({
      code: 'incorrect-password',
    })
    await expect(unlockWithPassword('brand new password')).resolves.toEqual({
      recoveryKey: null,
    })
  })

  it('keeps the recovery key valid and unchanged, and does not re-encrypt data', async () => {
    const { recoveryKey } = await createVault(PW)
    await addIncome({ source: 'Job', amount: 1, currency: 'USD' })
    const blobBefore = incomeBlob()
    const before = header()
    lockVault()

    await resetPasswordWithRecoveryKey(recoveryKey, 'brand new password')

    const after = header()
    expect(incomeBlob()).toEqual(blobBefore)
    expect(after.recovery).toEqual(before.recovery)
    expect(after.verifier).toEqual(before.verifier)
    expect(after.kdf.salt).not.toBe(before.kdf.salt)
    expect(after.kdf.iterations).toBe(600000)
    expect(after.wrappedByPassword.ct).not.toBe(before.wrappedByPassword.ct)
    lockVault()
    await unlockWithRecoveryKey(recoveryKey)
    expect(await getAllIncome()).toHaveLength(1)
  })

  it('rejects a wrong recovery key and leaves the password unchanged', async () => {
    await createVault(PW)
    lockVault()

    await expect(
      resetPasswordWithRecoveryKey(randomRecoveryKey(), 'brand new password'),
    ).rejects.toMatchObject({ code: 'incorrect-recovery-key' })

    await expect(unlockWithPassword(PW)).resolves.toEqual({ recoveryKey: null })
  })
})

describe('changePassword', () => {
  it('rotates the password: the old one fails, the new one works', async () => {
    await createVault(PW)

    await changePassword(PW, 'second password!')

    lockVault()
    await expect(unlockWithPassword(PW)).rejects.toMatchObject({
      code: 'incorrect-password',
    })
    await expect(unlockWithPassword('second password!')).resolves.toEqual({
      recoveryKey: null,
    })
  })

  it('leaves data blobs byte-identical and the recovery key working', async () => {
    const { recoveryKey } = await createVault(PW)
    await addIncome({ source: 'Job', amount: 5, currency: 'USD' })
    const blobBefore = incomeBlob()
    const before = header()

    await changePassword(PW, 'second password!')

    expect(incomeBlob()).toEqual(blobBefore)
    const after = header()
    expect(after.recovery).toEqual(before.recovery)
    expect(after.kdf.salt).not.toBe(before.kdf.salt)
    expect(base64ToBytes(after.kdf.salt)).toHaveLength(16)
    lockVault()
    await unlockWithRecoveryKey(recoveryKey)
    expect(await getAllIncome()).toHaveLength(1)
  })

  it('does not change the unlock state', async () => {
    await createVault(PW)
    const keyBefore = getLocalDbKey()
    await changePassword(PW, 'second password!')
    expect(getLocalDbKey()).toBe(keyBefore)
  })

  it('rejects a wrong current password and changes nothing', async () => {
    await createVault(PW)
    const before = JSON.stringify(header())

    await expect(changePassword(WRONG, 'second password!')).rejects.toMatchObject(
      { code: 'incorrect-password', message: 'Incorrect password' },
    )

    expect(JSON.stringify(header())).toBe(before)
    lockVault()
    await expect(unlockWithPassword(PW)).resolves.toEqual({ recoveryKey: null })
  })
})

describe('regenerateRecoveryKey', () => {
  it('returns a new formatted key; the old one fails and the new one works', async () => {
    const { recoveryKey: oldKey } = await createVault(PW)

    const { recoveryKey: newKey } = await regenerateRecoveryKey(PW)

    expect(newKey).toMatch(KEY_RE)
    expect(newKey).not.toBe(oldKey)
    lockVault()
    await expect(unlockWithRecoveryKey(oldKey)).rejects.toMatchObject({
      code: 'incorrect-recovery-key',
    })
    await unlockWithRecoveryKey(newKey)
    expect(getLocalDbKey()).not.toBeNull()
  })

  it('uses a new recovery salt and keeps the password and data intact', async () => {
    await createVault(PW)
    await addIncome({ source: 'Job', amount: 5, currency: 'USD' })
    const blobBefore = incomeBlob()
    const before = header()

    await regenerateRecoveryKey(PW)

    const after = header()
    expect(after.recovery.salt).not.toBe(before.recovery.salt)
    expect(base64ToBytes(after.recovery.salt)).toHaveLength(16)
    expect(after.wrappedByPassword).toEqual(before.wrappedByPassword)
    expect(incomeBlob()).toEqual(blobBefore)
    lockVault()
    await expect(unlockWithPassword(PW)).resolves.toEqual({ recoveryKey: null })
  })

  it('rejects a wrong password and keeps the old recovery key valid', async () => {
    const { recoveryKey } = await createVault(PW)

    await expect(regenerateRecoveryKey(WRONG)).rejects.toMatchObject({
      code: 'incorrect-password',
    })

    lockVault()
    await unlockWithRecoveryKey(recoveryKey)
    expect(getLocalDbKey()).not.toBeNull()
  })
})

describe('Vault damaged', () => {
  function corruptVerifier() {
    const h = header()
    const n = base64ToBytes(h.verifier.ct).length
    mockStore.set(META_VAULT_KEY, {
      ...h,
      verifier: {
        ...h.verifier,
        ct: bytesToBase64(crypto.getRandomValues(new Uint8Array(n))),
      },
    })
  }

  it("raises a distinct 'damaged' error when the DEK unwraps but the verifier fails", async () => {
    await createVault(PW)
    lockVault()
    corruptVerifier()

    const err = await unlockWithPassword(PW).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(VaultError)
    expect(err).toMatchObject({
      code: 'damaged',
      message: 'Vault damaged',
    })
    expect(getLocalDbKey()).toBeNull()
  })

  it('does not count a damaged vault as a failed attempt', async () => {
    await createVault(PW)
    lockVault()
    corruptVerifier()

    await expect(unlockWithPassword(PW)).rejects.toMatchObject({
      code: 'damaged',
    })

    expect(settings()?.failedUnlockAttempts ?? 0).toBe(0)
  })

  it('is distinct from a wrong password on the same corrupted vault', async () => {
    await createVault(PW)
    lockVault()
    corruptVerifier()

    await expect(unlockWithPassword(WRONG)).rejects.toMatchObject({
      code: 'incorrect-password',
    })
  })
})
