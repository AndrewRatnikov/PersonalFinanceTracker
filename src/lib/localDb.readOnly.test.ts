// CONTRACT_GAP: which Family user writes are blocked is given as "a Family user
//   write" (plan section 2); addExpense, updateSpaceInfo and upsertMemberProfile
//   are used as the representatives.
//
// Integration style (as localDb.spaces.test.ts): real crypto and real localDb,
// idb-keyval backed by a Map.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpaceShareStatus } from '@/lib/spaces/types'
import { getAccountSession } from '@/lib/accountSession'
import {
  SpaceReadOnlyError as LocalDbSpaceReadOnlyError,
  addCategory,
  addExpense,
  applyIncomingRecords,
  createLocalSpace,
  listChangedRecords,
  isSpaceReadOnlyError as localDbIsSpaceReadOnlyError,
  spaceDb,
  unlockLocalDb,
  updateSpaceEntry,
  updateSpaceInfo,
  upsertMemberProfile,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { clearKeyring, isSpaceReadOnly } from '@/lib/spaces/keyring'
import {
  READ_ONLY_SPACE_STATUSES,
  SpaceReadOnlyError,
  isReadOnlyShareStatus,
  isSpaceReadOnlyError,
} from '@/lib/spaces/types'
import { setSyncChannel } from '@/lib/syncChannel'

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
vi.mock('@/lib/accountSession', () => ({ getAccountSession: vi.fn() }))

const T0 = '2026-10-30T09:00:00.000Z'
const MAY = '2026-10-15T12:00:00.000Z'

let dek: CryptoKey

function snapshot(): Map<string, unknown> {
  return new Map(mockStore)
}

function changedKeys(before: Map<string, unknown>): Array<string> {
  const all = new Set([...before.keys(), ...mockStore.keys()])
  return Array.from(all).filter((k) => before.get(k) !== mockStore.get(k))
}

async function newSpace() {
  const space = await createLocalSpace({ name: 'Home', lang: 'en' })
  return space.id
}

async function addFamilyExpense(spaceId: string, amount: number) {
  const [category] = await spaceDb(spaceId).getAllCategories()
  return spaceDb(spaceId).addExpense({
    amount,
    currency: 'UAH',
    categoryId: category.id,
    description: `family ${amount}`,
    createdAt: MAY,
  })
}

// Marks the space and reloads the keyring so the flag is visible.
async function markStatus(spaceId: string, status: SpaceShareStatus) {
  await updateSpaceEntry(spaceId, { status })
  wipeLocalDbKey()
  unlockLocalDb(dek)
  await spaceDb(spaceId).getAllExpenses()
}

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  )
}

