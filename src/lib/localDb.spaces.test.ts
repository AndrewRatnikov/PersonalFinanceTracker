// CONTRACT_GAP: the batch error for a record the target space does not accept
//   (spaceInfo / memberProfile into personal, identity / spaceKey into a Family
//   space) is taken from the existing applyIncomingRecords convention
//   (Error('applyIncomingRecords: invalid record <index>')); the plan only says
//   "rejects as invalid".
// CONTRACT_GAP: which base keys are announced with the Family postChanged
//   message is not fixed; only that spaceId is carried and the base keys
//   (never the prefixed ones) are listed.
// CONTRACT_GAP: getSpaceInfo / upsertMemberProfile for an id that is not held
//   are asserted to throw SpaceLockedError (plan section 4, "Spaces API").
// CONTRACT_GAP: member.ts: a getAccountSession that throws or returns null both
//   give null (plan: "never throws").
//
// Integration style (as localDb.rev.test.ts): real crypto and real localDb,
// idb-keyval backed by a Map. Stored blobs are opened with the DEK the test
// unlocked with, or with the space key read from the personal spaceKeys record.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Expense, IncomeEntry } from '@/lib/domain'
import type { SyncChannel } from '@/lib/syncChannel'
import type { SyncRecord } from '@/lib/syncRecords'
import type { SpaceKeyEntry } from '@/lib/spaces/types'
import { getAccountSession } from '@/lib/accountSession'
import { base64ToBytes, bytesToBase64, decryptValue, encryptValue } from '@/lib/crypto'
import { DecryptError } from '@/lib/dataErrors'
import {
  IDENTITY_KEY,
  MEMBER_PROFILES_KEY,
  SPACE_INFO_KEY,
  SPACE_KEYS_KEY,
  addCategory,
  addExpense,
  addIncome,
  applyIncomingRecords,
  createLocalSpace,
  cryptoFor,
  deleteExpense,
  ensureIdentityKeyPair,
  forgetLocalSpace,
  getAllCategories,
  getAllExpenses,
  getIdentityPublicKey,
  getLocalRev,
  getMemberProfiles,
  getSpaceInfo,
  listChangedRecords,
  listLocalSpaces,
  quarantineKey,
  readSyncedSettings,
  spaceDb,
  unlockLocalDb,
  updateExpense,
  updateSyncedSettings,
  upsertMemberProfile,
  wipeLocalDbKey,
} from '@/lib/localDb'
import {
  clearKeyring,
  heldSpaceIds,
  isKeyringLoaded,
  isSpaceHeld,
} from '@/lib/spaces/keyring'
import { getCurrentMemberId } from '@/lib/spaces/member'
import {
  generateIdentityKeyPair,
  generateSpaceKey,
  importSpaceKey,
} from '@/lib/spaces/spaceCrypto'
import {
  PERSONAL_SPACE_ID,
  SpaceError,
  isSpaceLockedError,
  isValidFamilySpaceId,
  keyFor,
  parseSpaceStorageKey,
} from '@/lib/spaces/types'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: { setManyCalls: [] as Array<Array<string>> },
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
    ctl.setManyCalls.push(entries.map(([key]) => key))
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

const T0 = '2026-05-01T09:00:00.000Z'
const T1 = '2026-05-15T10:00:00.000Z'
const T2 = '2026-05-16T10:00:00.000Z'
const MAY = '2026-05-15T12:00:00.000Z'
const MAY_CHUNK = 'expenses_2026_05'
const UNHELD = '9d3c0a52-1111-4222-8333-000000000001'

let dek: CryptoKey

function setNow(iso: string) {
  vi.setSystemTime(new Date(iso))
}

function fakeChannel() {
  return {
    postMessage: vi.fn<SyncChannel['postMessage']>(),
    addEventListener: vi.fn<SyncChannel['addEventListener']>(),
    removeEventListener: vi.fn<SyncChannel['removeEventListener']>(),
    close: vi.fn<SyncChannel['close']>(),
  }
}

function session(userId: string | null) {
  vi.mocked(getAccountSession).mockResolvedValue(
    userId === null ? null : { userId, email: null },
  )
}

async function personalSpaceKeys(): Promise<Array<SpaceKeyEntry>> {
  const raw = mockStore.get(SPACE_KEYS_KEY)
  if (!(raw instanceof Uint8Array)) throw new Error('no spaceKeys record')
  return (await decryptValue(dek, raw)) as Array<SpaceKeyEntry>
}

async function skOf(spaceId: string, version?: number): Promise<CryptoKey> {
  const entry = (await personalSpaceKeys()).find((e) => e.id === spaceId)
  if (!entry) throw new Error(`no space key entry for ${spaceId}`)
  const material =
    version === undefined || version === entry.keyVersion
      ? entry.key
      : entry.previousKeys?.find((k) => k.keyVersion === version)?.key
  if (!material) throw new Error('no such key version')
  return importSpaceKey(base64ToBytes(material))
}

async function readFamily<T>(spaceId: string, base: string, key?: CryptoKey): Promise<T> {
  const raw = mockStore.get(`space:${spaceId}:${base}`)
  if (!(raw instanceof Uint8Array)) throw new Error(`nothing under space:${spaceId}:${base}`)
  return (await decryptValue(key ?? (await skOf(spaceId)), raw)) as T
}

async function readPersonal<T>(base: string): Promise<T> {
  const raw = mockStore.get(base)
  if (!(raw instanceof Uint8Array)) throw new Error(`nothing under ${base}`)
  return (await decryptValue(dek, raw)) as T
}

function familyRev(spaceId: string): number {
  const meta = mockStore.get(`space:${spaceId}:meta:sync`) as { localRev: number } | undefined
  return meta?.localRev ?? 0
}

function personalRev(): number {
  const meta = mockStore.get('meta:sync') as { localRev: number } | undefined
  return meta?.localRev ?? 0
}

function snapshot(): Map<string, unknown> {
  return new Map(mockStore)
}

function changedKeys(before: Map<string, unknown>): Array<string> {
  const all = new Set([...before.keys(), ...mockStore.keys()])
  return Array.from(all)
    .filter((k) => before.get(k) !== mockStore.get(k))
    .sort()
}

async function newSpace(name = 'Home') {
  return createLocalSpace({ name, lang: 'en' })
}

async function familyCategoryId(spaceId: string): Promise<string> {
  const [first] = await spaceDb(spaceId).getAllCategories()
  return first.id
}

async function addFamilyExpense(spaceId: string, amount = 100, createdAt = MAY) {
  return spaceDb(spaceId).addExpense({
    amount,
    currency: 'UAH',
    categoryId: await familyCategoryId(spaceId),
    description: `family ${amount}`,
    createdAt,
  })
}

async function addPersonalExpense(amount = 5, createdAt = MAY) {
  const category = (await getAllCategories())[0] ?? (await addCategory({ name: 'Food' }))
  return addExpense({
    amount,
    currency: 'UAH',
    categoryId: category.id,
    description: `personal ${amount}`,
    createdAt,
  })
}

// Locks and unlocks again with the same DEK: the keyring reloads from the store.
function relock() {
  wipeLocalDbKey()
  unlockLocalDb(dek)
}

