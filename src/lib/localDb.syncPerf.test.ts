// No CONTRACT_GAPs: listChangedRecords and applyIncomingRecords must handle
// 20,000 records inside the default test timeout (task constraint; plan §8
// "use maps, never a linear search per record, and one setMany").
//
// The dataset is generated and seeded raw in a hook (encrypted with the key
// the test unlocks the db with); the test body measures only the operation.
// No custom timeout is set on purpose: the default timeout is the limit.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Expense } from '@/lib/domain'
import type { SyncRecord } from '@/lib/syncRecords'
import { decryptValue, encryptValue } from '@/lib/crypto'
import {
  applyIncomingRecords,
  getLocalRev,
  listChangedRecords,
  unlockLocalDb,
} from '@/lib/localDb'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: { setManyCalls: [] as Array<Array<string>> },
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
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
  clear: () => {
    mockStore.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(mockStore.keys())),
}))

const BASE_TIME = '2026-01-01T00:00:00.000Z'
const NEWER_TIME = '2026-06-01T00:00:00.000Z'
const OLDER_TIME = '2025-01-01T00:00:00.000Z'

const TOTAL = 20000
const EXPENSES = 17000
const PER_CHUNK = 1000

let dek: CryptoKey

// 2025-01 .. 2026-05 (17 months), then 2026-06 .. 2027-08 for extra months.
function monthOf(index: number): string {
  const year = 2025 + Math.floor(index / 12)
  const month = (index % 12) + 1
  return `${year}-${String(month).padStart(2, '0')}`
}

function createdAtOf(chunkIndex: number, day: number): string {
  return `${monthOf(chunkIndex)}-${String(day).padStart(2, '0')}T12:00:00.000Z`
}

function expenseAt(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const chunk = Math.floor(n / PER_CHUNK)
  return {
    id: `e-${n}`,
    amount: n + 1,
    currency: 'UAH',
    categoryId: 'cat-1',
    description: null,
    createdAt: createdAtOf(chunk, (n % 28) + 1),
    updatedAt: BASE_TIME,
    ...extra,
  }
}

// 17,000 expenses over 17 months, 2,000 income, 500 categories, 100 income
// categories, 300 budgets and 100 recurring items: 20,000 records, rev 1..20000.
async function seedTwentyThousand() {
  let rev = 0
  for (let chunk = 0; chunk < EXPENSES / PER_CHUNK; chunk++) {
    const list: Array<Record<string, unknown>> = []
    for (let i = 0; i < PER_CHUNK; i++) {
      list.push(expenseAt(chunk * PER_CHUNK + i, { rev: ++rev }))
    }
    mockStore.set(`expenses_${monthOf(chunk).replace('-', '_')}`, await encryptValue(dek, list))
  }
  const single = async (key: string, count: number, make: (i: number) => object) => {
    const list = Array.from({ length: count }, (_, i) => ({ ...make(i), rev: ++rev }))
    mockStore.set(key, await encryptValue(dek, list))
  }
  await single('income', 2000, (i) => ({
    id: `inc-${i}`,
    categoryId: 'icat-1',
    amount: i + 1,
    currency: 'UAH',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  }))
  await single('categories', 500, (i) => ({
    id: `cat-${i}`,
    name: `Category ${i}`,
    icon: null,
    updatedAt: BASE_TIME,
  }))
  await single('incomeCategories', 100, (i) => ({
    id: `icat-${i}`,
    name: `Income ${i}`,
    icon: null,
    updatedAt: BASE_TIME,
  }))
  await single('budgets', 300, (i) => ({
    id: `bud-${i}`,
    categoryId: `cat-${i}`,
    monthlyLimit: i + 1,
    currency: 'UAH',
    updatedAt: BASE_TIME,
  }))
  await single('recurring', 100, (i) => ({
    id: `rec-${i}`,
    kind: 'expense',
    amount: i + 1,
    currency: 'UAH',
    categoryId: 'cat-1',
    description: null,
    frequency: { unit: 'month', interval: 1 },
    startDate: '2026-01-01',
    end: { type: 'never' },
    mode: 'ask',
    paused: false,
    handledThrough: null,
    handledAhead: [],
    occurrenceCount: 0,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  }))
  mockStore.set('meta:sync', { localRev: rev })
  return rev
}

function expenseRecord(n: number, updatedAt: string, extra: Record<string, unknown> = {}): SyncRecord {
  const data = expenseAt(n, { updatedAt, ...extra })
  return { type: 'expense', id: `e-${n}`, updatedAt, data }
}

beforeEach(async () => {
  mockStore.clear()
  ctl.setManyCalls.length = 0
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
})

describe('listChangedRecords over 20,000 records', () => {
  beforeEach(async () => {
    expect(await seedTwentyThousand()).toBe(TOTAL)
  })

  it('listChangedRecords(0) returns every record, once, with the highest rev', async () => {
    const result = await listChangedRecords(0)

    expect(result.maxRev).toBe(TOTAL)
    expect(result.records).toHaveLength(TOTAL)
    expect(new Set(result.records.map((r) => `${r.type}:${r.id}`)).size).toBe(TOTAL)
    const types = new Map<string, number>()
    for (const r of result.records) types.set(r.type, (types.get(r.type) ?? 0) + 1)
    expect(Object.fromEntries(types)).toEqual({
      expense: EXPENSES,
      income: 2000,
      category: 500,
      incomeCategory: 100,
      budget: 300,
      recurring: 100,
    })
  })

  it('a high sinceRev still returns exactly the newest records', async () => {
    const result = await listChangedRecords(TOTAL - 10)

    expect(result.maxRev).toBe(TOTAL)
    expect(result.records).toHaveLength(10)
    // The last ten revs belong to the recurring items.
    expect(result.records.every((r) => r.type === 'recurring')).toBe(true)
  })

  it('reading writes nothing', async () => {
    await listChangedRecords(0)

    expect(ctl.setManyCalls).toHaveLength(0)
  })
})

