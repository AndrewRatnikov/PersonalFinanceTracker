// No CONTRACT_GAPs: quarantineKey, hasLocalData and the strict chunk-key filter
// are fully specified in the Interface Contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncChannel } from '@/lib/syncChannel'
import { DecryptError as DecryptErrorFromDataErrors } from '@/lib/dataErrors'
import {
  DecryptError,
  addCategory,
  addExpense,
  addIncome,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getExpensesForRange,
  hasLocalData,
  quarantineKey,
  unlockLocalDb,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore, ops, failures } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ops: [] as Array<string>,
  failures: { setPrefix: null as string | null },
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: (key: string, value: unknown) => {
    if (failures.setPrefix && key.startsWith(failures.setPrefix)) {
      return Promise.reject(new Error('disk full'))
    }
    ops.push(`set:${key}`)
    mockStore.set(key, value)
    return Promise.resolve()
  },
  del: (key: string) => {
    ops.push(`del:${key}`)
    mockStore.delete(key)
    return Promise.resolve()
  },
  clear: () => {
    mockStore.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(mockStore.keys())),
}))

const MARCH = '2024-03-15T12:00:00.000Z'
const APRIL = '2024-04-10T12:00:00.000Z'
const CHUNK = 'expenses_2024_03'
const QUARANTINE_PREFIX = `quarantine:${CHUNK}:`

// 40 bytes of zeros: a Uint8Array that can never be a valid AES-GCM payload.
function garbage(): Uint8Array {
  const bytes = new Uint8Array(40)
  bytes.fill(7, 0, 8)
  return bytes
}

function quarantineKeys(): Array<string> {
  return Array.from(mockStore.keys()).filter((k) => k.startsWith('quarantine:'))
}

async function newKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