beforeEach(async () => {
  mockStore.clear()
  ctl.setManyCalls.length = 0
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  setNow(T0)
  vi.mocked(getAccountSession).mockReset()
  session(null)
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

describe('keyFor and ids', () => {
  it('personal keys are returned unchanged', () => {
    expect(keyFor(PERSONAL_SPACE_ID, 'expenses_2026_05')).toBe('expenses_2026_05')
    expect(keyFor('personal', 'meta:sync')).toBe('meta:sync')
  })

  it('a Family id prefixes every base key', () => {
    expect(keyFor('abc-123', 'expenses_2026_05')).toBe('space:abc-123:expenses_2026_05')
    expect(keyFor('abc-123', 'meta:sync')).toBe('space:abc-123:meta:sync')
  })

  it.each(['', 'has space', 'a:b', 'x'.repeat(65), 'ünï'])(
    'a bad Family id %j throws TypeError',
    (id) => {
      expect(() => keyFor(id, 'income')).toThrow(TypeError)
    },
  )

  it('isValidFamilySpaceId accepts uuids and refuses personal and bad characters', () => {
    expect(isValidFamilySpaceId(UNHELD)).toBe(true)
    expect(isValidFamilySpaceId('a'.repeat(64))).toBe(true)
    expect(isValidFamilySpaceId('a'.repeat(65))).toBe(false)
    expect(isValidFamilySpaceId('personal')).toBe(false)
    expect(isValidFamilySpaceId('a:b')).toBe(false)
    expect(isValidFamilySpaceId('')).toBe(false)
    expect(isValidFamilySpaceId(42)).toBe(false)
  })

  it('parseSpaceStorageKey splits a prefixed key and refuses everything else', () => {
    expect(parseSpaceStorageKey(`space:${UNHELD}:expenses_2026_05`)).toEqual({
      spaceId: UNHELD,
      baseKey: 'expenses_2026_05',
    })
    expect(parseSpaceStorageKey(`space:${UNHELD}:meta:sync`)).toEqual({
      spaceId: UNHELD,
      baseKey: 'meta:sync',
    })
    expect(parseSpaceStorageKey('expenses_2026_05')).toBeNull()
    expect(parseSpaceStorageKey(`quarantine:space:${UNHELD}:income:2026`)).toBeNull()
  })
})

describe('the handle', () => {
  const MEMBERS = [
    'getLocalRev', 'readSyncedSettings', 'updateSyncedSettings', 'getExpensesForRange',
    'getAllExpenses', 'addExpense', 'deleteExpense', 'undeleteExpense', 'updateExpense',
    'getAllCategories', 'addCategory', 'updateCategory', 'deleteCategory',
    'provisionDefaultCategories', 'getAllIncomeCategories', 'addIncomeCategory',
    'updateIncomeCategory', 'deleteIncomeCategory', 'ensureIncomeCategories', 'getAllIncome',
    'addIncome', 'deleteIncome', 'getAllBudgets', 'upsertBudget', 'deleteBudget',
    'readEntriesForConversion', 'applyEntryConversions', 'convertBudgets', 'getAllRecurring',
    'getDueRecurring', 'processDueRecurring', 'addRecurring', 'updateRecurring',
    'setRecurringPaused', 'deleteRecurring', 'confirmRecurringOccurrence',
    'skipRecurringOccurrence', 'addRepeatingExpense', 'addRepeatingIncome',
    'listChangedRecords', 'applyIncomingRecords', 'compactTombstones', 'dedupeOccurrences',
  ] as const

  it('has all 43 members as functions, for personal and Family', async () => {
    const space = await newSpace()

    expect(MEMBERS).toHaveLength(43)
    for (const id of ['personal', space.id]) {
      const handle = spaceDb(id) as unknown as Record<string, unknown>
      for (const name of MEMBERS) {
        expect(typeof handle[name], `${id}.${name}`).toBe('function')
      }
    }
  })

  it('returns the same object for the same id every time', async () => {
    const space = await newSpace()

    expect(spaceDb('personal')).toBe(spaceDb('personal'))
    expect(spaceDb(space.id)).toBe(spaceDb(space.id))
    expect(spaceDb(space.id)).not.toBe(spaceDb('personal'))
  })

  it('the personal handle reads and writes exactly like the top-level functions', async () => {
    const category = await addCategory({ name: 'Food' })

    const viaHandle = await spaceDb('personal').addExpense({
      amount: 12,
      currency: 'UAH',
      categoryId: category.id,
      createdAt: MAY,
    })

    expect((await getAllExpenses()).map((e) => e.id)).toEqual([viaHandle.id])
    expect(await spaceDb('personal').getLocalRev()).toBe(await getLocalRev())
    expect(mockStore.has(MAY_CHUNK)).toBe(true)
    expect(Array.from(mockStore.keys()).some((k) => k.startsWith('space:'))).toBe(false)
  })
})

describe('isolation: a Family write', () => {
  it('writes only its own chunk and its own meta:sync', async () => {
    const space = await newSpace()
    const before = snapshot()

    await addFamilyExpense(space.id, 250)

    expect(changedKeys(before)).toEqual(
      [`space:${space.id}:${MAY_CHUNK}`, `space:${space.id}:meta:sync`].sort(),
    )
  })

  it('is encrypted with the space key; the DEK cannot open it', async () => {
    const space = await newSpace()
    await addFamilyExpense(space.id, 250)
    const raw = mockStore.get(`space:${space.id}:${MAY_CHUNK}`)

    expect(raw).toBeInstanceOf(Uint8Array)
    await expect(decryptValue(dek, raw as Uint8Array)).rejects.toBeDefined()
    const list = await readFamily<Array<Expense>>(space.id, MAY_CHUNK)
    expect(list).toHaveLength(1)
    expect(list[0].amount).toBe(250)
  })

  it('every other family record is encrypted with the space key too', async () => {
    const space = await newSpace()
    for (const base of [SPACE_INFO_KEY, 'categories', 'incomeCategories', 'syncedSettings']) {
      const raw = mockStore.get(`space:${space.id}:${base}`)
      expect(raw, base).toBeInstanceOf(Uint8Array)
      await expect(decryptValue(dek, raw as Uint8Array), base).rejects.toBeDefined()
      await expect(readFamily(space.id, base), base).resolves.toBeDefined()
    }
  })

  it('leaves the personal list, rev and every personal key untouched', async () => {
    const space = await newSpace()
    await addPersonalExpense(7)
    const personalBefore = (await getAllExpenses()).map((e) => ({ id: e.id, amount: e.amount }))
    const keyValues = new Map(
      Array.from(mockStore.entries()).filter(([k]) => !k.startsWith('space:')),
    )

    await addFamilyExpense(space.id, 900)
    await addFamilyExpense(space.id, 901)

    expect((await getAllExpenses()).map((e) => ({ id: e.id, amount: e.amount }))).toEqual(
      personalBefore,
    )
    for (const [key, value] of keyValues) expect(mockStore.get(key), key).toBe(value)
  })

  it('a personal write leaves the Family list, rev and every Family key untouched', async () => {
    const space = await newSpace()
    await addFamilyExpense(space.id, 300)
    const familyBefore = (await spaceDb(space.id).getAllExpenses()).map((e) => e.amount)
    const keyValues = new Map(
      Array.from(mockStore.entries()).filter(([k]) => k.startsWith(`space:${space.id}:`)),
    )

    await addPersonalExpense(11)
    await addPersonalExpense(12)

    expect((await spaceDb(space.id).getAllExpenses()).map((e) => e.amount)).toEqual(familyBefore)
    for (const [key, value] of keyValues) expect(mockStore.get(key), key).toBe(value)
  })

  it('personal and Family totals are independent', async () => {
    const space = await newSpace()
    await addPersonalExpense(10)
    await addPersonalExpense(20)
    await addFamilyExpense(space.id, 1000)

    const sum = (list: Array<Expense>) => list.reduce((n, e) => n + e.amount, 0)

    expect(sum(await getAllExpenses())).toBe(30)
    expect(sum(await spaceDb(space.id).getAllExpenses())).toBe(1000)
  })

  it('income, categories and budgets of the two spaces do not mix', async () => {
    const space = await newSpace()
    const fam = spaceDb(space.id)
    const famIncomeCat = (await fam.getAllIncomeCategories())[0]
    await fam.addIncome({ categoryId: famIncomeCat.id, amount: 77, currency: 'UAH', createdAt: MAY })
    await fam.addCategory({ name: 'Family only' })

    expect(await spaceDb('personal').getAllIncome()).toEqual([])
    expect((await getAllCategories()).map((c) => c.name)).not.toContain('Family only')
    expect((await fam.getAllCategories()).map((c) => c.name)).toContain('Family only')
    expect((await fam.getAllIncome()).map((i) => i.amount)).toEqual([77])
  })

  it('a personal store without spaces never gets a space: key', async () => {
    await addPersonalExpense(3)
    await updateSyncedSettings({ fetchExchangeRates: false })

    expect(Array.from(mockStore.keys()).some((k) => k.startsWith('space:'))).toBe(false)
    expect(mockStore.has(SPACE_KEYS_KEY)).toBe(false)
    expect(mockStore.has(IDENTITY_KEY)).toBe(false)
  })

  it('keeps month chunks separate per space', async () => {
    const space = await newSpace()
    await addFamilyExpense(space.id, 1, '2026-03-10T12:00:00.000Z')
    await addPersonalExpense(2, '2026-04-10T12:00:00.000Z')

    expect(mockStore.has(`space:${space.id}:expenses_2026_03`)).toBe(true)
    expect(mockStore.has('expenses_2026_03')).toBe(false)
    expect(mockStore.has('expenses_2026_04')).toBe(true)
    expect(mockStore.has(`space:${space.id}:expenses_2026_04`)).toBe(false)
  })
})

describe('revs per space', () => {
  it('a Family write bumps only the Family localRev', async () => {
    const space = await newSpace()
    await addPersonalExpense(1)
    const personalBefore = personalRev()
    const metaBefore = mockStore.get('meta:sync')
    const familyBefore = familyRev(space.id)

    await addFamilyExpense(space.id, 5)

    expect(familyRev(space.id)).toBe(familyBefore + 1)
    expect(personalRev()).toBe(personalBefore)
    expect(mockStore.get('meta:sync')).toBe(metaBefore)
    expect(await spaceDb(space.id).getLocalRev()).toBe(familyBefore + 1)
  })

  it('a personal write bumps only the personal localRev', async () => {
    const space = await newSpace()
    const familyBefore = familyRev(space.id)
    const familyMeta = mockStore.get(`space:${space.id}:meta:sync`)
    const personalBefore = personalRev()

    await addPersonalExpense(1)
    await addPersonalExpense(2)

    expect(personalRev()).toBe(personalBefore + 2)
    expect(await getLocalRev()).toBe(personalBefore + 2)
    expect(familyRev(space.id)).toBe(familyBefore)
    expect(mockStore.get(`space:${space.id}:meta:sync`)).toBe(familyMeta)
  })

  it('stamps the written Family record with the new family rev', async () => {
    const space = await newSpace()
    const before = familyRev(space.id)

    await addFamilyExpense(space.id, 5)
    await addFamilyExpense(space.id, 6)

    const list = await readFamily<Array<Expense>>(space.id, MAY_CHUNK)
    expect(list.map((e) => e.rev).sort()).toEqual([before + 1, before + 2])
  })

  it('a rejected write bumps nothing', async () => {
    const space = await newSpace()
    const before = snapshot()

    await expect(
      spaceDb(space.id).updateExpense('missing', MAY, { amount: 1 }),
    ).rejects.toThrow()

    expect(changedKeys(before)).toEqual([])
  })
})

describe('listChangedRecords / applyIncomingRecords per space', () => {
  it('listChangedRecords(spaceId, since) returns only that space’s records, without rev', async () => {
    const space = await newSpace()
    const fam = await addFamilyExpense(space.id, 42)
    const per = await addPersonalExpense(43)

    const family = await listChangedRecords(space.id, -1)
    const personal = await listChangedRecords(-1)

    expect(family.records.some((r) => r.type === 'expense' && r.id === fam.id)).toBe(true)
    expect(family.records.some((r) => r.id === per.id)).toBe(false)
    expect(personal.records.some((r) => r.id === per.id)).toBe(true)
    expect(personal.records.some((r) => r.id === fam.id)).toBe(false)
    expect(family.maxRev).toBe(familyRev(space.id))
    for (const r of [...family.records, ...personal.records]) {
      expect('rev' in r.data, `${r.type}:${r.id}`).toBe(false)
    }
  })

  it('a Family listing carries spaceInfo and Family settings, categories and income categories', async () => {
    const space = await newSpace('Our home')

    const { records } = await listChangedRecords(space.id, -1)
    const types = new Set(records.map((r) => r.type))

    expect(types).toContain('spaceInfo')
    expect(types).toContain('settings')
    expect(types).toContain('category')
    expect(types).toContain('incomeCategory')
    const info = records.find((r) => r.type === 'spaceInfo')
    expect(info?.id).toBe('space')
    expect(info?.data.name).toBe('Our home')
    expect(types.has('identity')).toBe(false)
    expect(types.has('spaceKey')).toBe(false)
  })

  it('listChangedRecords respects sinceRev within a space', async () => {
    const space = await newSpace()
    await addFamilyExpense(space.id, 1)
    const mark = familyRev(space.id)
    const later = await addFamilyExpense(space.id, 2)

    const { records, maxRev } = await listChangedRecords(space.id, mark)

    expect(records.map((r) => r.id)).toEqual([later.id])
    expect(maxRev).toBe(mark + 1)
    expect((await listChangedRecords(space.id, maxRev)).records).toEqual([])
  })

  it('the one-argument form is personal and the two-argument personal form matches it', async () => {
    await addPersonalExpense(9)

    const one = await listChangedRecords(-1)
    const two = await listChangedRecords('personal', -1)

    expect(two).toEqual(one)
  })

  it('applyIncomingRecords(spaceId, ...) writes into the Family space only', async () => {
    const space = await newSpace()
    const categoryId = await familyCategoryId(space.id)
    const incoming: SyncRecord = {
      type: 'expense',
      id: 'incoming-1',
      updatedAt: T1,
      data: {
        id: 'incoming-1',
        amount: 321,
        currency: 'UAH',
        categoryId,
        description: 'from another member',
        createdAt: MAY,
        updatedAt: T1,
      },
    }
    const personalBefore = snapshot()
    const familyRevBefore = familyRev(space.id)

    const result = await applyIncomingRecords(space.id, [incoming])

    expect(result.applied).toBe(1)
    expect((await spaceDb(space.id).getAllExpenses()).map((e) => e.id)).toContain('incoming-1')
    expect((await getAllExpenses()).map((e) => e.id)).not.toContain('incoming-1')
    const personalKeys = Array.from(mockStore.keys()).filter((k) => !k.startsWith('space:'))
    for (const key of personalKeys) expect(mockStore.get(key), key).toBe(personalBefore.get(key))
    // A derived write: it does not take a rev of this device.
    expect(familyRev(space.id)).toBe(familyRevBefore)
  })

  it('applyIncomingRecords(spaceId, ...) accepts spaceInfo and memberProfile for a Family space', async () => {
    const space = await newSpace('Old name')

    await applyIncomingRecords(space.id, [
      {
        type: 'spaceInfo',
        id: 'space',
        updatedAt: T2,
        data: { id: 'space', name: 'Renamed', createdAt: T0, updatedAt: T2 },
      },
      {
        type: 'memberProfile',
        id: 'user-z',
        updatedAt: T2,
        data: { id: 'user-z', displayName: 'Zed', color: '#112233', updatedAt: T2 },
      },
    ])

    expect((await getSpaceInfo(space.id))?.name).toBe('Renamed')
    expect((await getMemberProfiles(space.id)).map((p) => p.displayName)).toEqual(['Zed'])
  })

  it('a personal apply rejects spaceInfo and memberProfile as invalid and writes nothing', async () => {
    const before = snapshot()

    await expect(
      applyIncomingRecords([
        {
          type: 'spaceInfo',
          id: 'space',
          updatedAt: T1,
          data: { id: 'space', name: 'X', createdAt: T1, updatedAt: T1 },
        },
      ]),
    ).rejects.toThrow('applyIncomingRecords: invalid record 0')
    await expect(
      applyIncomingRecords([
        {
          type: 'memberProfile',
          id: 'u',
          updatedAt: T1,
          data: { id: 'u', displayName: 'U', color: '#000000', updatedAt: T1 },
        },
      ]),
    ).rejects.toThrow('applyIncomingRecords: invalid record 0')

    expect(changedKeys(before)).toEqual([])
  })

  it('a Family apply rejects identity and spaceKey as invalid and writes nothing', async () => {
    const space = await newSpace()
    const pair = await generateIdentityKeyPair()
    const before = snapshot()

    await expect(
      applyIncomingRecords(space.id, [
        {
          type: 'identity',
          id: 'identity',
          updatedAt: T1,
          data: {
            id: 'identity',
            publicKeyJwk: pair.publicKeyJwk,
            privateKeyJwk: pair.privateKeyJwk,
            createdAt: T1,
            updatedAt: T1,
          },
        },
      ]),
    ).rejects.toThrow('applyIncomingRecords: invalid record 0')
    await expect(
      applyIncomingRecords(space.id, [
        {
          type: 'spaceKey',
          id: UNHELD,
          updatedAt: T1,
          data: {
            id: UNHELD,
            keyVersion: 1,
            key: bytesToBase64(generateSpaceKey()),
            name: 'X',
            role: 'member',
            joinedAt: T1,
            updatedAt: T1,
          },
        },
      ]),
    ).rejects.toThrow('applyIncomingRecords: invalid record 0')

    expect(changedKeys(before)).toEqual([])
  })

  it('a personal apply accepts an identity record and ensureIdentityKeyPair returns it', async () => {
    const pair = await generateIdentityKeyPair()

    const result = await applyIncomingRecords([
      {
        type: 'identity',
        id: 'identity',
        updatedAt: T1,
        data: {
          id: 'identity',
          publicKeyJwk: pair.publicKeyJwk,
          privateKeyJwk: pair.privateKeyJwk,
          createdAt: T1,
          updatedAt: T1,
        },
      },
    ])

    expect(result.applied).toBe(1)
    expect(await ensureIdentityKeyPair()).toEqual(pair)
  })

  it.each([
    ['a key that is not 32 bytes', { key: 'AAAA' }],
    ['a keyVersion of 0', { keyVersion: 0 }],
    ['an unknown role', { role: 'admin' }],
    ['a name that is not a string', { name: 5 }],
  ])('a personal apply rejects a spaceKey with %s', async (_label, patch) => {
    const data = {
      id: UNHELD,
      keyVersion: 1,
      key: bytesToBase64(generateSpaceKey()),
      name: 'Home',
      role: 'member',
      joinedAt: T1,
      updatedAt: T1,
      ...patch,
    }

    await expect(
      applyIncomingRecords([{ type: 'spaceKey', id: UNHELD, updatedAt: T1, data }]),
    ).rejects.toThrow('applyIncomingRecords: invalid record 0')

    expect(mockStore.has(SPACE_KEYS_KEY)).toBe(false)
  })

  it('a personal apply of a spaceKey makes that space readable and writable', async () => {
    const sk = generateSpaceKey()
    await applyIncomingRecords([
      {
        type: 'spaceKey',
        id: UNHELD,
        updatedAt: T1,
        data: {
          id: UNHELD,
          keyVersion: 1,
          key: bytesToBase64(sk),
          name: 'Shared',
          role: 'member',
          joinedAt: T1,
          updatedAt: T1,
        },
      },
    ])

    expect(await listLocalSpaces()).toEqual([
      { id: UNHELD, name: 'Shared', role: 'member', keyVersion: 1, joinedAt: T1 },
    ])
    await spaceDb(UNHELD).addExpense({
      amount: 8,
      currency: 'UAH',
      categoryId: 'c1',
      createdAt: MAY,
    })
    const stored = await readFamily<Array<Expense>>(
      UNHELD,
      MAY_CHUNK,
      await importSpaceKey(sk),
    )
    expect(stored[0].amount).toBe(8)
  })

  it('a spaceKey tombstone from another device drops the space after the keyring reloads', async () => {
    const space = await newSpace()
    expect(await listLocalSpaces()).toHaveLength(1)
    const data: Record<string, unknown> = { ...(await personalSpaceKeys())[0] }
    delete data.rev
    Object.assign(data, { key: '', deletedAt: T2, updatedAt: T2 })

    await applyIncomingRecords([
      { type: 'spaceKey', id: space.id, updatedAt: T2, deletedAt: T2, data },
    ])

    expect(await listLocalSpaces()).toEqual([])
    await expect(spaceDb(space.id).getAllExpenses()).rejects.toSatisfy(isSpaceLockedError)
  })
})

describe('a locked or missing space key', () => {
  it('every Family read and write raises SpaceLockedError when the key is absent', async () => {
    const fam = spaceDb(UNHELD)
    const before = snapshot()

    for (const call of [
      () => fam.getAllExpenses(),
      () => fam.getAllCategories(),
      () => fam.getAllIncome(),
      () => fam.getAllBudgets(),
      () => fam.getAllRecurring(),
      () => fam.readSyncedSettings(),
      () => fam.addExpense({ amount: 1, currency: 'UAH', categoryId: 'c', createdAt: MAY }),
      () => fam.addCategory({ name: 'x' }),
      () => fam.listChangedRecords(-1),
    ]) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      )
      expect(isSpaceLockedError(err)).toBe(true)
      expect((err as { spaceId: string }).spaceId).toBe(UNHELD)
      expect((err as { code: string }).code).toBe('space-locked')
      expect((err as Error).name).toBe('SpaceLockedError')
    }

    expect(changedKeys(before)).toEqual([])
  })

  it('personal keeps working while a Family space is missing', async () => {
    await expect(spaceDb(UNHELD).getAllExpenses()).rejects.toSatisfy(isSpaceLockedError)

    const saved = await addPersonalExpense(15)

    expect((await getAllExpenses()).map((e) => e.id)).toEqual([saved.id])
  })

  it('never falls back to the DEK: a blob under a Family key is not read with it', async () => {
    mockStore.set(`space:${UNHELD}:${MAY_CHUNK}`, await encryptValue(dek, []))

    await expect(spaceDb(UNHELD).getAllExpenses()).rejects.toSatisfy(isSpaceLockedError)
    await expect(cryptoFor(UNHELD)).rejects.toSatisfy(isSpaceLockedError)
  })

  it('a locked vault raises SpaceLockedError for a space that was held, and nothing is written', async () => {
    const space = await newSpace()
    await addFamilyExpense(space.id, 5)
    const before = snapshot()

    wipeLocalDbKey()

    await expect(
      spaceDb(space.id).addExpense({ amount: 1, currency: 'UAH', categoryId: 'c', createdAt: MAY }),
    ).rejects.toSatisfy(isSpaceLockedError)
    await expect(spaceDb(space.id).getAllExpenses()).rejects.toSatisfy(isSpaceLockedError)
    expect(changedKeys(before)).toEqual([])
  })

  it('cryptoFor(personal) uses the DEK and cryptoFor(family) uses the space key', async () => {
    const space = await newSpace()

    const personal = await cryptoFor('personal')
    const family = await cryptoFor(space.id)

    expect(personal.spaceId).toBe('personal')
    expect(family.spaceId).toBe(space.id)
    expect(await decryptValue(dek, await personal.encrypt({ n: 1 }))).toEqual({ n: 1 })
    const blob = await family.encrypt({ n: 2 })
    expect(await decryptValue(await skOf(space.id), blob)).toEqual({ n: 2 })
    await expect(decryptValue(dek, blob)).rejects.toBeDefined()
    expect(await family.decrypt(blob)).toEqual({ n: 2 })
  })

  it('an unreadable Family blob raises DecryptError naming the prefixed key', async () => {
    const space = await newSpace()
    const wrongKey = await importSpaceKey(generateSpaceKey())
    mockStore.set(`space:${space.id}:${MAY_CHUNK}`, await encryptValue(wrongKey, []))

    const err = await spaceDb(space.id).getAllExpenses().then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(DecryptError)
    expect((err as DecryptError).storageKey).toBe(`space:${space.id}:${MAY_CHUNK}`)
  })
})

