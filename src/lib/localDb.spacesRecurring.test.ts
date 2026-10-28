// CONTRACT_GAP: the per-occurrence chunk and createdAt of a generated record
//   are not part of the Interface Contract; the tests identify generated
//   records by their deterministic id (occurrenceRecordId), not by createdAt.
//
// Background work while the active space is personal: the unlock routine
// (prepareUnlockedVault) and processDueRecurring on a Family handle generate
// Family recurring entries. Real localDb over a Map-backed idb-keyval.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CreateRecurringInput, Expense } from '@/lib/domain'
import type { SpaceKeyEntry } from '@/lib/spaces/types'
import { base64ToBytes, decryptValue } from '@/lib/crypto'
import { isDecryptError } from '@/lib/dataErrors'
import {
  addCategory,
  addRecurring,
  createLocalSpace,
  forgetLocalSpace,
  getAllExpenses,
  getAllRecurring,
  prepareUnlockedVault,
  processDueRecurring,
  spaceDb,
  unlockLocalDb,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { occurrenceRecordId } from '@/lib/occurrenceId'
import { clearKeyring, listHeldSpaceIds } from '@/lib/spaces/keyring'
import { importSpaceKey } from '@/lib/spaces/spaceCrypto'
import { setSyncChannel } from '@/lib/syncChannel'

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

const SETUP_DAY = '2026-04-14'
// Noon local time keeps the local calendar date stable in any timezone.
const RUN_DAY = new Date(2026, 5, 20, 12, 0, 0)
const FAMILY_DATES = ['2026-04-15', '2026-05-15', '2026-06-15']

let dek: CryptoKey

function monthly(categoryId: string, startDate: string, amount: number): CreateRecurringInput {
  return {
    kind: 'expense',
    amount,
    currency: 'UAH',
    categoryId,
    description: `rent ${amount}`,
    frequency: { unit: 'month', interval: 1 },
    startDate,
    end: { type: 'never' },
    mode: 'auto',
  }
}

async function skOf(spaceId: string): Promise<CryptoKey> {
  const raw = mockStore.get('spaceKeys') as Uint8Array
  const entries = (await decryptValue(dek, raw)) as Array<SpaceKeyEntry>
  const entry = entries.find((e) => e.id === spaceId)
  if (!entry) throw new Error('no entry')
  return importSpaceKey(base64ToBytes(entry.key))
}

async function storedFamilyExpenses(spaceId: string): Promise<Array<Expense>> {
  const sk = await skOf(spaceId)
  const out: Array<Expense> = []
  for (const key of Array.from(mockStore.keys()).sort()) {
    if (!new RegExp(`^space:${spaceId}:expenses_\\d{4}_\\d{2}$`).test(key)) continue
    out.push(...((await decryptValue(sk, mockStore.get(key) as Uint8Array)) as Array<Expense>))
  }
  return out
}

async function familyWithItem() {
  const space = await createLocalSpace({ name: 'Home', lang: 'en' })
  const fam = spaceDb(space.id)
  const category = (await fam.getAllCategories())[0]
  const item = await fam.addRecurring(monthly(category.id, '2026-04-15', 100), {
    createThroughToday: false,
    today: SETUP_DAY,
  })
  return { space, fam, category, item }
}

beforeEach(async () => {
  mockStore.clear()
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 3, 14, 12, 0, 0))
  setSyncChannel(null)
  clearKeyring()
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
})

afterEach(() => {
  wipeLocalDbKey()
  setSyncChannel(undefined)
  vi.useRealTimers()
})

