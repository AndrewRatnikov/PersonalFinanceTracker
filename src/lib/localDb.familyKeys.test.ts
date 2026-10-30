// CONTRACT_GAP: the exact `joinedAt` / `updatedAt` stamps of adoptSpaceKey are
//   not specified beyond "joinedAt = now"; only that joinedAt is the fake "now".
// CONTRACT_GAP: what updateSpaceInfo does for a space the vault does not hold is
//   not specified; it is not tested.
//
// Integration style (as localDb.spaces.test.ts): real crypto and real localDb,
// idb-keyval backed by a Map. The personal spaceKeys record is opened with the
// DEK the test unlocked with.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpaceKeyEntry } from '@/lib/spaces/types'
import { getAccountSession } from '@/lib/accountSession'
import { base64ToBytes, bytesToBase64, decryptValue, encryptValue } from '@/lib/crypto'
import {
  SPACE_KEYS_KEY,
  adoptSpaceKey,
  createLocalSpace,
  ensureSpaceIndexKey,
  forgetLocalSpace,
  getSpaceInfo,
  getSpaceKeyEntry,
  listLocalSpaces,
  listSpaceKeyEntries,
  onSpaceLocalChange,
  spaceDb,
  unlockLocalDb,
  updateSpaceEntry,
  updateSpaceInfo,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { clearKeyring } from '@/lib/spaces/keyring'
import { SpaceKeyError, generateIndexKey, generateSpaceKey } from '@/lib/spaces/spaceCrypto'
import { SpaceError } from '@/lib/spaces/types'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: { setManyCalls: 0 },
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
    ctl.setManyCalls += 1
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
vi.mock('@/lib/accountSession', () => ({ getAccountSession: vi.fn() }))

const T0 = '2026-10-30T09:00:00.000Z'
const SPACE_A = 'a1b2c3d4-0000-4000-8000-0000000000a1'
const SPACE_B = 'a1b2c3d4-0000-4000-8000-0000000000b2'

let dek: CryptoKey

async function storedEntries(): Promise<Array<SpaceKeyEntry>> {
  const raw = mockStore.get(SPACE_KEYS_KEY)
  if (!(raw instanceof Uint8Array)) throw new Error('no spaceKeys record')
  return (await decryptValue(dek, raw)) as Array<SpaceKeyEntry>
}

async function entryOf(id: string): Promise<SpaceKeyEntry> {
  const found = (await storedEntries()).find((e) => e.id === id)
  if (!found) throw new Error('no entry')
  return found
}

function adoptInput(over: Partial<Parameters<typeof adoptSpaceKey>[0]> = {}) {
  return {
    spaceId: SPACE_A,
    keyVersion: 1,
    sk: generateSpaceKey(),
    indexKey: generateIndexKey(),
    name: 'Home',
    role: 'member' as const,
    ...over,
  }
}

beforeEach(async () => {
  mockStore.clear()
  ctl.setManyCalls = 0
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(T0))
  vi.mocked(getAccountSession).mockReset()
  vi.mocked(getAccountSession).mockResolvedValue({ userId: 'user-1', email: null })
  setSyncChannel(null)
  clearKeyring()
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  unlockLocalDb(dek)
})

afterEach(() => {
  wipeLocalDbKey()
  setSyncChannel(undefined)
  vi.useRealTimers()
})

describe('createLocalSpace and the index key', () => {
  it('writes a 32-byte indexKey and no status', async () => {
    const space = await createLocalSpace({ name: 'Home', lang: 'en' })

    const entry = await entryOf(space.id)
    expect(base64ToBytes(entry.indexKey ?? '').byteLength).toBe(32)
    expect(entry.status).toBeUndefined()
    expect(entry.key).not.toBe(entry.indexKey)
  })

  it('gives every space its own indexKey', async () => {
    const a = await createLocalSpace({ name: 'A', lang: 'en' })
    const b = await createLocalSpace({ name: 'B', lang: 'en' })

    expect((await entryOf(a.id)).indexKey).not.toBe((await entryOf(b.id)).indexKey)
  })
})

describe('listSpaceKeyEntries / getSpaceKeyEntry', () => {
  it('returns live entries with key material and without rev', async () => {
    const a = await createLocalSpace({ name: 'A', lang: 'en' })
    const b = await createLocalSpace({ name: 'B', lang: 'en' })

    const list = await listSpaceKeyEntries()

    expect(list.map((e) => e.id).sort()).toEqual([a.id, b.id].sort())
    for (const e of list) {
      expect(e.key.length).toBeGreaterThan(0)
      expect(e.indexKey?.length).toBeGreaterThan(0)
      expect('rev' in e).toBe(false)
    }
  })

  it('skips forgotten (tombstoned) spaces', async () => {
    const a = await createLocalSpace({ name: 'A', lang: 'en' })
    const b = await createLocalSpace({ name: 'B', lang: 'en' })
    await forgetLocalSpace(a.id)

    expect((await listSpaceKeyEntries()).map((e) => e.id)).toEqual([b.id])
    expect(await getSpaceKeyEntry(a.id)).toBeNull()
    expect((await getSpaceKeyEntry(b.id))?.name).toBe('B')
  })

  it('is empty while locked and null for an unknown id', async () => {
    await createLocalSpace({ name: 'A', lang: 'en' })
    expect(await getSpaceKeyEntry(SPACE_B)).toBeNull()

    wipeLocalDbKey()

    expect(await listSpaceKeyEntries()).toEqual([])
  })

  it('a forgotten space leaves no key material in its tombstone', async () => {
    const a = await createLocalSpace({ name: 'A', lang: 'en' })
    await forgetLocalSpace(a.id)

    const tomb = await entryOf(a.id)

    expect(tomb.deletedAt).toBeDefined()
    expect(tomb.key).toBe('')
    expect(tomb.indexKey).toBeUndefined()
    expect(tomb.wrappedFor).toBeUndefined()
  })
})