describe('concurrent Family writes', () => {
  it('keep every record and give consecutive revs', async () => {
    const space = await newSpace()
    const category = await familyCategoryId(space.id)
    const before = familyRev(space.id)

    await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) =>
        spaceDb(space.id).addExpense({
          amount: n,
          currency: 'UAH',
          categoryId: category,
          createdAt: MAY,
        }),
      ),
    )

    const list = await readFamily<Array<Expense>>(space.id, MAY_CHUNK)
    expect(list.map((e) => e.amount).sort()).toEqual([1, 2, 3, 4, 5, 6])
    expect(list.map((e) => e.rev).sort()).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => before + n),
    )
    expect(familyRev(space.id)).toBe(before + 6)
  })

  it('personal and Family writes at the same time both land with their own counters', async () => {
    const space = await newSpace()
    const category = await familyCategoryId(space.id)
    const personalCategory = await addCategory({ name: 'Food' })
    const familyBefore = familyRev(space.id)
    const personalBefore = personalRev()

    await Promise.all([
      ...[1, 2, 3].map((n) =>
        spaceDb(space.id).addExpense({ amount: n, currency: 'UAH', categoryId: category, createdAt: MAY }),
      ),
      ...[10, 20, 30].map((n) =>
        addExpense({ amount: n, currency: 'UAH', categoryId: personalCategory.id, createdAt: MAY }),
      ),
    ])

    expect((await spaceDb(space.id).getAllExpenses()).map((e) => e.amount).sort()).toEqual([1, 2, 3])
    expect((await getAllExpenses()).map((e) => e.amount).sort((a, b) => a - b)).toEqual([10, 20, 30])
    expect(familyRev(space.id)).toBe(familyBefore + 3)
    expect(personalRev()).toBe(personalBefore + 3)
  })
})