describe('localDb quarantine and orphan detection', () => {
  beforeEach(async () => {
    mockStore.clear()
    ops.length = 0
    failures.setPrefix = null
    unlockLocalDb(await newKey())
  })

  afterEach(() => {
    setSyncChannel(undefined)
  })

  it('re-exports the very same DecryptError class', () => {
    expect(DecryptError).toBe(DecryptErrorFromDataErrors)
  })

  describe('a corrupt chunk is never overwritten', () => {
    it('addExpense into the corrupt month rejects with DecryptError and the blob is byte-identical', async () => {
      const bytes = garbage()
      const before = Array.from(bytes)
      mockStore.set(CHUNK, bytes)

      await expect(
        addExpense({
          amount: 5,
          currency: 'UAH',
          categoryId: 'c1',
          createdAt: MARCH,
        }),
      ).rejects.toBeInstanceOf(DecryptError)

      expect(mockStore.get(CHUNK)).toBe(bytes)
      expect(Array.from(mockStore.get(CHUNK) as Uint8Array)).toEqual(before)
      expect(ops.filter((o) => o.startsWith('set:'))).toEqual([])
    })

    it('the error names the corrupt chunk', async () => {
      mockStore.set(CHUNK, garbage())

      const err = await addExpense({
        amount: 5,
        currency: 'UAH',
        categoryId: 'c1',
        createdAt: MARCH,
      }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(DecryptError)
      expect((err as DecryptError).storageKey).toBe(CHUNK)
    })

    it('a healthy month next to the corrupt one still accepts writes', async () => {
      const bytes = garbage()
      mockStore.set(CHUNK, bytes)

      await addExpense({
        amount: 5,
        currency: 'UAH',
        categoryId: 'c1',
        createdAt: APRIL,
      })

      expect(mockStore.get(CHUNK)).toBe(bytes)
      expect(mockStore.has('expenses_2024_04')).toBe(true)
    })
  })

  describe('quarantineKey', () => {
    it('moves the raw blob unchanged to quarantine:<key>:<ISO timestamp> and removes the original', async () => {
      const bytes = garbage()
      mockStore.set(CHUNK, bytes)

      const qKey = await quarantineKey(CHUNK)

      expect(mockStore.has(CHUNK)).toBe(false)
      expect(qKey).not.toBeNull()
      expect(qKey?.startsWith(QUARANTINE_PREFIX)).toBe(true)
      expect(quarantineKeys()).toEqual([qKey])
      const moved = mockStore.get(qKey as string)
      expect(moved).toBe(bytes)
      expect(Array.from(moved as Uint8Array)).toEqual(Array.from(garbage()))
    })

    it('uses an ISO-8601 timestamp suffix', async () => {
      mockStore.set(CHUNK, garbage())
      const before = Date.now()

      const qKey = (await quarantineKey(CHUNK)) as string
      const after = Date.now()

      const suffix = qKey.slice(QUARANTINE_PREFIX.length)
      const parsed = new Date(suffix)
      expect(parsed.toISOString()).toBe(suffix)
      expect(parsed.getTime()).toBeGreaterThanOrEqual(before)
      expect(parsed.getTime()).toBeLessThanOrEqual(after)
    })

    it('writes the quarantine copy before deleting the original', async () => {
      mockStore.set(CHUNK, garbage())

      const qKey = await quarantineKey(CHUNK)

      expect(ops).toEqual([`set:${qKey}`, `del:${CHUNK}`])
    })

    it('never deletes the original when the quarantine copy cannot be written', async () => {
      const bytes = garbage()
      mockStore.set(CHUNK, bytes)
      failures.setPrefix = 'quarantine:'

      await expect(quarantineKey(CHUNK)).rejects.toThrow('disk full')

      expect(mockStore.get(CHUNK)).toBe(bytes)
      expect(ops.filter((o) => o.startsWith('del:'))).toEqual([])
    })

    it('returns null and writes nothing when the key is absent', async () => {
      const result = await quarantineKey(CHUNK)

      expect(result).toBeNull()
      expect(ops).toEqual([])
      expect(mockStore.size).toBe(0)
    })

    it('rejects keys that are not data keys', async () => {
      mockStore.set('something_else', garbage())

      await expect(quarantineKey('something_else')).rejects.toThrow()
      await expect(
        quarantineKey('quarantine:expenses_2024_03:2024-01-01T00:00:00.000Z'),
      ).rejects.toThrow()

      expect(mockStore.has('something_else')).toBe(true)
      expect(ops).toEqual([])
    })

    it('works while the database is locked (no unlock key needed)', async () => {
      const bytes = garbage()
      mockStore.set('categories', bytes)
      wipeLocalDbKey()

      const qKey = await quarantineKey('categories')

      expect(mockStore.has('categories')).toBe(false)
      expect(mockStore.get(qKey as string)).toBe(bytes)
    })

    it('posts a changed message for the quarantined key', async () => {
      mockStore.set(CHUNK, garbage())
      const channel = {
        postMessage: vi.fn<SyncChannel['postMessage']>(),
        addEventListener: vi.fn<SyncChannel['addEventListener']>(),
        removeEventListener: vi.fn<SyncChannel['removeEventListener']>(),
        close: vi.fn<SyncChannel['close']>(),
      }
      setSyncChannel(channel)

      await quarantineKey(CHUNK)

      expect(channel.postMessage).toHaveBeenCalledWith({
        type: 'changed',
        keys: [CHUNK],
      })
    })

    it('after quarantining, getAllExpenses no longer throws', async () => {
      mockStore.set(CHUNK, garbage())
      await expect(getAllExpenses()).rejects.toBeInstanceOf(DecryptError)

      await quarantineKey(CHUNK)

      await expect(getAllExpenses()).resolves.toEqual([])
    })

    it('keeps the healthy months readable after quarantining the corrupt one', async () => {
      const healthy = await addExpense({
        amount: 9,
        currency: 'UAH',
        categoryId: 'c1',
        createdAt: APRIL,
      })
      mockStore.set(CHUNK, garbage())

      await quarantineKey(CHUNK)

      const stored = await getAllExpenses()
      expect(stored.map((e) => e.id)).toEqual([healthy.id])
    })

    it('after quarantining, new writes into that month start a fresh chunk', async () => {
      mockStore.set(CHUNK, garbage())
      const qKey = (await quarantineKey(CHUNK)) as string

      await addExpense({
        amount: 5,
        currency: 'UAH',
        categoryId: 'c1',
        createdAt: MARCH,
      })

      expect(await getAllExpenses()).toHaveLength(1)
      expect(Array.from(mockStore.get(qKey) as Uint8Array)).toEqual(
        Array.from(garbage()),
      )
    })

    it('quarantines single-key stores too', async () => {
      mockStore.set('income', garbage())
      await expect(getAllIncome()).rejects.toBeInstanceOf(DecryptError)

      const qKey = await quarantineKey('income')

      expect(qKey?.startsWith('quarantine:income:')).toBe(true)
      await expect(getAllIncome()).resolves.toEqual([])
      await addIncome({ source: 'Job', amount: 1, currency: 'UAH' })
      expect(await getAllIncome()).toHaveLength(1)
    })
  })

  describe('quarantine:* keys are ignored by readers', () => {
    it('getAllExpenses and getExpensesForRange skip quarantined and stray keys', async () => {
      const kept = await addExpense({
        amount: 3,
        currency: 'UAH',
        categoryId: 'c1',
        createdAt: MARCH,
      })
      mockStore.set(
        'quarantine:expenses_2024_03:2024-05-01T00:00:00.000Z',
        garbage(),
      )
      mockStore.set('expenses_backup', garbage())
      mockStore.set('expenses_2024_03_old', garbage())

      const all = await getAllExpenses()
      const ranged = await getExpensesForRange(
        '2024-03-01T00:00:00.000Z',
        '2024-03-31T23:59:59.999Z',
      )

      expect(all.map((e) => e.id)).toEqual([kept.id])
      expect(ranged.map((e) => e.id)).toEqual([kept.id])
    })

    it('a quarantined categories blob does not affect getAllCategories', async () => {
      const food = await addCategory({ name: 'Food' })
      mockStore.set('quarantine:categories:2024-05-01T00:00:00.000Z', garbage())

      expect((await getAllCategories()).map((c) => c.id)).toEqual([food.id])
    })
  })

  describe('hasLocalData', () => {
    it('is false for an empty store', async () => {
      await expect(hasLocalData()).resolves.toBe(false)
    })

    it.each([
      ['an expenses chunk', 'expenses_2024_03'],
      ['categories', 'categories'],
      ['income', 'income'],
      ['budgets', 'budgets'],
    ])('is true when the store holds %s', async (_name, key) => {
      mockStore.set(key, garbage())

      await expect(hasLocalData()).resolves.toBe(true)
    })

    it('ignores quarantine keys and unrelated keys', async () => {
      mockStore.set(
        'quarantine:expenses_2024_03:2024-05-01T00:00:00.000Z',
        garbage(),
      )
      mockStore.set('something_else', garbage())

      await expect(hasLocalData()).resolves.toBe(false)
    })

    it('does not need the unlock key', async () => {
      mockStore.set('categories', garbage())
      wipeLocalDbKey()

      await expect(hasLocalData()).resolves.toBe(true)
    })

    it('becomes false after the only data key is quarantined', async () => {
      mockStore.set(CHUNK, garbage())
      await quarantineKey(CHUNK)

      await expect(hasLocalData()).resolves.toBe(false)
    })
  })
})
