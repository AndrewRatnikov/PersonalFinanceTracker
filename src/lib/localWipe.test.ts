// No CONTRACT_GAPs: localWipe exports and test notes are fully specified in the
// Interface Contract (module: localWipe).
//
// vi.stubGlobal is used for indexedDB and location below (not vi.mock( of the
// modules under test): every other collaborator is the real module over a
// Map-backed idb-keyval mock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncChannel } from '@/lib/syncChannel'
import { getLocalDbKey, unlockLocalDb } from '@/lib/localDb'
import {
  LOCAL_DB_NAME,
  LOCAL_STORAGE_PREFIX,
  reloadToHome,
  removeMinimaLocalStorageKeys,
  wipeLocalData,
} from '@/lib/localWipe'
import { setSyncChannel } from '@/lib/syncChannel'

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

function fakeChannel() {
  return {
    postMessage: vi.fn<SyncChannel['postMessage']>(),
    addEventListener: vi.fn<SyncChannel['addEventListener']>(),
    removeEventListener: vi.fn<SyncChannel['removeEventListener']>(),
    close: vi.fn<SyncChannel['close']>(),
  }
}

async function seedKey() {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  unlockLocalDb(key)
}

beforeEach(() => {
  mockStore.clear()
  localStorage.clear()
})

afterEach(() => {
  setSyncChannel(undefined)
  vi.unstubAllGlobals()
})

describe('constants', () => {
  it('names the database and the localStorage prefix', () => {
    expect(LOCAL_DB_NAME).toBe('minima-local')
    expect(LOCAL_STORAGE_PREFIX).toBe('minima_')
  })
})

describe('removeMinimaLocalStorageKeys', () => {
  it('removes every minima_ key and leaves other keys alone', () => {
    localStorage.setItem('minima_offline_user', '{"id":"u1"}')
    localStorage.setItem('minima_device_salt_u1', 'salt')
    localStorage.setItem('minima_', 'bare prefix')
    localStorage.setItem('other_key', 'keep')
    localStorage.setItem('minimal_theme', 'keep too')

    removeMinimaLocalStorageKeys()

    expect(localStorage.getItem('minima_offline_user')).toBeNull()
    expect(localStorage.getItem('minima_device_salt_u1')).toBeNull()
    expect(localStorage.getItem('minima_')).toBeNull()
    expect(localStorage.getItem('other_key')).toBe('keep')
    expect(localStorage.getItem('minimal_theme')).toBe('keep too')
  })

  it('does nothing when there are no minima_ keys', () => {
    localStorage.setItem('other_key', 'keep')

    removeMinimaLocalStorageKeys()

    expect(localStorage.length).toBe(1)
  })
})

describe('wipeLocalData', () => {
  it('empties the IndexedDB store, including the vault header and settings', async () => {
    mockStore.set('meta:vault', { v: 2 })
    mockStore.set('meta:settings', { autoLockMinutes: 5 })
    mockStore.set('income', new Uint8Array([1, 2, 3]))
    vi.stubGlobal('indexedDB', { deleteDatabase: vi.fn() })

    await wipeLocalData()

    expect(mockStore.size).toBe(0)
  })

  it('clears the in-memory key', async () => {
    await seedKey()
    expect(getLocalDbKey()).not.toBeNull()
    vi.stubGlobal('indexedDB', { deleteDatabase: vi.fn() })

    await wipeLocalData()

    expect(getLocalDbKey()).toBeNull()
  })

  it('removes minima_ keys and keeps other keys', async () => {
    localStorage.setItem('minima_offline_user', 'x')
    localStorage.setItem('minima_key_verify_u1', 'y')
    localStorage.setItem('other_key', 'keep')
    vi.stubGlobal('indexedDB', { deleteDatabase: vi.fn() })

    await wipeLocalData()

    expect(localStorage.getItem('minima_offline_user')).toBeNull()
    expect(localStorage.getItem('minima_key_verify_u1')).toBeNull()
    expect(localStorage.getItem('other_key')).toBe('keep')
  })

  it("broadcasts { type: 'wiped' } on the sync channel", async () => {
    const channel = fakeChannel()
    setSyncChannel(channel)
    vi.stubGlobal('indexedDB', { deleteDatabase: vi.fn() })

    await wipeLocalData()

    expect(channel.postMessage).toHaveBeenCalledWith({ type: 'wiped' })
    expect(channel.postMessage).toHaveBeenCalledTimes(1)
  })

  it("requests deletion of the 'minima-local' database after the store is already empty", async () => {
    mockStore.set('income', new Uint8Array([1]))
    let sizeAtDelete = -1
    const deleteDatabase = vi.fn(() => {
      sizeAtDelete = mockStore.size
    })
    vi.stubGlobal('indexedDB', { deleteDatabase })

    await wipeLocalData()

    expect(deleteDatabase).toHaveBeenCalledTimes(1)
    expect(deleteDatabase).toHaveBeenCalledWith('minima-local')
    expect(sizeAtDelete).toBe(0)
  })

  it('does not wait for the database deletion to finish', async () => {
    // A request object that never fires success/blocked: awaiting it would hang.
    const deleteDatabase = vi.fn(() => ({}))
    vi.stubGlobal('indexedDB', { deleteDatabase })

    await expect(wipeLocalData()).resolves.toBeUndefined()
  })

  it('still wipes the data when indexedDB is undefined', async () => {
    mockStore.set('income', new Uint8Array([1]))
    localStorage.setItem('minima_x', '1')
    vi.stubGlobal('indexedDB', undefined)

    await expect(wipeLocalData()).resolves.toBeUndefined()

    expect(mockStore.size).toBe(0)
    expect(localStorage.getItem('minima_x')).toBeNull()
  })

  it('swallows an error thrown by deleteDatabase', async () => {
    mockStore.set('income', new Uint8Array([1]))
    vi.stubGlobal('indexedDB', {
      deleteDatabase: () => {
        throw new Error('blocked')
      },
    })

    await expect(wipeLocalData()).resolves.toBeUndefined()
    expect(mockStore.size).toBe(0)
  })
})

describe('reloadToHome', () => {
  it("replaces the location with '/'", () => {
    const replace = vi.fn()
    vi.stubGlobal('location', { replace })

    reloadToHome()

    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith('/')
  })
})