describe('member fields on Family records', () => {
  it('a create stamps createdBy = updatedBy = paidBy = the member id', async () => {
    const space = await newSpace()
    session('user-a')

    await addFamilyExpense(space.id, 10)

    const [stored] = await readFamily<Array<Expense>>(space.id, MAY_CHUNK)
    expect(stored.createdBy).toBe('user-a')
    expect(stored.updatedBy).toBe('user-a')
    expect(stored.paidBy).toBe('user-a')
  })

  it('income gets the same three fields', async () => {
    const space = await newSpace()
    session('user-a')
    const fam = spaceDb(space.id)
    const category = (await fam.getAllIncomeCategories())[0]

    await fam.addIncome({ categoryId: category.id, amount: 99, currency: 'UAH', createdAt: MAY })

    const [stored] = await readFamily<Array<IncomeEntry>>(space.id, 'income')
    expect(stored.createdBy).toBe('user-a')
    expect(stored.updatedBy).toBe('user-a')
    expect(stored.paidBy).toBe('user-a')
  })

  it('categories get createdBy and updatedBy, but no paidBy', async () => {
    const space = await newSpace()
    session('user-a')

    await spaceDb(space.id).addCategory({ name: 'Pets' })

    const list = await readFamily<Array<Record<string, unknown>>>(space.id, 'categories')
    const pets = list.find((c) => c.name === 'Pets')
    expect(pets?.createdBy).toBe('user-a')
    expect(pets?.updatedBy).toBe('user-a')
    expect(pets).not.toHaveProperty('paidBy')
  })

  it('input.paidBy overrides the default for paidBy only', async () => {
    const space = await newSpace()
    session('user-a')

    await spaceDb(space.id).addExpense({
      amount: 10,
      currency: 'UAH',
      categoryId: await familyCategoryId(space.id),
      createdAt: MAY,
      paidBy: 'user-b',
    })

    const [stored] = await readFamily<Array<Expense>>(space.id, MAY_CHUNK)
    expect(stored.paidBy).toBe('user-b')
    expect(stored.createdBy).toBe('user-a')
    expect(stored.updatedBy).toBe('user-a')
  })

  it('an edit by another member changes only updatedBy', async () => {
    const space = await newSpace()
    session('user-a')
    const created = await addFamilyExpense(space.id, 10)
    setNow(T2)
    session('user-b')

    await spaceDb(space.id).updateExpense(created.id, created.createdAt, { amount: 11 })

    const [stored] = await readFamily<Array<Expense>>(space.id, MAY_CHUNK)
    expect(stored.amount).toBe(11)
    expect(stored.updatedBy).toBe('user-b')
    expect(stored.createdBy).toBe('user-a')
    expect(stored.paidBy).toBe('user-a')
  })

  it('an edit that names paidBy changes it', async () => {
    const space = await newSpace()
    session('user-a')
    const created = await addFamilyExpense(space.id, 10)

    await spaceDb(space.id).updateExpense(created.id, created.createdAt, { paidBy: 'user-c' })

    const [stored] = await readFamily<Array<Expense>>(space.id, MAY_CHUNK)
    expect(stored.paidBy).toBe('user-c')
    expect(stored.createdBy).toBe('user-a')
  })

  it('a delete stamps updatedBy on the tombstone', async () => {
    const space = await newSpace()
    session('user-a')
    const created = await addFamilyExpense(space.id, 10)
    setNow(T2)
    session('user-b')

    await spaceDb(space.id).deleteExpense(created.id, created.createdAt)

    const [stored] = await readFamily<Array<Expense>>(space.id, MAY_CHUNK)
    expect(stored.deletedAt).toBe(T2)
    expect(stored.updatedBy).toBe('user-b')
    expect(stored.createdBy).toBe('user-a')
  })

  it('without a member id the fields are absent on create and updatedBy is removed on edit', async () => {
    const space = await newSpace()
    session(null)

    const created = await addFamilyExpense(space.id, 10)

    let [stored] = await readFamily<Array<Expense>>(space.id, MAY_CHUNK)
    expect(stored).not.toHaveProperty('createdBy')
    expect(stored).not.toHaveProperty('updatedBy')
    expect(stored).not.toHaveProperty('paidBy')

    // A known member created it; an unknown writer edits it.
    session('user-a')
    await spaceDb(space.id).updateExpense(created.id, created.createdAt, { amount: 12 })
    ;[stored] = await readFamily<Array<Expense>>(space.id, MAY_CHUNK)
    expect(stored.updatedBy).toBe('user-a')

    session(null)
    await spaceDb(space.id).updateExpense(created.id, created.createdAt, { amount: 13 })
    ;[stored] = await readFamily<Array<Expense>>(space.id, MAY_CHUNK)
    expect(stored.amount).toBe(13)
    expect(stored).not.toHaveProperty('updatedBy')
    expect(stored.createdBy).toBeUndefined()
  })

  it('a throwing account session is treated as no member', async () => {
    const space = await newSpace()
    vi.mocked(getAccountSession).mockRejectedValue(new Error('no network'))

    await addFamilyExpense(space.id, 10)

    const [stored] = await readFamily<Array<Expense>>(space.id, MAY_CHUNK)
    expect(stored).not.toHaveProperty('createdBy')
    expect(stored.amount).toBe(10)
  })

  it('personal records never get createdBy, updatedBy or paidBy, even with a member and an input paidBy', async () => {
    session('user-a')
    const category = await addCategory({ name: 'Food' })
    const expense = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: category.id,
      createdAt: MAY,
      paidBy: 'user-b',
    })
    setNow(T2)
    await updateExpense(expense.id, expense.createdAt, { amount: 6, paidBy: 'user-b' })
    await addIncome({
      categoryId: 'ic',
      amount: 1,
      currency: 'UAH',
      createdAt: MAY,
    })
    await deleteExpense(expense.id, expense.createdAt)

    for (const base of [MAY_CHUNK, 'income', 'categories']) {
      const list = await readPersonal<Array<Record<string, unknown>>>(base)
      for (const record of list) {
        expect(record, `${base}:${String(record.id)}`).not.toHaveProperty('createdBy')
        expect(record, `${base}:${String(record.id)}`).not.toHaveProperty('updatedBy')
        expect(record, `${base}:${String(record.id)}`).not.toHaveProperty('paidBy')
      }
    }
  })

  it('getCurrentMemberId reads the account session and may be null', async () => {
    session('user-q')
    expect(await getCurrentMemberId()).toBe('user-q')

    session(null)
    expect(await getCurrentMemberId()).toBeNull()

    vi.mocked(getAccountSession).mockRejectedValue(new Error('boom'))
    expect(await getCurrentMemberId()).toBeNull()
  })

  it('upsertMemberProfile stamps updatedBy with the member', async () => {
    const space = await newSpace()
    session('user-a')

    const profile = await upsertMemberProfile(space.id, {
      id: 'user-a',
      displayName: 'Ann',
      color: '#ff0000',
    })

    expect(profile.updatedBy).toBe('user-a')
  })
})