describe('the unlock routine covers every held Family space', () => {
  it('creates the due Family occurrences while personal is the only active space', async () => {
    const { space, item } = await familyWithItem()
    expect(await storedFamilyExpenses(space.id)).toEqual([])
    vi.setSystemTime(RUN_DAY)

    const { recurringCreated } = await prepareUnlockedVault({ isNewVault: false })

    expect(recurringCreated).toBe(3)
    const stored = await storedFamilyExpenses(space.id)
    expect(stored).toHaveLength(3)
    expect(stored.map((e) => e.amount)).toEqual([100, 100, 100])
    const expectedIds = await Promise.all(FAMILY_DATES.map((d) => occurrenceRecordId(item.id, d)))
    expect(stored.map((e) => e.id).sort()).toEqual([...expectedIds].sort())
  })

  it('writes no personal record for a Family item', async () => {
    await familyWithItem()
    vi.setSystemTime(RUN_DAY)

    await prepareUnlockedVault({ isNewVault: false })

    expect(await getAllExpenses()).toEqual([])
    expect(
      Array.from(mockStore.keys()).filter((k) => /^expenses_\d{4}_\d{2}$/.test(k)),
    ).toEqual([])
  })

  it('counts personal and Family generated records together, each in its own space', async () => {
    const { space } = await familyWithItem()
    const category = await addCategory({ name: 'Rent' })
    await addRecurring(monthly(category.id, '2026-05-01', 50), {
      createThroughToday: false,
      today: SETUP_DAY,
    })
    vi.setSystemTime(RUN_DAY)

    const { recurringCreated } = await prepareUnlockedVault({ isNewVault: false })

    // Personal: May 1, Jun 1. Family: Apr 15, May 15, Jun 15.
    expect(recurringCreated).toBe(5)
    const personal = await getAllExpenses()
    expect(personal.map((e) => e.amount)).toEqual([50, 50])
    expect((await storedFamilyExpenses(space.id)).map((e) => e.amount)).toEqual([100, 100, 100])
  })

  it('is idempotent: a second run creates nothing and keeps the same ids', async () => {
    const { space } = await familyWithItem()
    vi.setSystemTime(RUN_DAY)
    await prepareUnlockedVault({ isNewVault: false })
    const firstIds = (await storedFamilyExpenses(space.id)).map((e) => e.id).sort()

    const again = await prepareUnlockedVault({ isNewVault: false })

    expect(again.recurringCreated).toBe(0)
    expect((await storedFamilyExpenses(space.id)).map((e) => e.id).sort()).toEqual(firstIds)
  })

  it('also covers a space whose key was loaded only from the store (after a lock and unlock)', async () => {
    const { space } = await familyWithItem()
    wipeLocalDbKey()
    unlockLocalDb(dek)
    vi.setSystemTime(RUN_DAY)

    const { recurringCreated } = await prepareUnlockedVault({ isNewVault: false })

    expect(recurringCreated).toBe(3)
    expect(await storedFamilyExpenses(space.id)).toHaveLength(3)
  })

  it('skips a forgotten space and creates nothing for it', async () => {
    const { space } = await familyWithItem()
    await forgetLocalSpace(space.id)
    vi.setSystemTime(RUN_DAY)

    const { recurringCreated } = await prepareUnlockedVault({ isNewVault: false })

    expect(recurringCreated).toBe(0)
    expect(Array.from(mockStore.keys()).some((k) => k.startsWith(`space:${space.id}:`))).toBe(false)
  })

  it('a personal-only vault behaves as before', async () => {
    const category = await addCategory({ name: 'Rent' })
    await addRecurring(monthly(category.id, '2026-05-01', 50), {
      createThroughToday: false,
      today: SETUP_DAY,
    })
    vi.setSystemTime(RUN_DAY)

    const { recurringCreated } = await prepareUnlockedVault({ isNewVault: false })

    expect(recurringCreated).toBe(2)
    expect(Array.from(mockStore.keys()).some((k) => k.startsWith('space:'))).toBe(false)
  })

  it('a Family DecryptError propagates like a personal one', async () => {
    const { space } = await familyWithItem()
    mockStore.set(`space:${space.id}:recurring`, new Uint8Array(40).fill(7))
    vi.setSystemTime(RUN_DAY)

    const err = await prepareUnlockedVault({ isNewVault: false }).then(
      () => null,
      (e: unknown) => e,
    )

    expect(isDecryptError(err)).toBe(true)
    expect((err as { storageKey: string }).storageKey).toBe(`space:${space.id}:recurring`)
  })
})

describe('processDueRecurring on a handle', () => {
  it('the Family handle generates the Family item; the top-level function ignores it', async () => {
    const { space, fam, item } = await familyWithItem()

    const personalRun = await processDueRecurring('2026-06-20')
    expect(personalRun).toEqual({ created: 0, itemsTouched: 0 })
    expect(await storedFamilyExpenses(space.id)).toEqual([])

    const familyRun = await fam.processDueRecurring('2026-06-20')

    expect(familyRun).toEqual({ created: 3, itemsTouched: 1 })
    const stored = await storedFamilyExpenses(space.id)
    expect(stored.map((e) => e.id)).toContain(await occurrenceRecordId(item.id, '2026-06-15'))
  })

  it('an earlier date creates fewer occurrences (the count follows the date)', async () => {
    const { space, fam } = await familyWithItem()

    const run = await fam.processDueRecurring('2026-05-20')

    expect(run.created).toBe(2)
    expect(await storedFamilyExpenses(space.id)).toHaveLength(2)
  })

  it('the personal item stays out of the Family space', async () => {
    const { fam } = await familyWithItem()
    const category = await addCategory({ name: 'Rent' })
    await addRecurring(monthly(category.id, '2026-05-01', 50), {
      createThroughToday: false,
      today: SETUP_DAY,
    })

    await fam.processDueRecurring('2026-06-20')

    expect(await getAllRecurring()).toHaveLength(1)
    expect(await fam.getAllRecurring()).toHaveLength(1)
    expect(await getAllExpenses()).toEqual([])
  })
})

describe('listHeldSpaceIds', () => {
  it('loads the keyring on demand after unlock', async () => {
    const { space } = await familyWithItem()
    wipeLocalDbKey()
    unlockLocalDb(dek)

    expect(await listHeldSpaceIds()).toEqual([space.id])
  })

  it('is empty without a Family space', async () => {
    expect(await listHeldSpaceIds()).toEqual([])
  })

  it('is empty while the vault is locked', async () => {
    await familyWithItem()
    wipeLocalDbKey()

    expect(await listHeldSpaceIds()).toEqual([])
  })

  it('drops a space after it is forgotten', async () => {
    const { space } = await familyWithItem()
    expect(await listHeldSpaceIds()).toEqual([space.id])

    await forgetLocalSpace(space.id)

    expect(await listHeldSpaceIds()).toEqual([])
  })
})