describe('adoptSpaceKey', () => {
  it('creates an active entry with the given keys, role and name', async () => {
    const input = adoptInput({ keyVersion: 2, role: 'member', name: 'Our Family' })

    const entry = await adoptSpaceKey(input)

    expect(entry).toMatchObject({
      id: SPACE_A,
      keyVersion: 2,
      name: 'Our Family',
      role: 'member',
      status: 'active',
      joinedAt: T0,
    })
    expect(entry.key).toBe(bytesToBase64(input.sk))
    expect(entry.indexKey).toBe(bytesToBase64(input.indexKey))
    expect(await getSpaceKeyEntry(SPACE_A)).toMatchObject({ keyVersion: 2, status: 'active' })
  })

  it('makes the space usable (listed and writable with the adopted key)', async () => {
    await adoptSpaceKey(adoptInput())

    expect((await listLocalSpaces()).map((s) => s.id)).toContain(SPACE_A)
    const stored = await spaceDb(SPACE_A).getAllCategories()
    expect(Array.isArray(stored)).toBe(true)
  })

  it('a newer version moves the current key into previousKeys', async () => {
    const v1 = adoptInput({ keyVersion: 1 })
    const v2 = adoptInput({ keyVersion: 2, indexKey: v1.indexKey })
    await adoptSpaceKey(v1)

    const entry = await adoptSpaceKey(v2)

    expect(entry.keyVersion).toBe(2)
    expect(entry.key).toBe(bytesToBase64(v2.sk))
    expect(entry.previousKeys).toEqual([{ keyVersion: 1, key: bytesToBase64(v1.sk) }])
  })

  it('an older version that is not held yet is added to previousKeys, the current key stays', async () => {
    const v1 = adoptInput({ keyVersion: 1 })
    const v3 = adoptInput({ keyVersion: 3, indexKey: v1.indexKey })
    await adoptSpaceKey(v3)

    const entry = await adoptSpaceKey(v1)

    expect(entry.keyVersion).toBe(3)
    expect(entry.key).toBe(bytesToBase64(v3.sk))
    expect(entry.previousKeys).toContainEqual({ keyVersion: 1, key: bytesToBase64(v1.sk) })
  })

  it('the same version with the same key writes nothing', async () => {
    const input = adoptInput()
    await adoptSpaceKey(input)
    const before = mockStore.get(SPACE_KEYS_KEY)
    const writes = ctl.setManyCalls

    await adoptSpaceKey({ ...input })

    expect(mockStore.get(SPACE_KEYS_KEY)).toBe(before)
    expect(ctl.setManyCalls).toBe(writes)
  })

  it('refuses a different indexKey for an existing entry', async () => {
    await adoptSpaceKey(adoptInput())

    let thrown: unknown = null
    try {
      await adoptSpaceKey(adoptInput({ keyVersion: 2 }))
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(SpaceKeyError)
    expect((thrown as { code: string }).code).toBe('invalid')
    expect((await entryOf(SPACE_A)).keyVersion).toBe(1)
  })

  it('is a personal write: the personal rev moves, the Family meta does not', async () => {
    const before = (mockStore.get('meta:sync') as { localRev: number } | undefined)?.localRev ?? 0

    await adoptSpaceKey(adoptInput())

    const after = (mockStore.get('meta:sync') as { localRev: number }).localRev
    expect(after).toBeGreaterThan(before)
    expect((await entryOf(SPACE_A)).rev).toBeGreaterThan(0)
  })
})

describe('updateSpaceEntry', () => {
  it('patches name, role, status and wrappedFor', async () => {
    await adoptSpaceKey(adoptInput())

    const entry = await updateSpaceEntry(SPACE_A, {
      name: 'Renamed',
      role: 'owner',
      status: 'left',
      wrappedFor: { keyVersion: 1, userIds: ['u1', 'u2'] },
    })

    expect(entry).toMatchObject({
      name: 'Renamed',
      role: 'owner',
      status: 'left',
      wrappedFor: { keyVersion: 1, userIds: ['u1', 'u2'] },
    })
    expect(await getSpaceKeyEntry(SPACE_A)).toMatchObject({ status: 'left', name: 'Renamed' })
  })

  it('a patch that changes nothing writes nothing (no rev)', async () => {
    await adoptSpaceKey(adoptInput({ name: 'Same', role: 'member' }))
    const before = mockStore.get(SPACE_KEYS_KEY)
    const writes = ctl.setManyCalls

    const entry = await updateSpaceEntry(SPACE_A, { name: 'Same', role: 'member', status: 'active' })

    expect(entry?.name).toBe('Same')
    expect(mockStore.get(SPACE_KEYS_KEY)).toBe(before)
    expect(ctl.setManyCalls).toBe(writes)
  })

  it('returns null for an unknown id and writes nothing', async () => {
    const writes = ctl.setManyCalls

    expect(await updateSpaceEntry(SPACE_B, { name: 'x' })).toBeNull()
    expect(ctl.setManyCalls).toBe(writes)
  })

  it('does not touch the key material', async () => {
    const input = adoptInput()
    await adoptSpaceKey(input)

    await updateSpaceEntry(SPACE_A, { status: 'removed' })

    const entry = await entryOf(SPACE_A)
    expect(entry.key).toBe(bytesToBase64(input.sk))
    expect(entry.indexKey).toBe(bytesToBase64(input.indexKey))
  })
})

describe('ensureSpaceIndexKey', () => {
  async function stripIndexKey(id: string) {
    const entries = (await storedEntries()).map((e) => {
      if (e.id !== id) return e
      const { indexKey: _drop, ...rest } = e
      return rest
    })
    mockStore.set(SPACE_KEYS_KEY, await encryptValue(dek, entries))
    wipeLocalDbKey()
    unlockLocalDb(dek)
  }

  it('adds a 32-byte indexKey to a run A entry that lacks one', async () => {
    const space = await createLocalSpace({ name: 'Old', lang: 'en' })
    await stripIndexKey(space.id)
    expect((await entryOf(space.id)).indexKey).toBeUndefined()

    const entry = await ensureSpaceIndexKey(space.id)

    expect(base64ToBytes(entry.indexKey ?? '').byteLength).toBe(32)
    expect((await entryOf(space.id)).indexKey).toBe(entry.indexKey)
  })

  it('keeps an existing indexKey', async () => {
    const space = await createLocalSpace({ name: 'New', lang: 'en' })
    const before = (await entryOf(space.id)).indexKey

    const entry = await ensureSpaceIndexKey(space.id)

    expect(entry.indexKey).toBe(before)
  })
})

describe('updateSpaceInfo', () => {
  it('trims and renames, keeps createdBy and stamps updatedBy', async () => {
    const space = await createLocalSpace({ name: 'Home', lang: 'en' })
    const before = await getSpaceInfo(space.id)
    vi.setSystemTime(new Date('2026-10-30T10:00:00.000Z'))

    const info = await updateSpaceInfo(space.id, { name: '  Our place  ' })

    expect(info.name).toBe('Our place')
    expect(info.createdBy).toBe(before?.createdBy)
    expect(info.updatedBy).toBe('user-1')
    expect(info.updatedAt).toBe('2026-10-30T10:00:00.000Z')
    expect((await getSpaceInfo(space.id))?.name).toBe('Our place')
  })

  it.each(['', '   ', 'x'.repeat(61)])('rejects the name %j with invalid-name', async (name) => {
    const space = await createLocalSpace({ name: 'Home', lang: 'en' })

    let thrown: unknown = null
    try {
      await updateSpaceInfo(space.id, { name })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(SpaceError)
    expect((thrown as SpaceError).code).toBe('invalid-name')
    expect((await getSpaceInfo(space.id))?.name).toBe('Home')
  })

  it('accepts 1 and 60 characters', async () => {
    const space = await createLocalSpace({ name: 'Home', lang: 'en' })

    expect((await updateSpaceInfo(space.id, { name: 'x' })).name).toBe('x')
    expect((await updateSpaceInfo(space.id, { name: 'y'.repeat(60) })).name).toBe('y'.repeat(60))
  })
})

describe('onSpaceLocalChange', () => {
  it('fires with the space id after a Family user write', async () => {
    const space = await createLocalSpace({ name: 'Home', lang: 'en' })
    const listener = vi.fn()
    onSpaceLocalChange(listener)

    await updateSpaceInfo(space.id, { name: 'Renamed' })

    expect(listener).toHaveBeenCalledWith(space.id)
  })

  it('does not fire for a personal write', async () => {
    const space = await createLocalSpace({ name: 'Home', lang: 'en' })
    const listener = vi.fn()
    onSpaceLocalChange(listener)

    await updateSpaceEntry(space.id, { name: 'Personal rename' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('stops firing after unsubscribe', async () => {
    const space = await createLocalSpace({ name: 'Home', lang: 'en' })
    const listener = vi.fn()
    const off = onSpaceLocalChange(listener)
    off()

    await updateSpaceInfo(space.id, { name: 'Renamed' })

    expect(listener).not.toHaveBeenCalled()
  })
})
