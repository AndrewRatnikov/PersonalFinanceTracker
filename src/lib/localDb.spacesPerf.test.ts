// No CONTRACT_GAPs: criterion 29 (a 20,000-record Family space plus a
// 20,000-record personal store stay within the default test timeout).
//
// The datasets are generated and seeded raw in a hook (encrypted with the DEK
// and the space key); the test bodies measure only the operations. No custom
// timeout is set on purpose: the default timeout is the limit.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpaceKeyEntry } from '@/lib/spaces/types'
import { base64ToBytes, decryptValue, encryptValue } from '@/lib/crypto'
import {
  createLocalSpace,
  getAllExpenses,
  getLocalRev,
  listChangedRecords,
  listLocalSpaces,
  prepareUnlockedVault,
  spaceDb,
  unlockLocalDb,
} from '@/lib/localDb'
import { clearKeyring } from '@/lib/spaces/keyring'
import { importSpaceKey } from '@/lib/spaces/spaceCrypto'
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
vi.mock('@/lib/accountSession', () => ({
  getAccountSession: vi.fn().mockResolvedValue(null),
}))

const BASE_TIME = '2026-01-01T00:00:00.000Z'
const MONTHS = 20
const PER_MONTH = 1000
const TOTAL = MONTHS * PER_MONTH

let dek: CryptoKey
let familyId: string

function monthOf(index: number): string {
  const year = 2024 + Math.floor(index / 12)
  const month = (index % 12) + 1
  return `${year}_${String(month).padStart(2, '0')}`
}

function expensesOf(owner: string, month: number): Array<Record<string, unknown>> {
  const [year, mm] = monthOf(month).split('_')
  const list: Array<Record<string, unknown>> = []
  for (let i = 0; i < PER_MONTH; i++) {
    const n = month * PER_MONTH + i
    list.push({
      id: `${owner}-${n}`,
      amount: n + 1,
      currency: 'UAH',
      categoryId: 'cat-1',
      description: null,
      createdAt: `${year}-${mm}-${String((i % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
      updatedAt: BASE_TIME,
      rev: n + 1,
    })
  }
  return list
}

async function seedTwentyThousand(
  owner: string,
  key: CryptoKey,
  prefix: string,
): Promise<void> {
  for (let month = 0; month < MONTHS; month++) {
    mockStore.set(
      `${prefix}expenses_${monthOf(month)}`,
      await encryptValue(key, expensesOf(owner, month)),
    )
  }
  mockStore.set(`${prefix}meta:sync`, { localRev: TOTAL })
}

async function familyKey(): Promise<CryptoKey> {
  const entries = (await decryptValue(dek, mockStore.get('spaceKeys') as Uint8Array)) as Array<SpaceKeyEntry>
  return importSpaceKey(base64ToBytes(entries[0].key))
}

beforeEach(async () => {
  mockStore.clear()
  ctl.setManyCalls.length = 0
  localStorage.clear()
  setSyncChannel(null)
  clearKeyring()
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
  const space = await createLocalSpace({ name: 'Big family', lang: 'en' })
  familyId = space.id
  await seedTwentyThousand('p', dek, '')
  await seedTwentyThousand('f', await familyKey(), `space:${familyId}:`)
}, 60_000)

describe('a 20,000-record Family space next to a 20,000-record personal store', () => {
  it('opens (the unlock routine) within the default timeout and creates nothing', async () => {
    const result = await prepareUnlockedVault({ isNewVault: false })

    expect(result.recurringCreated).toBe(0)
    expect(await listLocalSpaces()).toHaveLength(1)
  })

  it('reads both stores in full', async () => {
    const personal = await getAllExpenses()
    const family = await spaceDb(familyId).getAllExpenses()

    expect(personal).toHaveLength(TOTAL)
    expect(family).toHaveLength(TOTAL)
    expect(personal[0].id.startsWith('p-')).toBe(true)
    expect(family[0].id.startsWith('f-')).toBe(true)
    expect(personal.reduce((n, e) => n + e.amount, 0)).toBe(
      family.reduce((n, e) => n + e.amount, 0),
    )
  })

  it('lists the changed records of each space in full, without mixing', async () => {
    const family = await listChangedRecords(familyId, -1)
    const personal = await listChangedRecords(-1)

    const familyExpenses = family.records.filter((r) => r.type === 'expense')
    const personalExpenses = personal.records.filter((r) => r.type === 'expense')
    expect(familyExpenses).toHaveLength(TOTAL)
    expect(personalExpenses).toHaveLength(TOTAL)
    expect(familyExpenses.every((r) => r.id.startsWith('f-'))).toBe(true)
    expect(personalExpenses.every((r) => r.id.startsWith('p-'))).toBe(true)
    expect(family.maxRev).toBe(TOTAL)
    expect(await getLocalRev()).toBe(TOTAL)
    expect(await spaceDb(familyId).getLocalRev()).toBe(TOTAL)
  })

  it('a single Family write stays one setMany and bumps only the Family rev', async () => {
    const fam = spaceDb(familyId)
    const category = (await fam.getAllCategories())[0]
    ctl.setManyCalls.length = 0

    await fam.addExpense({
      amount: 1,
      currency: 'UAH',
      categoryId: category.id,
      createdAt: '2026-05-15T12:00:00.000Z',
    })

    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0].every((k) => k.startsWith(`space:${familyId}:`))).toBe(true)
    expect(await fam.getLocalRev()).toBe(TOTAL + 1)
    expect(await getLocalRev()).toBe(TOTAL)
  })
})
