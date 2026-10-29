// No CONTRACT_GAPs: "Remove data from this device" and lock must drop every
// space key, the identity and minima_active_space (criteria 17 and 27).
// localWipe.ts itself is unchanged; the real localDb runs over a Map-backed
// idb-keyval and the real wipeLocalData / lockVault are used.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createLocalSpace,
  ensureIdentityKeyPair,
  getLocalDbKey,
  listLocalSpaces,
  spaceDb,
  unlockLocalDb,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { wipeLocalData } from '@/lib/localWipe'
import {
  ACTIVE_SPACE_STORAGE_KEY,
  getActiveSpaceId,
  setActiveSpaceId,
} from '@/lib/spaces/activeSpace'
import {
  clearKeyring,
  heldSpaceIds,
  isKeyringLoaded,
  isSpaceHeld,
} from '@/lib/spaces/keyring'
import { isSpaceLockedError } from '@/lib/spaces/types'
import { setSyncChannel } from '@/lib/syncChannel'
import { lockVault } from '@/lib/vault'

const { mockStore } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  getMany: (list: Array<string>) => Promise.resolve(list.map((k) => mockStore.get(k))),
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
  delMany: (list: Array<string>) => {
    for (const key of list) mockStore.delete(key)
    return Promise.resolve()
  },
  clear: () => {
    mockStore.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(mockStore.keys())),
}))
vi.mock('@/lib/accountSession', () => ({
  getAccountSession: vi.fn().mockResolvedValue(null),
}))

function newKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

async function deviceWithSpace() {
  const dek = await newKey()
  unlockLocalDb(dek)
  const identity = await ensureIdentityKeyPair()
  const space = await createLocalSpace({ name: 'Home', lang: 'en' })
  const fam = spaceDb(space.id)
  const category = (await fam.getAllCategories())[0]
  await fam.addExpense({
    amount: 42,
    currency: 'UAH',
    categoryId: category.id,
    createdAt: '2026-05-15T12:00:00.000Z',
  })
  await listLocalSpaces()
  setActiveSpaceId(space.id)
  return { dek, identity, space }
}

beforeEach(() => {
  mockStore.clear()
  localStorage.clear()
  setSyncChannel(null)
  clearKeyring()
  vi.stubGlobal('indexedDB', { deleteDatabase: vi.fn() })
})

afterEach(() => {
  wipeLocalDbKey()
  setSyncChannel(undefined)
  vi.unstubAllGlobals()
})

describe('Remove data from this device', () => {
  it('has something to remove before the wipe (control)', async () => {
    const { space } = await deviceWithSpace()

    const keys = Array.from(mockStore.keys())
    expect(keys).toContain('identity')
    expect(keys).toContain('spaceKeys')
    expect(keys.some((k) => k.startsWith(`space:${space.id}:`))).toBe(true)
    expect(localStorage.getItem(ACTIVE_SPACE_STORAGE_KEY)).toBe(space.id)
    expect(isSpaceHeld(space.id)).toBe(true)
  })

  it('empties the store: no space:* key, no identity, no spaceKeys', async () => {
    await deviceWithSpace()

    await wipeLocalData()

    expect(mockStore.size).toBe(0)
    expect(Array.from(mockStore.keys()).filter((k) => k.startsWith('space:'))).toEqual([])
  })

  it('removes minima_active_space and leaves other keys alone', async () => {
    await deviceWithSpace()
    localStorage.setItem('other_key', 'keep')

    await wipeLocalData()

    expect(localStorage.getItem(ACTIVE_SPACE_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem('other_key')).toBe('keep')
    expect(getActiveSpaceId()).toBe('personal')
  })

  it('drops every in-memory space key together with the DEK', async () => {
    const { space } = await deviceWithSpace()
    expect(heldSpaceIds()).toEqual([space.id])

    await wipeLocalData()

    expect(getLocalDbKey()).toBeNull()
    expect(heldSpaceIds()).toEqual([])
    expect(isSpaceHeld(space.id)).toBe(false)
    expect(isKeyringLoaded()).toBe(false)
  })

  it('leaves no way to read the old space, even after unlocking a new vault', async () => {
    const { space } = await deviceWithSpace()

    await wipeLocalData()
    unlockLocalDb(await newKey())

    expect(await listLocalSpaces()).toEqual([])
    await expect(spaceDb(space.id).getAllExpenses()).rejects.toSatisfy(isSpaceLockedError)
  })

  it('drops the identity key: a new vault gets a different pair', async () => {
    const { identity } = await deviceWithSpace()

    await wipeLocalData()
    unlockLocalDb(await newKey())
    const fresh = await ensureIdentityKeyPair()

    expect(fresh.publicKeyJwk.x).not.toBe(identity.publicKeyJwk.x)
    expect(fresh.privateKeyJwk.d).not.toBe(identity.privateKeyJwk.d)
  })
})

describe('lock', () => {
  it('lockVault drops the space keys and the identity cannot be read', async () => {
    const { space } = await deviceWithSpace()

    lockVault()

    expect(getLocalDbKey()).toBeNull()
    expect(heldSpaceIds()).toEqual([])
    expect(isKeyringLoaded()).toBe(false)
    expect(await listLocalSpaces()).toEqual([])
    await expect(spaceDb(space.id).getAllExpenses()).rejects.toSatisfy(isSpaceLockedError)
    await expect(ensureIdentityKeyPair()).rejects.toThrow()
  })

  it('lock keeps the stored data and the stored active-space choice; unlock brings the space back', async () => {
    const { dek, space } = await deviceWithSpace()

    lockVault()
    expect(mockStore.has('spaceKeys')).toBe(true)
    expect(localStorage.getItem(ACTIVE_SPACE_STORAGE_KEY)).toBe(space.id)
    expect(getActiveSpaceId()).toBe('personal')

    unlockLocalDb(dek)
    expect(await listLocalSpaces()).toEqual([expect.objectContaining({ id: space.id })])
    expect(getActiveSpaceId()).toBe(space.id)
    expect((await spaceDb(space.id).getAllExpenses()).map((e) => e.amount)).toEqual([42])
  })
})
