// CONTRACT_GAP: how readFamilyMeta reaches the store (it must use the same
//   idb-keyval store as localDb) is not in the contract; the tests seed and read
//   `space:<id>:meta:sync` through the idb-keyval mock only.
//
// parseFamilyMeta is pure; readFamilyMeta / updateFamilyMeta run against the
// idb-keyval mock (a Map) with the real localDb unlocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearKeyring } from '@/lib/spaces/keyring'
import { unlockLocalDb, wipeLocalDbKey } from '@/lib/localDb'
import {
  FAMILY_SYNC_FIELD_NAMES,
  parseFamilyMeta,
  readFamilyMeta,
  updateFamilyMeta,
} from '@/lib/sync/familyMeta'

const { mockStore } = vi.hoisted(() => ({ mockStore: new Map<string, unknown>() }))

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

const SPACE = 'a1b2c3d4-0000-4000-8000-0000000000aa'
const OTHER = 'a1b2c3d4-0000-4000-8000-0000000000bb'
const KEY = `space:${SPACE}:meta:sync`

beforeEach(async () => {
  mockStore.clear()
  clearKeyring()
  unlockLocalDb(
    await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
  )
})

afterEach(() => {
  wipeLocalDbKey()
})

describe('FAMILY_SYNC_FIELD_NAMES', () => {
  it('lists the Family fields and never localRev', () => {
    expect(FAMILY_SYNC_FIELD_NAMES).toEqual(
      expect.arrayContaining([
        'pushedRev',
        'pullCursor',
        'keyVersion',
        'state',
        'lastSyncAt',
        'lastError',
        'rotationPendingFrom',
        'reencryptPending',
        'notifiedRequests',
      ]),
    )
    expect(FAMILY_SYNC_FIELD_NAMES as ReadonlyArray<string>).not.toContain('localRev')
  })
})

describe('parseFamilyMeta', () => {
  it.each([null, undefined, 5, 'x', []])('junk %j gives { localRev: 0 }', (raw) => {
    expect(parseFamilyMeta(raw)).toEqual({ localRev: 0 })
  })

  it('keeps well-typed fields', () => {
    const parsed = parseFamilyMeta({
      localRev: 4,
      pushedRev: -1,
      pullCursor: 12,
      keyVersion: 2,
      state: 'synced',
      lastSyncAt: '2026-10-30T10:00:00.000Z',
      lastError: { code: 'undecryptable', count: 2, at: '2026-10-30T10:00:00.000Z' },
      rotationPendingFrom: 1,
      reencryptPending: true,
      notifiedRequests: ['u1', 'u2'],
    })

    expect(parsed).toMatchObject({
      localRev: 4,
      pushedRev: -1,
      pullCursor: 12,
      keyVersion: 2,
      state: 'synced',
      rotationPendingFrom: 1,
      reencryptPending: true,
      notifiedRequests: ['u1', 'u2'],
    })
  })

  it('drops ill-typed fields and keeps the rest', () => {
    const parsed = parseFamilyMeta({
      localRev: 2,
      pushedRev: 'x',
      pullCursor: 7,
      reencryptPending: 'yes',
      notifiedRequests: [1, 2],
    })

    expect(parsed.localRev).toBe(2)
    expect(parsed.pullCursor).toBe(7)
    expect(parsed.pushedRev).toBeUndefined()
    expect(parsed.reencryptPending).toBeUndefined()
    expect(parsed.notifiedRequests).toBeUndefined()
  })
})

describe('readFamilyMeta', () => {
  it('is { localRev: 0 } for a space without meta', async () => {
    expect(await readFamilyMeta(SPACE)).toEqual({ localRev: 0 })
  })

  it('reads the stored meta of that space only', async () => {
    mockStore.set(KEY, { localRev: 3, pullCursor: 9 })
    mockStore.set(`space:${OTHER}:meta:sync`, { localRev: 1, pullCursor: 100 })

    expect(await readFamilyMeta(SPACE)).toMatchObject({ localRev: 3, pullCursor: 9 })
    expect((await readFamilyMeta(OTHER)).pullCursor).toBe(100)
  })
})

describe('updateFamilyMeta', () => {
  it('writes the patch and returns the merged meta', async () => {
    const meta = await updateFamilyMeta(SPACE, { pullCursor: 5, state: 'synced' })

    expect(meta).toMatchObject({ pullCursor: 5, state: 'synced' })
    expect(mockStore.get(KEY)).toMatchObject({ pullCursor: 5, state: 'synced' })
  })

  it('never changes localRev', async () => {
    mockStore.set(KEY, { localRev: 7, pullCursor: 1 })

    const meta = await updateFamilyMeta(SPACE, { pullCursor: 2, pushedRev: 40 })

    expect(meta.localRev).toBe(7)
    expect((mockStore.get(KEY) as { localRev: number }).localRev).toBe(7)
  })

  it('keeps fields that are not in the patch', async () => {
    mockStore.set(KEY, { localRev: 1, pushedRev: 3, notifiedRequests: ['u1'] })

    const meta = await updateFamilyMeta(SPACE, { pullCursor: 4 })

    expect(meta.pushedRev).toBe(3)
    expect(meta.notifiedRequests).toEqual(['u1'])
    expect(meta.pullCursor).toBe(4)
  })

  it('undefined removes a field', async () => {
    mockStore.set(KEY, { localRev: 1, rotationPendingFrom: 2, reencryptPending: true })

    const meta = await updateFamilyMeta(SPACE, { rotationPendingFrom: undefined })

    expect(meta.rotationPendingFrom).toBeUndefined()
    expect('rotationPendingFrom' in (mockStore.get(KEY) as object) && (mockStore.get(KEY) as { rotationPendingFrom?: number }).rotationPendingFrom !== undefined).toBe(false)
    expect(meta.reencryptPending).toBe(true)
  })

  it('serialises concurrent updates without losing a field', async () => {
    await Promise.all([
      updateFamilyMeta(SPACE, { pullCursor: 11 }),
      updateFamilyMeta(SPACE, { pushedRev: 22 }),
      updateFamilyMeta(SPACE, { keyVersion: 3 }),
    ])

    expect(await readFamilyMeta(SPACE)).toMatchObject({ pullCursor: 11, pushedRev: 22, keyVersion: 3 })
  })

  it('does not touch another space', async () => {
    await updateFamilyMeta(SPACE, { pullCursor: 8 })

    expect(mockStore.has(`space:${OTHER}:meta:sync`)).toBe(false)
  })
})
