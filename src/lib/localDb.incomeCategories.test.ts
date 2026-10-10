// No CONTRACT_GAPs for the data layer: the income category CRUD, the delete
// refusal wording, ensureIncomeCategories and prepareUnlockedVault are fully
// specified in the Interface Contract (module: localDb). wipeLocalDbKey is an
// existing localDb export used to simulate a locked app.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IncomeEntry } from '@/lib/domain'
import type { SyncChannel } from '@/lib/syncChannel'
import { decryptValue, encryptValue } from '@/lib/crypto'
import {
  DecryptError,
  addCategory,
  addIncome,
  addIncomeCategory,
  deleteIncome,
  deleteIncomeCategory,
  ensureIncomeCategories,
  getAllCategories,
  getAllIncome,
  getAllIncomeCategories,
  prepareUnlockedVault,
  unlockLocalDb,
  updateIncomeCategory,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: {
    failSetMany: false,
    setManyCalls: [] as Array<Array<string>>,
  },
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
  set: (key: string, value: unknown) => {
    mockStore.set(key, value)
    return Promise.resolve()
  },
  // Applies all entries or none, like an IndexedDB transaction.
  setMany: (entries: Array<[string, unknown]>) => {
    ctl.setManyCalls.push(entries.map(([key]) => key))
    if (ctl.failSetMany) return Promise.reject(new Error('transaction aborted'))
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

const T1 = '2026-06-01T10:00:00.000Z'
const T2 = '2026-06-02T11:30:00.000Z'
const OLD = '2025-02-02T02:02:02.000Z'

const DEFAULT_NAMES = [
  'Salary',
  'Freelance',
  'Gifts',
  'Investments',
  'Refunds',
  'Other',
]

let dek: CryptoKey

function fakeChannel() {
  return {
    postMessage: vi.fn<SyncChannel['postMessage']>(),
    addEventListener: vi.fn<SyncChannel['addEventListener']>(),
    removeEventListener: vi.fn<SyncChannel['removeEventListener']>(),
    close: vi.fn<SyncChannel['close']>(),
  }
}

function postedKeys(channel: ReturnType<typeof fakeChannel>) {
  return channel.postMessage.mock.calls.flatMap((c) => c[0].keys)
}

async function readStored(key: string): Promise<Array<Record<string, unknown>>> {
  const raw = mockStore.get(key)
  if (!(raw instanceof Uint8Array)) throw new Error(`nothing stored under ${key}`)
  return (await decryptValue(dek, raw)) as Array<Record<string, unknown>>
}

// Legacy income: free-text sources and no categoryId, as written before this
// change.
async function seedLegacyIncome(
  rows: Array<{ id: string; source?: string; amount: number; createdAt: string }>,
) {
  const records = rows.map((r) => ({
    id: r.id,
    ...(r.source === undefined ? {} : { source: r.source }),
    amount: r.amount,
    currency: 'UAH',
    description: `note ${r.id}`,
    createdAt: r.createdAt,
    updatedAt: OLD,
  }))
  mockStore.set('income', await encryptValue(dek, records))
}

const LEGACY_ROWS = [
  { id: 'l1', source: 'Salary', amount: 1000, createdAt: '2025-03-01T09:00:00.000Z' },
  { id: 'l2', source: ' salary ', amount: 250.5, createdAt: '2025-03-02T09:00:00.000Z' },
  { id: 'l3', source: 'Upwork', amount: 75, createdAt: '2025-03-03T09:00:00.000Z' },
  { id: 'l4', source: '', amount: 5, createdAt: '2025-03-04T09:00:00.000Z' },
]

beforeEach(async () => {
  mockStore.clear()
  ctl.failSetMany = false
  ctl.setManyCalls.length = 0
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(T1))
})

afterEach(() => {
  vi.useRealTimers()
  setSyncChannel(undefined)
})

describe('income category CRUD: trim and uniqueness', () => {
  it('stores the trimmed name and an icon', async () => {
    const created = await addIncomeCategory({ name: ' Bonus ', icon: '🎯' })

    expect(created.name).toBe('Bonus')
    expect(created.icon).toBe('🎯')
    expect(created.updatedAt).toBe(T1)
    expect(typeof created.id).toBe('string')
    expect(await getAllIncomeCategories()).toEqual([created])
  })

  it('defaults the icon to null and trims a different name differently', async () => {
    const a = await addIncomeCategory({ name: '  Rent' })
    const b = await addIncomeCategory({ name: 'Gym\t' })

    expect(a.name).toBe('Rent')
    expect(b.name).toBe('Gym')
    expect(a.icon).toBeNull()
  })

  it('rejects a duplicate ignoring case and whitespace and stores nothing', async () => {
    await addIncomeCategory({ name: 'Salary' })
    const before = mockStore.get('incomeCategories')

    await expect(addIncomeCategory({ name: ' salary ' })).rejects.toThrow(
      'Category "salary" already exists',
    )
    await expect(addIncomeCategory({ name: 'SALARY' })).rejects.toThrow(
      /already exists/,
    )

    expect(await getAllIncomeCategories()).toHaveLength(1)
    expect(mockStore.get('incomeCategories')).toBe(before)
  })

  it('rejects an empty or whitespace-only name', async () => {
    await expect(addIncomeCategory({ name: '   ' })).rejects.toThrow(
      'Category name is required',
    )
    await expect(addIncomeCategory({ name: '' })).rejects.toThrow(/required/)

    expect(await getAllIncomeCategories()).toEqual([])
  })

  it('still accepts a genuinely different name', async () => {
    await addIncomeCategory({ name: 'Gifts' })
    await addIncomeCategory({ name: 'Gift' })

    expect(await getAllIncomeCategories()).toHaveLength(2)
  })

  it('is separate from the expense categories: the same name may exist in both', async () => {
    await addCategory({ name: 'Other' })
    await addIncomeCategory({ name: 'Other' })

    expect((await getAllCategories()).map((c) => c.name)).toEqual(['Other'])
    expect((await getAllIncomeCategories()).map((c) => c.name)).toEqual(['Other'])
    expect(mockStore.has('categories')).toBe(true)
    expect(mockStore.has('incomeCategories')).toBe(true)
  })

  it('addCategory does not write the incomeCategories key', async () => {
    await addCategory({ name: 'Food' })

    expect(mockStore.has('incomeCategories')).toBe(false)
    expect(await getAllIncomeCategories()).toEqual([])
  })

  it('getAllIncomeCategories returns [] when nothing is stored', async () => {
    expect(await getAllIncomeCategories()).toEqual([])
  })
})

describe('updateIncomeCategory', () => {
  it('renames, stores the trimmed name and the icon, and refreshes updatedAt', async () => {
    const a = await addIncomeCategory({ name: 'Salary', icon: '💼' })
    vi.setSystemTime(new Date(T2))

    const updated = await updateIncomeCategory({
      id: a.id,
      name: ' Wages ',
      icon: '💵',
    })

    expect(updated).toEqual({ id: a.id, name: 'Wages', icon: '💵', updatedAt: T2 })
    expect(await getAllIncomeCategories()).toEqual([updated])
  })

  it('rejects renaming to another income category name and writes nothing', async () => {
    await addIncomeCategory({ name: 'Salary' })
    const b = await addIncomeCategory({ name: 'Gifts' })
    const before = mockStore.get('incomeCategories')

    await expect(
      updateIncomeCategory({ id: b.id, name: 'SALARY' }),
    ).rejects.toThrow(/already exists/)

    expect(mockStore.get('incomeCategories')).toBe(before)
  })

  it('allows a case or spacing change of the own name', async () => {
    const a = await addIncomeCategory({ name: 'Salary' })

    const updated = await updateIncomeCategory({ id: a.id, name: '  sALARY ' })

    expect(updated.name).toBe('sALARY')
  })

  it('rejects an empty name and an unknown id', async () => {
    const a = await addIncomeCategory({ name: 'Salary' })

    await expect(updateIncomeCategory({ id: a.id, name: ' ' })).rejects.toThrow(
      /required/,
    )
    await expect(
      updateIncomeCategory({ id: 'missing', name: 'Whatever' }),
    ).rejects.toThrow('Category not found: missing')

    expect((await getAllIncomeCategories())[0].name).toBe('Salary')
  })

  it('does not touch the expense categories', async () => {
    const expense = await addCategory({ name: 'Salary' })
    const income = await addIncomeCategory({ name: 'Salary' })

    await updateIncomeCategory({ id: income.id, name: 'Wages' })

    expect((await getAllCategories()).find((c) => c.id === expense.id)?.name).toBe(
      'Salary',
    )
  })
})

describe('deleteIncomeCategory', () => {
  it('is refused while one income entry uses the category', async () => {
    const cat = await addIncomeCategory({ name: 'Salary' })
    await addIncome({ categoryId: cat.id, amount: 1, currency: 'UAH' })
    const before = mockStore.get('incomeCategories')

    await expect(deleteIncomeCategory(cat.id)).rejects.toThrow(
      '1 income entry uses this category',
    )

    expect(mockStore.get('incomeCategories')).toBe(before)
    expect(await getAllIncomeCategories()).toHaveLength(1)
  })

  it('is refused with the count while several entries use it', async () => {
    const cat = await addIncomeCategory({ name: 'Salary' })
    await addIncome({ categoryId: cat.id, amount: 1, currency: 'UAH' })
    await addIncome({ categoryId: cat.id, amount: 2, currency: 'UAH' })
    await addIncome({ categoryId: cat.id, amount: 3, currency: 'EUR' })

    await expect(deleteIncomeCategory(cat.id)).rejects.toThrow(
      '3 income entries use this category',
    )
  })

  it('counts only the entries of that category', async () => {
    const a = await addIncomeCategory({ name: 'Salary' })
    const b = await addIncomeCategory({ name: 'Gifts' })
    await addIncome({ categoryId: a.id, amount: 1, currency: 'UAH' })
    await addIncome({ categoryId: b.id, amount: 1, currency: 'UAH' })
    await addIncome({ categoryId: b.id, amount: 2, currency: 'UAH' })

    await expect(deleteIncomeCategory(a.id)).rejects.toThrow(
      '1 income entry uses this category',
    )
    await expect(deleteIncomeCategory(b.id)).rejects.toThrow(
      '2 income entries use this category',
    )
  })

  it('succeeds once no entry uses the category, and removes only that category', async () => {
    const a = await addIncomeCategory({ name: 'Salary' })
    const b = await addIncomeCategory({ name: 'Gifts' })
    const entry = await addIncome({
      categoryId: a.id,
      amount: 1,
      currency: 'UAH',
    })
    await expect(deleteIncomeCategory(a.id)).rejects.toThrow()

    await deleteIncome(entry.id)
    await deleteIncomeCategory(a.id)

    expect((await getAllIncomeCategories()).map((c) => c.id)).toEqual([b.id])
  })

  it('deletes an unused category right away', async () => {
    const a = await addIncomeCategory({ name: 'Salary' })

    await deleteIncomeCategory(a.id)

    expect(await getAllIncomeCategories()).toEqual([])
  })

  it('does not touch the expense categories', async () => {
    const expense = await addCategory({ name: 'Food' })
    const income = await addIncomeCategory({ name: 'Salary' })

    await deleteIncomeCategory(income.id)

    expect((await getAllCategories()).map((c) => c.id)).toEqual([expense.id])
  })
})

describe('income category writes are serialized', () => {
  it('5 concurrent addIncomeCategory() store 5 categories', async () => {
    await Promise.all(
      ['A', 'B', 'C', 'D', 'E'].map((name) => addIncomeCategory({ name })),
    )

    const stored = await getAllIncomeCategories()
    expect(stored.map((c) => c.name).sort()).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(new Set(stored.map((c) => c.id)).size).toBe(5)
  })

  it('concurrent adds of the same name store one and reject the other', async () => {
    const results = await Promise.allSettled([
      addIncomeCategory({ name: 'Salary' }),
      addIncomeCategory({ name: 'salary' }),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(await getAllIncomeCategories()).toHaveLength(1)
  })

  it('updateIncomeCategory() racing addIncomeCategory() keeps both effects', async () => {
    const a = await addIncomeCategory({ name: 'Salary' })

    await Promise.all([
      updateIncomeCategory({ id: a.id, name: 'Wages' }),
      addIncomeCategory({ name: 'Gifts' }),
    ])

    expect((await getAllIncomeCategories()).map((c) => c.name).sort()).toEqual([
      'Gifts',
      'Wages',
    ])
  })

  it('deleteIncomeCategory() racing addIncome() either refuses or leaves no orphan', async () => {
    const a = await addIncomeCategory({ name: 'Salary' })

    const [deleted] = await Promise.allSettled([
      deleteIncomeCategory(a.id),
      addIncome({ categoryId: a.id, amount: 1, currency: 'UAH' }),
    ])

    const categories = await getAllIncomeCategories()
    const income = await getAllIncome()
    if (deleted.status === 'fulfilled') {
      expect(categories).toEqual([])
    } else {
      expect(categories.map((c) => c.id)).toEqual([a.id])
      expect(income).toHaveLength(1)
    }
  })
})

describe('income category broadcasts', () => {
  it('add, update and delete each post the incomeCategories key', async () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    const a = await addIncomeCategory({ name: 'Salary' })
    expect(postedKeys(channel)).toEqual(['incomeCategories'])

    await updateIncomeCategory({ id: a.id, name: 'Wages' })
    expect(postedKeys(channel)).toEqual(['incomeCategories', 'incomeCategories'])

    await deleteIncomeCategory(a.id)
    expect(postedKeys(channel)).toEqual([
      'incomeCategories',
      'incomeCategories',
      'incomeCategories',
    ])
  })

  it('a refused add or delete posts nothing', async () => {
    const a = await addIncomeCategory({ name: 'Salary' })
    await addIncome({ categoryId: a.id, amount: 1, currency: 'UAH' })
    const channel = fakeChannel()
    setSyncChannel(channel)

    await expect(addIncomeCategory({ name: 'salary' })).rejects.toThrow()
    await expect(deleteIncomeCategory(a.id)).rejects.toThrow()

    expect(channel.postMessage).not.toHaveBeenCalled()
  })

  it('also marks a data change in meta:settings', async () => {
    await addIncomeCategory({ name: 'Salary' })

    expect(
      (mockStore.get('meta:settings') as { lastDataChangeAt?: string })
        .lastDataChangeAt,
    ).toBe(T1)
  })
})

describe('income records reference a category', () => {
  it('addIncome stores categoryId only and returns the record with the category joined', async () => {
    const cat = await addIncomeCategory({ name: 'Salary', icon: '💼' })

    const created = await addIncome({
      categoryId: cat.id,
      amount: 100,
      currency: 'USD',
      description: 'March',
      createdAt: '2026-03-01T00:00:00.000Z',
    })

    expect(created.categoryId).toBe(cat.id)
    expect(created.category).toEqual(cat)
    const stored = await readStored('income')
    expect(stored).toHaveLength(1)
    expect(stored[0].categoryId).toBe(cat.id)
    expect('source' in stored[0]).toBe(false)
    expect('category' in stored[0]).toBe(false)
    expect(stored[0].updatedAt).toBe(T1)
    expect(stored[0].createdAt).toBe('2026-03-01T00:00:00.000Z')
  })

  it('getAllIncome joins the category by id', async () => {
    const a = await addIncomeCategory({ name: 'Salary', icon: '💼' })
    const b = await addIncomeCategory({ name: 'Gifts' })
    await addIncome({ categoryId: a.id, amount: 1, currency: 'UAH' })
    await addIncome({ categoryId: b.id, amount: 2, currency: 'UAH' })

    const income = await getAllIncome()

    expect(income.find((i) => i.amount === 1)?.category?.name).toBe('Salary')
    expect(income.find((i) => i.amount === 2)?.category?.name).toBe('Gifts')
    // The joined field is never written back.
    for (const record of await readStored('income')) {
      expect('category' in record).toBe(false)
    }
  })

  it('getAllIncome leaves category undefined for an unknown categoryId', async () => {
    await addIncome({ categoryId: 'gone', amount: 1, currency: 'UAH' })

    const [entry] = await getAllIncome()

    expect(entry.categoryId).toBe('gone')
    expect(entry.category).toBeUndefined()
  })
})

describe('ensureIncomeCategories: legacy conversion', () => {
  it('converts Salary / " salary " / Upwork / "" in one go', async () => {
    await seedLegacyIncome(LEGACY_ROWS)
    vi.setSystemTime(new Date(T2))

    const wrote = await ensureIncomeCategories()

    expect(wrote).toBe(true)
    const categories = await getAllIncomeCategories()
    const names = categories.map((c) => c.name)
    expect(names.filter((n) => n === 'Salary')).toHaveLength(1)
    expect(names.filter((n) => n === 'Upwork')).toHaveLength(1)
    expect([...names].sort()).toEqual(
      [...DEFAULT_NAMES, 'Upwork'].sort(),
    )
    expect(categories.find((c) => c.name === 'Upwork')?.icon).toBeNull()
    expect(categories.find((c) => c.name === 'Freelance')?.icon).toBe('💻')
    expect(categories.find((c) => c.name === 'Other')?.icon).toBe('🪙')
    const nameById = new Map(categories.map((c) => [c.id, c.name]))

    const stored = await readStored('income')
    expect(stored).toHaveLength(4)
    const byId = new Map(stored.map((r) => [r.id as string, r]))
    expect(nameById.get(byId.get('l1')?.categoryId as string)).toBe('Salary')
    expect(nameById.get(byId.get('l2')?.categoryId as string)).toBe('Salary')
    expect(nameById.get(byId.get('l3')?.categoryId as string)).toBe('Upwork')
    expect(nameById.get(byId.get('l4')?.categoryId as string)).toBe('Other')
  })

  it('changes no amount, date, currency or description; converted entries get a new updatedAt and no source', async () => {
    await seedLegacyIncome(LEGACY_ROWS)
    vi.setSystemTime(new Date(T2))

    await ensureIncomeCategories()

    const stored = await readStored('income')
    for (const row of LEGACY_ROWS) {
      const record = stored.find((r) => r.id === row.id)
      expect(record?.amount).toBe(row.amount)
      expect(record?.createdAt).toBe(row.createdAt)
      expect(record?.currency).toBe('UAH')
      expect(record?.description).toBe(`note ${row.id}`)
      expect(record?.updatedAt).toBe(T2)
      expect('source' in (record ?? {})).toBe(false)
    }
  })

  it('every income entry ends up with a valid categoryId (via getAllIncome too)', async () => {
    await seedLegacyIncome(LEGACY_ROWS)

    await ensureIncomeCategories()

    const income = await getAllIncome()
    expect(income).toHaveLength(4)
    for (const entry of income) {
      expect(entry.category).toBeDefined()
      expect(entry.category?.id).toBe(entry.categoryId)
    }
  })

  it('leaves entries that already have a categoryId untouched', async () => {
    const records = [
      {
        id: 'done',
        categoryId: 'ic-x',
        amount: 9,
        currency: 'EUR',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: OLD,
      },
      {
        id: 'old',
        source: 'Gig',
        amount: 1,
        currency: 'UAH',
        createdAt: '2025-01-02T00:00:00.000Z',
        updatedAt: OLD,
      },
    ]
    mockStore.set('income', await encryptValue(dek, records))
    vi.setSystemTime(new Date(T2))

    await ensureIncomeCategories()

    const stored = await readStored('income')
    expect(stored.find((r) => r.id === 'done')).toEqual(records[0])
    const converted = stored.find((r) => r.id === 'old')
    expect(converted?.updatedAt).toBe(T2)
    expect(converted?.categoryId).not.toBe('ic-x')
  })

  it('writes both keys in ONE setMany and announces both keys once', async () => {
    await seedLegacyIncome(LEGACY_ROWS)
    const channel = fakeChannel()
    setSyncChannel(channel)

    await ensureIncomeCategories()

    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...ctl.setManyCalls[0]].sort()).toEqual(
      ['income', 'incomeCategories'].sort(),
    )
    expect(channel.postMessage).toHaveBeenCalledTimes(1)
    expect([...postedKeys(channel)].sort()).toEqual(
      ['income', 'incomeCategories'].sort(),
    )
  })

  it('a failure inside setMany leaves income byte-identical and incomeCategories absent', async () => {
    await seedLegacyIncome(LEGACY_ROWS)
    const incomeBefore = mockStore.get('income') as Uint8Array
    const bytesBefore = Array.from(incomeBefore)
    ctl.failSetMany = true
    const channel = fakeChannel()
    setSyncChannel(channel)

    await expect(ensureIncomeCategories()).rejects.toThrow('transaction aborted')

    expect(mockStore.get('income')).toBe(incomeBefore)
    expect(Array.from(mockStore.get('income') as Uint8Array)).toEqual(bytesBefore)
    expect(mockStore.has('incomeCategories')).toBe(false)
    expect(channel.postMessage).not.toHaveBeenCalled()
  })

  it('a retry after the failed transaction converts normally', async () => {
    await seedLegacyIncome(LEGACY_ROWS)
    ctl.failSetMany = true
    await expect(ensureIncomeCategories()).rejects.toThrow()
    ctl.failSetMany = false

    expect(await ensureIncomeCategories()).toBe(true)

    expect(await getAllIncomeCategories()).toHaveLength(7)
  })
})