describe('identity key pair', () => {
  it('is created on first need as an ECDH P-256 pair with an extractable private JWK', async () => {
    expect(mockStore.has(IDENTITY_KEY)).toBe(false)

    const pair = await ensureIdentityKeyPair()

    expect(pair.publicKeyJwk.kty).toBe('EC')
    expect(pair.publicKeyJwk.crv).toBe('P-256')
    expect(pair.publicKeyJwk.d).toBeUndefined()
    expect(pair.privateKeyJwk.d).toEqual(expect.any(String))
  })

  it('is idempotent: a second call returns the same pair and writes nothing', async () => {
    const first = await ensureIdentityKeyPair()
    const writes = ctl.setManyCalls.length
    const stored = mockStore.get(IDENTITY_KEY)

    const second = await ensureIdentityKeyPair()

    expect(second).toEqual(first)
    expect(ctl.setManyCalls.length).toBe(writes)
    expect(mockStore.get(IDENTITY_KEY)).toBe(stored)
  })

  it('is stored as the encrypted personal record identity', async () => {
    const pair = await ensureIdentityKeyPair()

    const raw = mockStore.get(IDENTITY_KEY)
    expect(raw).toBeInstanceOf(Uint8Array)
    const record = await readPersonal<Record<string, unknown>>(IDENTITY_KEY)
    expect(record.id).toBe('identity')
    expect(record.publicKeyJwk).toEqual(pair.publicKeyJwk)
    expect(record.privateKeyJwk).toEqual(pair.privateKeyJwk)
    expect(typeof record.createdAt).toBe('string')
    expect(typeof record.updatedAt).toBe('string')
    expect(typeof record.rev).toBe('number')
    // Not readable as plain JSON: the stored value is a ciphertext, not the record.
    expect(raw).not.toHaveProperty('privateKeyJwk')
  })

  it('bumps the personal rev and nothing else', async () => {
    const before = personalRev()

    await ensureIdentityKeyPair()

    expect(personalRev()).toBe(before + 1)
  })

  it('getIdentityPublicKey returns the public JWK', async () => {
    const pair = await ensureIdentityKeyPair()

    const jwk = await getIdentityPublicKey()

    expect(jwk).toEqual(pair.publicKeyJwk)
    expect(jwk.d).toBeUndefined()
  })

  it('appears in the personal listing, with key material and without rev', async () => {
    const pair = await ensureIdentityKeyPair()

    const { records } = await listChangedRecords(-1)
    const identity = records.find((r) => r.type === 'identity')

    expect(identity?.id).toBe('identity')
    expect(identity?.data.publicKeyJwk).toEqual(pair.publicKeyJwk)
    expect(identity?.data.privateKeyJwk).toEqual(pair.privateKeyJwk)
    expect(identity?.data).not.toHaveProperty('rev')
  })

  it('is listed after the settings record and before the space keys', async () => {
    await updateSyncedSettings({ fetchExchangeRates: false })
    await ensureIdentityKeyPair()
    await newSpace()

    const types = (await listChangedRecords(-1)).records.map((r) => r.type)

    expect(types).toContain('settings')
    expect(types.indexOf('identity')).toBeGreaterThan(types.indexOf('settings'))
    expect(types.indexOf('spaceKey')).toBeGreaterThan(types.indexOf('identity'))
  })

  it('survives a lock and unlock (read from the store, never cached)', async () => {
    const pair = await ensureIdentityKeyPair()

    relock()

    expect(await ensureIdentityKeyPair()).toEqual(pair)
  })

  it('cannot be read while locked', async () => {
    await ensureIdentityKeyPair()

    wipeLocalDbKey()

    await expect(ensureIdentityKeyPair()).rejects.toThrow()
    await expect(getIdentityPublicKey()).rejects.toThrow()
  })
})