describe('applyIncomingRecords over 20,000 records', () => {
  it('20,000 new expenses in an empty store: one setMany, every record stored', async () => {
    const records: Array<SyncRecord> = []
    for (let n = 0; n < TOTAL; n++) records.push(expenseRecord(n, NEWER_TIME))

    const result = await applyIncomingRecords(records)

    expect(result).toEqual({ applied: TOTAL, kept: 0, conflicts: 0 })
    expect(ctl.setManyCalls).toHaveLength(1)
    // 20 months, one chunk each.
    expect(ctl.setManyCalls[0]).toHaveLength(TOTAL / PER_CHUNK)
    const sample = await decryptValue(
      dek,
      mockStore.get(ctl.setManyCalls[0][0]) as Uint8Array,
    )
    expect(sample as Array<unknown>).toHaveLength(PER_CHUNK)
    expect(await getLocalRev()).toBe(0)
  })

  describe('against 20,000 local records', () => {
    beforeEach(async () => {
      await seedTwentyThousand()
      ctl.setManyCalls.length = 0
    })

    it('newer, older and new records in one batch of 20,000: counted, one setMany, localRev unchanged', async () => {
      const records: Array<SyncRecord> = []
      // 10,000 newer versions of existing expenses.
      for (let n = 0; n < 10000; n++) {
        records.push(expenseRecord(n, NEWER_TIME, { amount: 1000000 + n }))
      }
      // 7,000 older versions: the local ones win.
      for (let n = 10000; n < EXPENSES; n++) {
        records.push(expenseRecord(n, OLDER_TIME, { amount: -1 }))
      }
      // 3,000 expenses this device has not seen, in existing months.
      for (let n = EXPENSES; n < EXPENSES + 3000; n++) {
        const chunk = n % 17
        records.push({
          type: 'expense',
          id: `fresh-${n}`,
          updatedAt: NEWER_TIME,
          data: {
            id: `fresh-${n}`,
            amount: 3,
            currency: 'UAH',
            categoryId: 'cat-1',
            description: null,
            createdAt: createdAtOf(chunk, (n % 28) + 1),
            updatedAt: NEWER_TIME,
          },
        })
      }
      expect(records).toHaveLength(TOTAL)
      const revBefore = await getLocalRev()

      const result = await applyIncomingRecords(records)

      expect(result).toEqual({ applied: 13000, kept: 7000, conflicts: 0 })
      expect(result.applied + result.kept).toBe(TOTAL)
      expect(ctl.setManyCalls).toHaveLength(1)
      expect(ctl.setManyCalls[0]).not.toContain('meta:sync')
      expect(await getLocalRev()).toBe(revBefore)

      // Spot checks over the stored result.
      const first = (await decryptValue(
        dek,
        mockStore.get('expenses_2025_01') as Uint8Array,
      )) as Array<Expense & { rev?: number }>
      const updated = first.find((e) => e.id === 'e-0')
      expect(updated?.amount).toBe(1000000)
      expect(updated?.updatedAt).toBe(NEWER_TIME)
      expect(updated?.rev).toBeUndefined()
      // e-10500 sits in the 2025-11 chunk and only had an older incoming copy.
      const eleventh = (await decryptValue(
        dek,
        mockStore.get('expenses_2025_11') as Uint8Array,
      )) as Array<Expense & { rev?: number }>
      const untouched = eleventh.find((e) => e.id === 'e-10500')
      expect(untouched?.amount).toBe(10501)
      expect(untouched?.updatedAt).toBe(BASE_TIME)
      expect(untouched?.rev).toBe(10501)
      expect(eleventh.filter((e) => e.id.startsWith('fresh-')).length).toBeGreaterThan(0)
    })

    it('20,000 records that are all older or identical change nothing and write nothing', async () => {
      const records: Array<SyncRecord> = []
      for (let n = 0; n < EXPENSES; n++) {
        records.push(
          n % 2 === 0
            ? expenseRecord(n, OLDER_TIME, { amount: -1 })
            : expenseRecord(n, BASE_TIME),
        )
      }
      // Older copies of every other record: 2,000 income, 500 categories, 100
      // income categories, 300 budgets and 100 recurring items.
      const others: Array<[SyncRecord['type'], string, number]> = [
        ['income', 'inc', 2000],
        ['category', 'cat', 500],
        ['incomeCategory', 'icat', 100],
        ['budget', 'bud', 300],
        ['recurring', 'rec', 100],
      ]
      for (const [type, prefix, count] of others) {
        for (let i = 0; i < count; i++) {
          const id = `${prefix}-${i}`
          records.push({
            type,
            id,
            updatedAt: OLDER_TIME,
            data: { id, createdAt: BASE_TIME, updatedAt: OLDER_TIME },
          })
        }
      }
      expect(records).toHaveLength(TOTAL)

      const result = await applyIncomingRecords(records)

      expect(result.applied).toBe(0)
      expect(result.kept).toBe(TOTAL)
      expect(ctl.setManyCalls).toHaveLength(0)
    })
  })
})
