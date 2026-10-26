// No CONTRACT_GAPs: adoptCloudVault, joinCloudVault, adoptHeaderIfSameDek,
// headerMatchesDek and subscribeHeaderChanges are specified in plan section 4
// and the Interface Contract (module: vault additions).
//
// Integration style as vault.syncKeys.test.ts: real crypto, real vault and
// localDb, idb-keyval backed by a Map with a switch that makes setMany reject.
// "The cloud" is a header (and a record key) captured from a second vault that
// was created in a clean store and then wiped.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncChannel } from '@/lib/syncChannel'
import type { VaultHeaderV2 } from '@/lib/vault'
import { recordKeyFor } from '@/lib/cloud/recordCrypto'
import {
  SYNC_META_KEY,
  addExpense,
  deleteExpense,
  getAllExpenses,
  getLocalDbKey,
  listChangedRecords,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'
import {
  META_SETTINGS_KEY,
  META_VAULT_KEY,
  adoptCloudVault,
  adoptHeaderIfSameDek,
  changePassword,
  createVault,
  getSyncKeys,
  getVaultHeader,
  getVaultState,
  headerMatchesDek,
  joinCloudVault,
  lockVault,
  regenerateRecoveryKey,
  resetPasswordWithRecoveryKey,
  subscribeHeaderChanges,
  unlockWithPassword,
} from '@/lib/vault'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: { failSetMany: false },
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: (key: string, value: unknown) => {
    mockStore.set(key, value)
    return Promise.resolve()
  },
  setMany: (entries: Array<[string, unknown]>) => {
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

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

const CLOUD_PW = 'cloud password 1'
const LOCAL_PW = 'local password 2'
const NEW_PW = 'brand new password 3'
const PROBE = { type: 'expense', id: 'probe' } as const

interface Cloud {
  header: VaultHeaderV2
  recoveryKey: string
  probeKey: string
}

function wipeDevice() {
  lockVault()
  mockStore.clear()
  localStorage.clear()
}

// A vault that exists only as a header (what the server would hold).
async function makeCloud(): Promise<Cloud> {
  wipeDevice()
  const { recoveryKey } = await createVault(CLOUD_PW)
  const header = await getVaultHeader()
  const probeKey = await recordKeyFor(await getSyncKeys(), PROBE.type, PROBE.id)
  wipeDevice()
  return { header, recoveryKey, probeKey }
}

function dump(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of mockStore) {
    out[k] = v instanceof Uint8Array ? Array.from(v) : JSON.parse(JSON.stringify(v))
  }
  return out
}

function raw(key: string): Record<string, unknown> {
  return mockStore.get(key) as Record<string, unknown>
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  return (err as { code?: string } | null)?.code
}

function fakeChannel() {
  return {
    postMessage: vi.fn<SyncChannel['postMessage']>(),
    addEventListener: vi.fn<SyncChannel['addEventListener']>(),
    removeEventListener: vi.fn<SyncChannel['removeEventListener']>(),
    close: vi.fn<SyncChannel['close']>(),
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-24T09:00:00.000Z'))
  wipeDevice()
  ctl.failSetMany = false
  setSyncChannel(null)
})

// Header listeners live in the module, so every test removes the ones it added.
const unsubscribers: Array<() => void> = []

function listen(listener: () => void): () => void {
  const off = subscribeHeaderChanges(listener)
  unsubscribers.push(off)
  return off
}

afterEach(() => {
  for (const off of unsubscribers.splice(0)) off()
  vi.useRealTimers()
  vi.restoreAllMocks()
  setSyncChannel(undefined)
  wipeDevice()
})

describe('adoptCloudVault on a fresh device', () => {
  it('adopts the cloud header with the password, unlocks and uses the same DEK', async () => {
    const cloud = await makeCloud()
    expect(await getVaultState()).toBe('none')

    const result = await adoptCloudVault(cloud.header, { password: CLOUD_PW })

    expect(result.headerChanged).toBe(false)
    expect(result.header).toEqual(cloud.header)
    expect(await getVaultState()).toBe('v2')
    expect(getLocalDbKey()).not.toBeNull()
    expect(raw(META_VAULT_KEY)).toEqual(cloud.header)
    expect(await recordKeyFor(await getSyncKeys(), PROBE.type, PROBE.id)).toBe(cloud.probeKey)
  })

  it('does not mark the recovery key as unconfirmed and still unlocks later', async () => {
    const cloud = await makeCloud()
    await adoptCloudVault(cloud.header, { password: CLOUD_PW })

    expect('recoveryKeyConfirmed' in (raw(META_SETTINGS_KEY) ?? {})).toBe(false)
    lockVault()
    expect(getLocalDbKey()).toBeNull()
    await unlockWithPassword(CLOUD_PW)
    expect(getLocalDbKey()).not.toBeNull()
  })

  it('a wrong password is refused with the unlock error, writes no vault and counts the failure', async () => {
    const cloud = await makeCloud()

    expect(await codeOf(adoptCloudVault(cloud.header, { password: 'wrong password' }))).toBe(
      'incorrect-password',
    )

    expect(mockStore.has(META_VAULT_KEY)).toBe(false)
    expect(getLocalDbKey()).toBeNull()
    expect(await getVaultState()).toBe('none')
    expect(raw(META_SETTINGS_KEY).failedUnlockAttempts).toBe(1)
  })

  it('after five wrong passwords even the right one waits (same delay as unlock)', async () => {
    const cloud = await makeCloud()
    for (let i = 0; i < 5; i++) {
      expect(await codeOf(adoptCloudVault(cloud.header, { password: `wrong ${i}` }))).toBe(
        'incorrect-password',
      )
    }
    const err = await adoptCloudVault(cloud.header, { password: CLOUD_PW }).then(
      () => null,
      (e: unknown) => e as { code: string; retryAfterMs: number },
    )
    expect(err?.code).toBe('throttled')
    expect(err?.retryAfterMs).toBeGreaterThan(0)
    expect(mockStore.has(META_VAULT_KEY)).toBe(false)

    vi.setSystemTime(new Date('2026-10-24T09:10:00.000Z'))
    await adoptCloudVault(cloud.header, { password: CLOUD_PW })
    expect(await getVaultState()).toBe('v2')
  })

  it('a recovery key plus a new password re-wraps the DEK and reports the changed header', async () => {
    const cloud = await makeCloud()
    const result = await adoptCloudVault(cloud.header, {
      recoveryKey: cloud.recoveryKey,
      newPassword: NEW_PW,
    })

    expect(result.headerChanged).toBe(true)
    expect(result.header.vaultId).toBe(cloud.header.vaultId)
    expect(result.header.wrappedByPassword).not.toEqual(cloud.header.wrappedByPassword)
    expect(result.header.kdf.salt).not.toBe(cloud.header.kdf.salt)
    expect(result.header.verifier).toEqual(cloud.header.verifier)
    expect(await getVaultHeader()).toEqual(result.header)
    expect(await recordKeyFor(await getSyncKeys(), PROBE.type, PROBE.id)).toBe(cloud.probeKey)

    lockVault()
    expect(await codeOf(unlockWithPassword(CLOUD_PW))).toBe('incorrect-password')
    await unlockWithPassword(NEW_PW)
    expect(getLocalDbKey()).not.toBeNull()
  })

  it('a wrong recovery key is refused and nothing is written', async () => {
    const cloud = await makeCloud()
    expect(
      await codeOf(
        adoptCloudVault(cloud.header, {
          recoveryKey: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GG',
          newPassword: NEW_PW,
        }),
      ),
    ).toBe('incorrect-recovery-key')
    expect(mockStore.has(META_VAULT_KEY)).toBe(false)
    expect(getLocalDbKey()).toBeNull()
  })

  it('refuses a device that already has a vault and changes nothing', async () => {
    const cloud = await makeCloud()
    await createVault(LOCAL_PW)
    const before = dump()

    expect(await codeOf(adoptCloudVault(cloud.header, { password: CLOUD_PW }))).toBe('invalid-state')
    expect(dump()).toEqual(before)
  })

  it('emits no header-change event', async () => {
    const cloud = await makeCloud()
    const listener = vi.fn()
    listen(listener)
    await adoptCloudVault(cloud.header, { password: CLOUD_PW })
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('subscribeHeaderChanges', () => {
  it('fires after changePassword, regenerateRecoveryKey and resetPasswordWithRecoveryKey', async () => {
    const { recoveryKey } = await createVault(LOCAL_PW)
    const listener = vi.fn()
    const off = listen(listener)

    await changePassword(LOCAL_PW, NEW_PW)
    expect(listener).toHaveBeenCalledTimes(1)

    const next = await regenerateRecoveryKey(NEW_PW)
    expect(listener).toHaveBeenCalledTimes(2)

    lockVault()
    await resetPasswordWithRecoveryKey(next.recoveryKey, 'another new password')
    expect(listener).toHaveBeenCalledTimes(3)
    expect(recoveryKey).not.toBe(next.recoveryKey)

    off()
    await changePassword('another new password', LOCAL_PW)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('does not fire when the change fails', async () => {
    await createVault(LOCAL_PW)
    const listener = vi.fn()
    listen(listener)

    expect(await codeOf(changePassword('not the password', NEW_PW))).toBe('incorrect-password')
    expect(await codeOf(regenerateRecoveryKey('not the password'))).toBe('incorrect-password')
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not fire for create or unlock', async () => {
    const listener = vi.fn()
    listen(listener)
    await createVault(LOCAL_PW)
    lockVault()
    await unlockWithPassword(LOCAL_PW)
    expect(listener).not.toHaveBeenCalled()
  })

  it('a throwing listener is logged by name and never fails the change', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await createVault(LOCAL_PW)
    const good = vi.fn()
    listen(() => {
      throw new TypeError('private detail 987')
    })
    listen(good)

    await changePassword(LOCAL_PW, NEW_PW)

    expect(good).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalled()
    expect(JSON.stringify(error.mock.calls)).not.toContain('private detail')
  })
})

describe('adoptHeaderIfSameDek and headerMatchesDek', () => {
  // The device holds H1; the "cloud" has H2 (same DEK, new password).
  async function twoHeaders() {
    await createVault(LOCAL_PW)
    const h1 = await getVaultHeader()
    await changePassword(LOCAL_PW, NEW_PW)
    const h2 = await getVaultHeader()
    mockStore.set(META_VAULT_KEY, h1)
    return { h1, h2 }
  }

  it('adopts a header that wraps the same DEK; the next unlock needs the new password', async () => {
    const { h1, h2 } = await twoHeaders()
    expect(h1).not.toEqual(h2)

    expect(await adoptHeaderIfSameDek(h2)).toBe('adopted')

    expect(await getVaultHeader()).toEqual(h2)
    expect(getLocalDbKey()).not.toBeNull()
    lockVault()
    expect(await codeOf(unlockWithPassword(LOCAL_PW))).toBe('incorrect-password')
    await unlockWithPassword(NEW_PW)
    expect(getLocalDbKey()).not.toBeNull()
  })

  it('keeps the brute-force counters of meta:settings', async () => {
    const { h2 } = await twoHeaders()
    mockStore.set(META_SETTINGS_KEY, {
      ...raw(META_SETTINGS_KEY),
      failedUnlockAttempts: 2,
      unlockBlockedUntil: null,
    })
    await adoptHeaderIfSameDek(h2)
    expect(raw(META_SETTINGS_KEY).failedUnlockAttempts).toBe(2)
  })

  it('reports unchanged for the header it already has, without a write', async () => {
    await createVault(LOCAL_PW)
    const header = await getVaultHeader()
    const before = dump()
    expect(await adoptHeaderIfSameDek(header)).toBe('unchanged')
    expect(dump()).toEqual(before)
  })

  it('reports mismatch for another vault id', async () => {
    await createVault(LOCAL_PW)
    const header = await getVaultHeader()
    const before = dump()
    expect(await adoptHeaderIfSameDek({ ...header, vaultId: 'some-other-vault' })).toBe('mismatch')
    expect(dump()).toEqual(before)
  })

  it('reports mismatch for a header that wraps another DEK, and changes nothing', async () => {
    const cloud = await makeCloud()
    await createVault(LOCAL_PW)
    const local = await getVaultHeader()
    const before = dump()

    expect(await adoptHeaderIfSameDek({ ...cloud.header, vaultId: local.vaultId })).toBe('mismatch')
    expect(await getVaultHeader()).toEqual(local)
    expect(dump()).toEqual(before)
  })

  it('needs an unlocked vault', async () => {
    await createVault(LOCAL_PW)
    const header = await getVaultHeader()
    lockVault()
    expect(await codeOf(adoptHeaderIfSameDek(header))).toBe('invalid-state')
  })

  it('emits no header-change event', async () => {
    const { h2 } = await twoHeaders()
    const listener = vi.fn()
    listen(listener)
    await adoptHeaderIfSameDek(h2)
    expect(listener).not.toHaveBeenCalled()
  })

  it('headerMatchesDek is true for any header of this DEK and false for another', async () => {
    const cloud = await makeCloud()
    await createVault(LOCAL_PW)
    const h1 = await getVaultHeader()
    await changePassword(LOCAL_PW, NEW_PW)
    const h2 = await getVaultHeader()
    const before = dump()

    expect(await headerMatchesDek(h1)).toBe(true)
    expect(await headerMatchesDek(h2)).toBe(true)
    expect(await headerMatchesDek(cloud.header)).toBe(false)
    expect(dump()).toEqual(before)
  })
})

describe('joinCloudVault', () => {
  const SYNC_PATCH = {
    enabled: true,
    userId: 'user-1',
    vaultId: 'cloud-vault',
    deviceId: 'device-1',
    pullCursor: 0,
    headerRev: 3,
    lastSyncAt: null,
    lastError: null,
    headerPending: false,
  }

  async function localDeviceWithData(cloud: Cloud) {
    await createVault(LOCAL_PW)
    const keep = await addExpense({ amount: 100, currency: 'UAH', categoryId: 'c1', description: 'keep me' })
    const gone = await addExpense({ amount: 900, currency: 'UAH', categoryId: 'c1', description: 'deleted' })
    await deleteExpense(gone.id, gone.createdAt)
    return { keep, gone, cloud, localHeader: await getVaultHeader() }
  }

  it('moves this device to the cloud vault, keeps the live entries and unlocks with the cloud DEK', async () => {
    const cloud = await makeCloud()
    const { keep, gone } = await localDeviceWithData(cloud)
    const oldKey = getLocalDbKey()

    const result = await joinCloudVault(cloud.header, CLOUD_PW, SYNC_PATCH)

    expect(result.records).toBeGreaterThanOrEqual(1)
    expect(result.localRev - result.startRev).toBe(result.records)
    expect(getLocalDbKey()).not.toBeNull()
    expect(getLocalDbKey()).not.toBe(oldKey)
    expect(await getVaultHeader()).toEqual(cloud.header)
    expect(await recordKeyFor(await getSyncKeys(), PROBE.type, PROBE.id)).toBe(cloud.probeKey)

    const expenses = await getAllExpenses()
    expect(expenses.map((e) => e.id)).toEqual([keep.id])
    expect(expenses[0].description).toBe('keep me')
    expect(expenses[0].updatedAt).toBe(keep.updatedAt)
    const { records } = await listChangedRecords(-1)
    expect(records.some((r) => r.id === gone.id)).toBe(false)
  })

  it('stores the sync fields and a pushedRev that makes every re-inserted record go out', async () => {
    const cloud = await makeCloud()
    await localDeviceWithData(cloud)
    const result = await joinCloudVault(cloud.header, CLOUD_PW, SYNC_PATCH)

    const meta = raw(SYNC_META_KEY)
    expect(meta).toMatchObject(SYNC_PATCH)
    expect(meta.pushedRev).toBe(result.startRev)
    expect(meta.localRev).toBe(result.localRev)
    const pending = await listChangedRecords(meta.pushedRev as number)
    expect(pending.records.length).toBe(result.records)
  })

  it('afterwards only the cloud password unlocks', async () => {
    const cloud = await makeCloud()
    await localDeviceWithData(cloud)
    await joinCloudVault(cloud.header, CLOUD_PW, SYNC_PATCH)

    lockVault()
    expect(await codeOf(unlockWithPassword(LOCAL_PW))).toBe('incorrect-password')
    await unlockWithPassword(CLOUD_PW)
    expect((await getAllExpenses()).length).toBe(1)
  })

  it('does not keep the recovery-key reminder of the old vault', async () => {
    const cloud = await makeCloud()
    await localDeviceWithData(cloud)
    expect(raw(META_SETTINGS_KEY).recoveryKeyConfirmed).toBe(false)
    await joinCloudVault(cloud.header, CLOUD_PW, SYNC_PATCH)
    expect('recoveryKeyConfirmed' in raw(META_SETTINGS_KEY)).toBe(false)
  })

  it('tells the other tabs to lock', async () => {
    const cloud = await makeCloud()
    await localDeviceWithData(cloud)
    const channel = fakeChannel()
    setSyncChannel(channel)

    await joinCloudVault(cloud.header, CLOUD_PW, SYNC_PATCH)

    expect(channel.postMessage.mock.calls.map((c) => c[0].type)).toContain('lock')
  })

  it('a wrong cloud password leaves the old vault exactly as it was', async () => {
    const cloud = await makeCloud()
    const { keep, localHeader } = await localDeviceWithData(cloud)
    const oldKey = getLocalDbKey()
    const dataBefore = { ...dump() }
    delete dataBefore[META_SETTINGS_KEY]

    expect(await codeOf(joinCloudVault(cloud.header, 'wrong password', SYNC_PATCH))).toBe(
      'incorrect-password',
    )

    expect(getLocalDbKey()).toBe(oldKey)
    expect(await getVaultHeader()).toEqual(localHeader)
    const after = { ...dump() }
    delete after[META_SETTINGS_KEY]
    expect(after).toEqual(dataBefore)
    expect((await getAllExpenses()).map((e) => e.id)).toEqual([keep.id])
    lockVault()
    await unlockWithPassword(LOCAL_PW)
  })

  it('a failure injected before the commit leaves the old vault unlockable', async () => {
    const cloud = await makeCloud()
    const { keep, localHeader } = await localDeviceWithData(cloud)
    const oldKey = getLocalDbKey()
    const before = dump()
    ctl.failSetMany = true

    await expect(joinCloudVault(cloud.header, CLOUD_PW, SYNC_PATCH)).rejects.toThrow()

    ctl.failSetMany = false
    expect(getLocalDbKey()).toBe(oldKey)
    expect(await getVaultHeader()).toEqual(localHeader)
    const after = dump()
    expect(after[META_VAULT_KEY]).toEqual(before[META_VAULT_KEY])
    expect(after[SYNC_META_KEY]).toEqual(before[SYNC_META_KEY])
    lockVault()
    await unlockWithPassword(LOCAL_PW)
    expect((await getAllExpenses()).map((e) => e.id)).toEqual([keep.id])
  })

  it('counts wrong passwords like an unlock: the sixth attempt is throttled', async () => {
    const cloud = await makeCloud()
    await localDeviceWithData(cloud)
    for (let i = 0; i < 5; i++) {
      expect(await codeOf(joinCloudVault(cloud.header, `wrong ${i}`, SYNC_PATCH))).toBe(
        'incorrect-password',
      )
    }
    expect(await codeOf(joinCloudVault(cloud.header, CLOUD_PW, SYNC_PATCH))).toBe('throttled')
    expect(await getVaultHeader()).not.toEqual(cloud.header)
  })

  it('needs an unlocked device', async () => {
    const cloud = await makeCloud()
    await createVault(LOCAL_PW)
    lockVault()
    expect(await codeOf(joinCloudVault(cloud.header, CLOUD_PW, SYNC_PATCH))).toBe('invalid-state')
  })

  it('needs a device that already has a vault', async () => {
    const cloud = await makeCloud()
    expect(await codeOf(joinCloudVault(cloud.header, CLOUD_PW, SYNC_PATCH))).toBe('invalid-state')
  })
})