describe('createLocalSpace', () => {
  it('returns the new LocalSpace and lists it', async () => {
    setNow(T1)

    const space = await createLocalSpace({ name: '  Home  ', lang: 'en' })

    expect(isValidFamilySpaceId(space.id)).toBe(true)
    expect(space).toEqual({
      id: space.id,
      name: 'Home',
      role: 'owner',
      keyVersion: 1,
      joinedAt: T1,
    })
    expect(await listLocalSpaces()).toEqual([space])
  })

  it('creates a different id and key for another space (after the first is forgotten)', async () => {
    const first = await newSpace()
    const firstKey = (await personalSpaceKeys())[0].key
    await forgetLocalSpace(first.id)

    const second = await newSpace('Second')
    const entries = await personalSpaceKeys()
    const live = entries.find((e) => e.id === second.id)

    expect(second.id).not.toBe(first.id)
    expect(live?.key).not.toBe(firstKey)
  })

  it('writes the spaceKeys entry: a 32-byte base64 key, version 1, owner, with a rev', async () => {
    setNow(T1)
    const space = await newSpace('Home')

    const entries = await personalSpaceKeys()

    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry.id).toBe(space.id)
    expect(entry.keyVersion).toBe(1)
    expect(entry.role).toBe('owner')
    expect(entry.name).toBe('Home')
    expect(entry.joinedAt).toBe(T1)
    expect(entry.updatedAt).toBe(T1)
    expect(entry.deletedAt).toBeUndefined()
    expect(base64ToBytes(entry.key)).toHaveLength(32)
    expect(typeof entry.rev).toBe('number')
  })

  it('writes spaceInfo encrypted with the space key', async () => {
    setNow(T1)
    const space = await newSpace('Our flat')

    const info = await readFamily<Record<string, unknown>>(space.id, SPACE_INFO_KEY)

    expect(info.id).toBe('space')
    expect(info.name).toBe('Our flat')
    expect(info.createdAt).toBe(T1)
    expect(info.updatedAt).toBe(T1)
    expect(typeof info.rev).toBe('number')
    expect(await getSpaceInfo(space.id)).toEqual({
      id: 'space',
      name: 'Our flat',
      createdAt: T1,
      updatedAt: T1,
    })
  })

  it('writes default expense and income categories in the requested language', async () => {
    const en = await createLocalSpace({ name: 'EN', lang: 'en' })
    const enNames = (await spaceDb(en.id).getAllCategories()).map((c) => c.name)
    const enIncome = (await spaceDb(en.id).getAllIncomeCategories()).map((c) => c.name)
    await forgetLocalSpace(en.id)
    const uk = await createLocalSpace({ name: 'UK', lang: 'uk' })
    const ukNames = (await spaceDb(uk.id).getAllCategories()).map((c) => c.name)
    const ukIncome = (await spaceDb(uk.id).getAllIncomeCategories()).map((c) => c.name)

    expect(enNames.length).toBeGreaterThan(3)
    expect(enIncome.length).toBeGreaterThan(1)
    expect(ukNames.length).toBe(enNames.length)
    expect(ukNames).not.toEqual(enNames)
    expect(ukIncome).not.toEqual(enIncome)
    expect(new Set(ukNames).size).toBe(ukNames.length)
  })

  it('gives every default record a fresh id and a rev', async () => {
    const a = await newSpace()
    const records = await readFamily<Array<{ id: string; rev?: number }>>(a.id, 'categories')

    expect(new Set(records.map((r) => r.id)).size).toBe(records.length)
    for (const r of records) expect(typeof r.rev).toBe('number')
    // Personal ids are not reused.
    const personalCategories = await getAllCategories()
    for (const r of records) {
      expect(personalCategories.map((c) => c.id)).not.toContain(r.id)
    }
  })

  it('copies the personal main currency and rates switch into the Family syncedSettings', async () => {
    mockStore.set(
      'syncedSettings',
      await encryptValue(dek, {
        id: 'settings',
        mainCurrency: 'USD',
        fetchExchangeRates: false,
        updatedAt: T0,
        rev: 1,
      }),
    )
    const personal = await readSyncedSettings()
    expect(personal.mainCurrency).toBe('USD')
    setNow(T1)

    const space = await newSpace()

    const family = await spaceDb(space.id).readSyncedSettings()
    expect(family.mainCurrency).toBe('USD')
    expect(family.fetchExchangeRates).toBe(false)
    expect(family.updatedAt).toBe(T1)
    expect(await readSyncedSettings()).toEqual(personal)
  })

  it('writes everything in ONE setMany, including both meta:sync counters', async () => {
    ctl.setManyCalls.length = 0

    const space = await newSpace()

    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0]).toEqual(
      expect.arrayContaining([
        SPACE_KEYS_KEY,
        'meta:sync',
        `space:${space.id}:${SPACE_INFO_KEY}`,
        `space:${space.id}:categories`,
        `space:${space.id}:incomeCategories`,
        `space:${space.id}:syncedSettings`,
        `space:${space.id}:meta:sync`,
      ]),
    )
  })

  it('bumps each counter by the records written to that space', async () => {
    const personalBefore = personalRev()

    const space = await newSpace()

    // One spaceKeys entry in the personal space.
    expect(personalRev()).toBe(personalBefore + 1)
    // spaceInfo + categories + incomeCategories + syncedSettings in the Family space.
    const categories = await readFamily<Array<unknown>>(space.id, 'categories')
    const incomeCategories = await readFamily<Array<unknown>>(space.id, 'incomeCategories')
    expect(familyRev(space.id)).toBe(1 + categories.length + incomeCategories.length + 1)
  })

  it('refuses an empty, blank or over-long name with invalid-name and writes nothing', async () => {
    const before = snapshot()

    for (const name of ['', '   ', 'x'.repeat(61)]) {
      const err = await createLocalSpace({ name, lang: 'en' }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err, name).toBeInstanceOf(SpaceError)
      expect((err as SpaceError).code).toBe('invalid-name')
    }

    expect(changedKeys(before)).toEqual([])
  })

  it('accepts a name of exactly 60 characters', async () => {
    const space = await createLocalSpace({ name: 'x'.repeat(60), lang: 'en' })

    expect(space.name).toHaveLength(60)
  })

  it('refuses a second Family space with family-space-exists, and writes nothing', async () => {
    await newSpace('First')
    const before = snapshot()

    const err = await newSpace('Second').then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(SpaceError)
    expect((err as SpaceError).code).toBe('family-space-exists')
    expect(changedKeys(before)).toEqual([])
  })

  it('needs an unlocked vault', async () => {
    wipeLocalDbKey()

    await expect(newSpace()).rejects.toThrow()

    unlockLocalDb(dek)
    expect(mockStore.has(SPACE_KEYS_KEY)).toBe(false)
  })

  it('announces the personal spaceKeys change without a spaceId, and the Family change with it', async () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    const space = await newSpace()

    const messages = channel.postMessage.mock.calls.map(([m]) => m)
    expect(messages).toContainEqual({ type: 'changed', keys: ['spaceKeys'] })
    const family = messages.find((m) => m.type === 'changed' && m.spaceId === space.id)
    expect(family).toBeDefined()
    expect(family?.keys).toEqual(expect.arrayContaining(['categories', 'incomeCategories']))
    for (const key of family?.keys ?? []) expect(key.startsWith('space:')).toBe(false)
  })

  it('personal write messages stay byte-identical (no spaceId)', async () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    await addPersonalExpense(5)

    const changed = channel.postMessage.mock.calls.map(([m]) => m)
    expect(changed.length).toBeGreaterThan(0)
    for (const m of changed) expect(m).not.toHaveProperty('spaceId')
    expect(changed).toContainEqual({ type: 'changed', keys: [MAY_CHUNK] })
  })

  it('a Family write does not announce a personal change', async () => {
    const space = await newSpace()
    const channel = fakeChannel()
    setSyncChannel(channel)

    await addFamilyExpense(space.id, 5)

    const messages = channel.postMessage.mock.calls.map(([m]) => m)
    expect(messages).toContainEqual({
      type: 'changed',
      keys: [MAY_CHUNK],
      spaceId: space.id,
    })
    expect(messages.every((m) => m.type === 'changed' && m.spaceId === space.id)).toBe(true)
  })
})