describe('ensureIncomeCategories: idempotent', () => {
  it('a second run changes nothing and announces nothing', async () => {
    await seedLegacyIncome(LEGACY_ROWS)
    await ensureIncomeCategories()
    const incomeBlob = mockStore.get('income')
    const categoriesBlob = mockStore.get('incomeCategories')
    const channel = fakeChannel()
    setSyncChannel(channel)
    ctl.setManyCalls.length = 0
    vi.setSystemTime(new Date(T2))

    const wrote = await ensureIncomeCategories()

    expect(wrote).toBe(false)
    expect(mockStore.get('income')).toBe(incomeBlob)
    expect(mockStore.get('incomeCategories')).toBe(categoriesBlob)
    expect(ctl.setManyCalls).toHaveLength(0)
    expect(channel.postMessage).not.toHaveBeenCalled()
  })

  it('an existing incomeCategories list is never converted again, even next to legacy income', async () => {
    await addIncomeCategory({ name: 'Mine' })
    await seedLegacyIncome(LEGACY_ROWS)
    const incomeBlob = mockStore.get('income')

    const wrote = await ensureIncomeCategories()

    expect(wrote).toBe(false)
    expect(mockStore.get('income')).toBe(incomeBlob)
    expect((await getAllIncomeCategories()).map((c) => c.name)).toEqual(['Mine'])
  })

  it('an unreadable incomeCategories blob is neither decrypted nor overwritten', async () => {
    const garbage = new Uint8Array(40)
    mockStore.set('incomeCategories', garbage)
    await seedLegacyIncome(LEGACY_ROWS)
    const incomeBlob = mockStore.get('income')

    const wrote = await ensureIncomeCategories()

    expect(wrote).toBe(false)
    expect(mockStore.get('incomeCategories')).toBe(garbage)
    expect(mockStore.get('income')).toBe(incomeBlob)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('does nothing and returns false while the app is locked', async () => {
    await seedLegacyIncome(LEGACY_ROWS)
    const incomeBlob = mockStore.get('income')
    wipeLocalDbKey()

    expect(await ensureIncomeCategories()).toBe(false)

    expect(mockStore.has('incomeCategories')).toBe(false)
    expect(mockStore.get('income')).toBe(incomeBlob)
    expect(ctl.setManyCalls).toHaveLength(0)
  })
})

describe('ensureIncomeCategories: no income yet and unreadable income', () => {
  it('provisions the six defaults, writes an empty income list and returns true', async () => {
    const channel = fakeChannel()
    setSyncChannel(channel)

    const wrote = await ensureIncomeCategories()

    expect(wrote).toBe(true)
    const categories = await getAllIncomeCategories()
    expect(categories.map((c) => c.name)).toEqual(DEFAULT_NAMES)
    expect(categories.map((c) => c.icon)).toEqual(['💼', '💻', '🎁', '📈', '↩️', '🪙'])
    for (const c of categories) expect(c.updatedAt).toBe(T1)
    expect(await readStored('income')).toEqual([])
    expect(ctl.setManyCalls).toHaveLength(1)
    expect([...postedKeys(channel)].sort()).toEqual(
      ['income', 'incomeCategories'].sort(),
    )
  })

  it('an unreadable income blob propagates DecryptError and nothing is written', async () => {
    const garbage = new Uint8Array(40)
    mockStore.set('income', garbage)

    const err = await ensureIncomeCategories().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DecryptError)
    expect((err as DecryptError).storageKey).toBe('income')
    expect(mockStore.get('income')).toBe(garbage)
    expect(mockStore.has('incomeCategories')).toBe(false)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('concurrent runs convert once', async () => {
    await seedLegacyIncome(LEGACY_ROWS)

    const results = await Promise.all([
      ensureIncomeCategories(),
      ensureIncomeCategories(),
      ensureIncomeCategories(),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(ctl.setManyCalls).toHaveLength(1)
    expect(await getAllIncomeCategories()).toHaveLength(7)
  })
})

describe('prepareUnlockedVault', () => {
  it('a new vault gets the six default expense categories and the six default income categories', async () => {
    await prepareUnlockedVault({ isNewVault: true })

    expect((await getAllCategories()).map((c) => c.name)).toEqual([
      'Food',
      'Transport',
      'Rent',
      'Coffee',
      'Entertainment',
      'Server Costs',
    ])
    const income = await getAllIncomeCategories()
    expect(income.map((c) => c.name)).toEqual(DEFAULT_NAMES)
    expect(income.map((c) => c.icon)).toEqual(['💼', '💻', '🎁', '📈', '↩️', '🪙'])
  })

  it('an existing vault only gets the income conversion, not new expense defaults', async () => {
    await seedLegacyIncome(LEGACY_ROWS)

    await prepareUnlockedVault({ isNewVault: false })

    expect(await getAllCategories()).toEqual([])
    expect(await getAllIncomeCategories()).toHaveLength(7)
    expect((await getAllIncome()).every((i) => i.category !== undefined)).toBe(true)
  })

  it('is safe to run after every unlock: the second run changes nothing', async () => {
    await prepareUnlockedVault({ isNewVault: true })
    const categoriesBlob = mockStore.get('categories')
    const incomeCategoriesBlob = mockStore.get('incomeCategories')
    ctl.setManyCalls.length = 0

    await prepareUnlockedVault({ isNewVault: false })

    expect(mockStore.get('categories')).toBe(categoriesBlob)
    expect(mockStore.get('incomeCategories')).toBe(incomeCategoriesBlob)
    expect(ctl.setManyCalls).toHaveLength(0)
  })

  it('a DecryptError on income propagates and nothing is overwritten', async () => {
    const garbage = new Uint8Array(40)
    mockStore.set('income', garbage)

    await expect(
      prepareUnlockedVault({ isNewVault: false }),
    ).rejects.toBeInstanceOf(DecryptError)

    expect(mockStore.get('income')).toBe(garbage)
    expect(mockStore.has('incomeCategories')).toBe(false)
  })

  it('a DecryptError on the expense categories propagates for a new vault', async () => {
    const garbage = new Uint8Array(40)
    mockStore.set('categories', garbage)

    await expect(
      prepareUnlockedVault({ isNewVault: true }),
    ).rejects.toBeInstanceOf(DecryptError)

    expect(mockStore.get('categories')).toBe(garbage)
  })
})

describe('typing: legacy records keep their shape until converted', () => {
  it('getAllIncome returns an unconverted record as stored (source kept, no category)', async () => {
    await seedLegacyIncome([LEGACY_ROWS[0]])

    const [entry]: Array<IncomeEntry> = await getAllIncome()

    expect(entry.source).toBe('Salary')
    expect(entry.category).toBeUndefined()
    expect(entry.categoryId).toBeUndefined()
  })
})