beforeEach(async () => {
  mockStore.clear()
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

describe('SpaceReadOnlyError and the status helpers', () => {
  it('has name, code and spaceId', () => {
    const err = new SpaceReadOnlyError('space-1')

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SpaceReadOnlyError')
    expect(err.code).toBe('space-read-only')
    expect(err.spaceId).toBe('space-1')
  })

  it('isSpaceReadOnlyError accepts the class and duck-typed lookalikes only', () => {
    expect(isSpaceReadOnlyError(new SpaceReadOnlyError('s'))).toBe(true)
    const lookalike = Object.assign(new Error('x'), { name: 'SpaceReadOnlyError', spaceId: 's' })
    expect(isSpaceReadOnlyError(lookalike)).toBe(true)
    expect(isSpaceReadOnlyError(Object.assign(new Error('x'), { name: 'SpaceReadOnlyError' }))).toBe(false)
    expect(isSpaceReadOnlyError(new Error('x'))).toBe(false)
    expect(isSpaceReadOnlyError('SpaceReadOnlyError')).toBe(false)
    expect(isSpaceReadOnlyError(null)).toBe(false)
  })

  it('localDb re-exports the same class and guard', () => {
    expect(LocalDbSpaceReadOnlyError).toBe(SpaceReadOnlyError)
    expect(localDbIsSpaceReadOnlyError).toBe(isSpaceReadOnlyError)
  })

  it('removed, left and space-gone are read-only; active and absent are not', () => {
    expect(READ_ONLY_SPACE_STATUSES).toEqual(['removed', 'left', 'space-gone'])
    for (const s of READ_ONLY_SPACE_STATUSES) expect(isReadOnlyShareStatus(s)).toBe(true)
    expect(isReadOnlyShareStatus('active')).toBe(false)
    expect(isReadOnlyShareStatus(undefined)).toBe(false)
  })
})

describe.each<SpaceShareStatus>(['removed', 'left', 'space-gone'])('a space with status %s', (status) => {
  let spaceId: string
  let keptId: string

  beforeEach(async () => {
    spaceId = await newSpace()
    keptId = (await addFamilyExpense(spaceId, 777)).id
    await markStatus(spaceId, status)
  })

  it('is flagged read-only by the keyring', () => {
    expect(isSpaceReadOnly(spaceId)).toBe(true)
  })

  it('rejects a Family write with SpaceReadOnlyError and writes nothing', async () => {
    const before = snapshot()

    const err = await codeOf(addFamilyExpense(spaceId, 5))

    expect(isSpaceReadOnlyError(err)).toBe(true)
    expect((err as SpaceReadOnlyError).spaceId).toBe(spaceId)
    expect(changedKeys(before)).toEqual([])
  })

  it('rejects renaming the space and editing a member profile', async () => {
    const before = snapshot()

    expect(isSpaceReadOnlyError(await codeOf(updateSpaceInfo(spaceId, { name: 'New' })))).toBe(true)
    expect(
      isSpaceReadOnlyError(
        await codeOf(upsertMemberProfile(spaceId, { id: 'user-1', displayName: 'Ann', color: 'var(--chart-1)' })),
      ),
    ).toBe(true)
    expect(changedKeys(before)).toEqual([])
  })

  it('still reads, lists changes and applies incoming records', async () => {
    const all = await spaceDb(spaceId).getAllExpenses()
    expect(all.map((e) => e.id)).toEqual([keptId])

    const { records } = await listChangedRecords(spaceId, -1)
    expect(records.some((r) => r.type === 'expense' && r.id === keptId)).toBe(true)

    const result = await applyIncomingRecords(spaceId, records)
    expect(result.applied).toBeGreaterThanOrEqual(0)
  })

  it('processDueRecurring returns zeros instead of throwing', async () => {
    await expect(spaceDb(spaceId).processDueRecurring()).resolves.toEqual({ created: 0, itemsTouched: 0 })
  })

  it('personal writes are not affected', async () => {
    const category = await addCategory({ name: 'Food' })
    const expense = await addExpense({
      amount: 12,
      currency: 'UAH',
      categoryId: category.id,
      description: 'personal',
      createdAt: MAY,
    })

    expect(expense.amount).toBe(12)
  })
})

describe('an active or local-only space is writable', () => {
  it('a local-only space (no status) accepts Family writes', async () => {
    const spaceId = await newSpace()

    expect(isSpaceReadOnly(spaceId)).toBe(false)
    expect((await addFamilyExpense(spaceId, 10)).amount).toBe(10)
  })

  it('status active accepts Family writes', async () => {
    const spaceId = await newSpace()
    await markStatus(spaceId, 'active')

    expect(isSpaceReadOnly(spaceId)).toBe(false)
    expect((await addFamilyExpense(spaceId, 11)).amount).toBe(11)
  })

  it('another space is unaffected by a read-only neighbour', async () => {
    // Only one live Family space may exist, so the neighbour is the personal space.
    const gone = await newSpace()
    await markStatus(gone, 'removed')

    expect(isSpaceReadOnly(gone)).toBe(true)
    expect(isSpaceReadOnly('a1b2c3d4-0000-4000-8000-0000000000c3')).toBe(false)
    const category = await addCategory({ name: 'Food' })
    const expense = await addExpense({
      amount: 20,
      currency: 'UAH',
      categoryId: category.id,
      description: 'neighbour',
      createdAt: MAY,
    })
    expect(expense.amount).toBe(20)
    expect(isSpaceReadOnly(gone)).toBe(true)
  })

  it('going back from removed to active lets writes through again', async () => {
    const spaceId = await newSpace()
    await markStatus(spaceId, 'removed')
    expect(isSpaceReadOnlyError(await codeOf(addFamilyExpense(spaceId, 1)))).toBe(true)

    await markStatus(spaceId, 'active')

    expect((await addFamilyExpense(spaceId, 2)).amount).toBe(2)
  })
})