describe('listLocalSpaces and the keyring', () => {
  it('is empty on a fresh vault and while locked', async () => {
    expect(await listLocalSpaces()).toEqual([])
    await newSpace()
    wipeLocalDbKey()

    expect(await listLocalSpaces()).toEqual([])
  })

  it('holds the key after creation and drops every key on lock', async () => {
    const space = await newSpace()
    await listLocalSpaces()
    expect(isSpaceHeld(space.id)).toBe(true)
    expect(heldSpaceIds()).toEqual([space.id])

    wipeLocalDbKey()

    expect(isSpaceHeld(space.id)).toBe(false)
    expect(heldSpaceIds()).toEqual([])
    expect(isKeyringLoaded()).toBe(false)
  })

  it('reloads from the store after unlock', async () => {
    const space = await newSpace()
    await addFamilyExpense(space.id, 77)

    relock()

    expect(await listLocalSpaces()).toEqual([space])
    expect((await spaceDb(space.id).getAllExpenses()).map((e) => e.amount)).toEqual([77])
  })

  it('does not list a tombstoned entry and does not expose key bytes', async () => {
    const space = await newSpace()

    const listed = await listLocalSpaces()

    expect(listed).toEqual([space])
    expect(JSON.stringify(listed)).not.toContain((await personalSpaceKeys())[0].key)
    expect(listed[0]).not.toHaveProperty('key')
  })
})

describe('spaceKeys versions', () => {
  async function seedVersions() {
    const id = UNHELD
    const oldBytes = generateSpaceKey()
    const newBytes = generateSpaceKey()
    const oldKey = await importSpaceKey(oldBytes)
    const entry: SpaceKeyEntry = {
      id,
      keyVersion: 2,
      key: bytesToBase64(newBytes),
      previousKeys: [{ keyVersion: 1, key: bytesToBase64(oldBytes) }],
      name: 'Rotated',
      role: 'member',
      joinedAt: T0,
      updatedAt: T0,
      rev: 1,
    }
    mockStore.set(SPACE_KEYS_KEY, await encryptValue(dek, [entry]))
    const legacy: Expense = {
      id: 'old-1',
      amount: 1,
      currency: 'UAH',
      categoryId: 'c1',
      description: null,
      createdAt: MAY,
      updatedAt: T0,
      rev: 1,
    }
    mockStore.set(`space:${id}:${MAY_CHUNK}`, await encryptValue(oldKey, [legacy]))
    mockStore.set(`space:${id}:meta:sync`, { localRev: 1 })
    relock()
    return { id, oldKey, newKey: await importSpaceKey(newBytes) }
  }

  it('reads a record that is still encrypted with an older key version', async () => {
    const { id } = await seedVersions()

    expect((await spaceDb(id).getAllExpenses()).map((e) => e.id)).toEqual(['old-1'])
  })

  it('writes with the newest key version, re-encrypting the chunk', async () => {
    const { id, oldKey, newKey } = await seedVersions()

    await spaceDb(id).addExpense({
      amount: 2,
      currency: 'UAH',
      categoryId: 'c1',
      createdAt: MAY,
    })

    const raw = mockStore.get(`space:${id}:${MAY_CHUNK}`) as Uint8Array
    const list = (await decryptValue(newKey, raw)) as Array<Expense>
    expect(list.map((e) => e.amount).sort()).toEqual([1, 2])
    await expect(decryptValue(oldKey, raw)).rejects.toBeDefined()
  })

  it('reports the newest version in listLocalSpaces', async () => {
    const { id } = await seedVersions()

    expect(await listLocalSpaces()).toEqual([
      { id, name: 'Rotated', role: 'member', keyVersion: 2, joinedAt: T0 },
    ])
  })

  it('a record unreadable with every version is a DecryptError', async () => {
    const { id } = await seedVersions()
    mockStore.set(
      `space:${id}:${MAY_CHUNK}`,
      await encryptValue(await importSpaceKey(generateSpaceKey()), []),
    )

    await expect(spaceDb(id).getAllExpenses()).rejects.toBeInstanceOf(DecryptError)
  })
})

describe('forgetLocalSpace', () => {
  it('removes every key of the space and lists nothing afterwards', async () => {
    const space = await newSpace()
    await addFamilyExpense(space.id, 5)
    await addPersonalExpense(6)

    await forgetLocalSpace(space.id)

    expect(Array.from(mockStore.keys()).filter((k) => k.startsWith(`space:${space.id}:`))).toEqual([])
    expect(await listLocalSpaces()).toEqual([])
    expect((await getAllExpenses()).map((e) => e.amount)).toEqual([6])
    await expect(spaceDb(space.id).getAllExpenses()).rejects.toSatisfy(isSpaceLockedError)
  })

  it('tombstones the spaceKeys entry without any key material, as a personal write', async () => {
    const space = await newSpace()
    setNow(T2)
    const revBefore = personalRev()

    await forgetLocalSpace(space.id)

    const [entry] = await personalSpaceKeys()
    expect(entry.id).toBe(space.id)
    expect(entry.deletedAt).toBe(T2)
    expect(entry.updatedAt).toBe(T2)
    expect(entry.key).toBe('')
    expect(entry.previousKeys).toBeUndefined()
    expect(personalRev()).toBe(revBefore + 1)
  })

  it('syncs the tombstone with the personal records, with no key material', async () => {
    const space = await newSpace()
    const since = personalRev()
    setNow(T2)

    await forgetLocalSpace(space.id)

    const { records } = await listChangedRecords(since)
    const tombstone = records.find((r) => r.type === 'spaceKey' && r.id === space.id)
    expect(tombstone?.deletedAt).toBe(T2)
    expect(tombstone?.data.key).toBe('')
  })

  it('keeps quarantine copies of the space', async () => {
    const space = await newSpace()
    const copy = `quarantine:space:${space.id}:categories:2026-05-01T00:00:00.000Z`
    const blob = new Uint8Array([1, 2, 3])
    mockStore.set(copy, blob)

    await forgetLocalSpace(space.id)

    expect(mockStore.get(copy)).toBe(blob)
  })

  it('is a no-op for an unknown or already forgotten id', async () => {
    const space = await newSpace()
    await forgetLocalSpace(space.id)
    const before = snapshot()

    await forgetLocalSpace(space.id)
    await forgetLocalSpace(UNHELD)

    expect(changedKeys(before)).toEqual([])
  })

  it('needs only the DEK: it works when the space key cannot be read', async () => {
    const space = await newSpace()
    await addFamilyExpense(space.id, 5)
    const entries = await personalSpaceKeys()
    // Corrupt nothing in the personal record; drop the keyring only.
    clearKeyring()
    expect(entries).toHaveLength(1)

    await forgetLocalSpace(space.id)

    expect(Array.from(mockStore.keys()).some((k) => k.startsWith(`space:${space.id}:`))).toBe(false)
  })

  it('allows creating a new Family space afterwards', async () => {
    const first = await newSpace('First')
    await forgetLocalSpace(first.id)

    const second = await newSpace('Second')

    expect((await listLocalSpaces()).map((s) => s.name)).toEqual(['Second'])
    expect(second.id).not.toBe(first.id)
  })
})

describe('member profiles and space info', () => {
  it('getMemberProfiles is empty until one is written', async () => {
    const space = await newSpace()

    expect(await getMemberProfiles(space.id)).toEqual([])
    expect(mockStore.has(`space:${space.id}:${MEMBER_PROFILES_KEY}`)).toBe(false)
  })

  it('upsertMemberProfile stores the list encrypted with the space key', async () => {
    const space = await newSpace()
    setNow(T1)

    const profile = await upsertMemberProfile(space.id, {
      id: 'user-a',
      displayName: 'Ann',
      color: '#ff0000',
    })

    expect(profile).toMatchObject({ id: 'user-a', displayName: 'Ann', color: '#ff0000', updatedAt: T1 })
    expect(await getMemberProfiles(space.id)).toEqual([
      expect.objectContaining({ id: 'user-a', displayName: 'Ann' }),
    ])
    const raw = mockStore.get(`space:${space.id}:${MEMBER_PROFILES_KEY}`)
    await expect(decryptValue(dek, raw as Uint8Array)).rejects.toBeDefined()
    const stored = await readFamily<Array<Record<string, unknown>>>(space.id, MEMBER_PROFILES_KEY)
    expect(typeof stored[0].rev).toBe('number')
  })

  it('a second upsert for the same member replaces the profile', async () => {
    const space = await newSpace()
    await upsertMemberProfile(space.id, { id: 'user-a', displayName: 'Ann', color: '#ff0000' })
    setNow(T2)

    await upsertMemberProfile(space.id, { id: 'user-a', displayName: 'Anna', color: '#00ff00' })

    const profiles = await getMemberProfiles(space.id)
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({ displayName: 'Anna', color: '#00ff00', updatedAt: T2 })
  })

  it('bumps only the Family rev', async () => {
    const space = await newSpace()
    const familyBefore = familyRev(space.id)
    const personalBefore = personalRev()

    await upsertMemberProfile(space.id, { id: 'user-a', displayName: 'Ann', color: '#ff0000' })

    expect(familyRev(space.id)).toBe(familyBefore + 1)
    expect(personalRev()).toBe(personalBefore)
  })

  it('refuses the personal space with unknown-space', async () => {
    const err = await upsertMemberProfile('personal', {
      id: 'u',
      displayName: 'U',
      color: '#000000',
    }).then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(SpaceError)
    expect((err as SpaceError).code).toBe('unknown-space')
  })

  it('raises SpaceLockedError for a Family space that is not held', async () => {
    await expect(
      upsertMemberProfile(UNHELD, { id: 'u', displayName: 'U', color: '#000000' }),
    ).rejects.toSatisfy(isSpaceLockedError)
    await expect(getSpaceInfo(UNHELD)).rejects.toSatisfy(isSpaceLockedError)
    await expect(getMemberProfiles(UNHELD)).rejects.toSatisfy(isSpaceLockedError)
  })
})

describe('Family settings', () => {
  it('a Family space has its own synced settings', async () => {
    const space = await newSpace()
    const fam = spaceDb(space.id)

    await fam.updateSyncedSettings({ fetchExchangeRates: false })

    expect((await fam.readSyncedSettings()).fetchExchangeRates).toBe(false)
    expect((await readSyncedSettings()).fetchExchangeRates).toBe(true)
  })

  it('a Family read without a record gives the defaults, not the legacy personal fields', async () => {
    const space = await newSpace()
    mockStore.set('meta:settings', { mainCurrency: 'USD', fetchExchangeRates: false })
    mockStore.delete(`space:${space.id}:syncedSettings`)

    const settings = await spaceDb(space.id).readSyncedSettings()

    expect(settings.mainCurrency).toBe('UAH')
    expect(settings.fetchExchangeRates).toBe(true)
    expect(settings.updatedAt).toBe('1970-01-01T00:00:00.000Z')
  })
})

describe('quarantine and data keys of a space', () => {
  it('quarantineKey moves a Family data key to a prefixed quarantine copy', async () => {
    const space = await newSpace()
    const key = `space:${space.id}:categories`
    const blob = mockStore.get(key)
    setNow(T2)

    const target = await quarantineKey(key)

    expect(target).toBe(`quarantine:${key}:${T2}`)
    expect(mockStore.has(key)).toBe(false)
    expect(mockStore.get(target as string)).toBe(blob)
  })

  it('quarantineKey still refuses keys that are not data keys', async () => {
    await expect(quarantineKey('space:bad id:categories')).rejects.toThrow()
    await expect(quarantineKey(`quarantine:space:${UNHELD}:income:x`)).rejects.toThrow()
    await expect(quarantineKey('meta:vault')).rejects.toThrow()
  })
})
