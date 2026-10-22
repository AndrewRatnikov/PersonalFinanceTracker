// CONTRACT_GAP: the order in which the records of one write get their revs is
//   not part of the Interface Contract; only that they are consecutive and
//   distinct is asserted.
// CONTRACT_GAP: whether `listChangedRecords` skips a record whose rev is above
//   meta:sync.localRev is derived from the plan ("sinceRev < rev <= maxRev");
//   tested as stated.
//
// Integration style (as localDb.incomeCategories.test.ts): real crypto and
// real localDb, idb-keyval backed by a Map with a switch that makes setMany
// reject. Revs are read back by decrypting the raw stored blobs with the key
// the test unlocked the db with.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  BudgetEntry,
  Category,
  Expense,
  IncomeEntry,
  RecurringItem,
} from '@/lib/domain'
import type { SyncChannel } from '@/lib/syncChannel'
import { decryptValue, encryptValue } from '@/lib/crypto'
import {
  DecryptError,
  SETTINGS_DEFAULT_UPDATED_AT,
  SYNCED_SETTINGS_KEY,
  SYNC_META_KEY,
  addCategory,
  addExpense,
  addIncome,
  addIncomeCategory,
  addRecurring,
  addRepeatingExpense,
  addRepeatingIncome,
  applyEntryConversions,
  confirmRecurringOccurrence,
  deleteBudget,
  deleteCategory,
  deleteExpense,
  deleteIncome,
  deleteIncomeCategory,
  deleteRecurring,
  ensureIncomeCategories,
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getAllIncomeCategories,
  getAllRecurring,
  getDueRecurring,
  getExpensesForRange,
  getLocalRev,
  listChangedRecords,
  processDueRecurring,
  provisionDefaultCategories,
  quarantineKey,
  setRecurringPaused,
  skipRecurringOccurrence,
  undeleteExpense,
  unlockLocalDb,
  updateCategory,
  updateExpense,
  updateIncomeCategory,
  updateRecurring,
  upsertBudget,
  wipeLocalDbKey,
} from '@/lib/localDb'
import { setSyncChannel } from '@/lib/syncChannel'

const { mockStore, ctl } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
  ctl: {
    // How many of the next setMany calls reject.
    failSetMany: 0,
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
    if (ctl.failSetMany > 0) {
      ctl.failSetMany--
      return Promise.reject(new Error('transaction aborted'))
    }
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

const T0 = '2026-01-01T09:00:00.000Z'
const T1 = '2026-05-15T10:00:00.000Z'
const T2 = '2026-05-16T10:00:00.000Z'
const TODAY = '2026-05-15'
const MARCH = '2026-03-15T12:00:00.000Z'
const APRIL = '2026-04-10T12:00:00.000Z'
const MARCH_CHUNK = 'expenses_2026_03'
const APRIL_CHUNK = 'expenses_2026_04'

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

async function seed(storageKey: string, value: unknown) {
  mockStore.set(storageKey, await encryptValue(dek, value))
}

async function readRaw<T>(storageKey: string): Promise<Array<T>> {
  const raw = mockStore.get(storageKey)
  if (!(raw instanceof Uint8Array)) throw new Error(`nothing under ${storageKey}`)
  return (await decryptValue(dek, raw)) as Array<T>
}

const DATA_KEY = /^(expenses_\d{4}_\d{2}|categories|incomeCategories|income|budgets|recurring|syncedSettings)$/

interface RawRecord {
  key: string
  record: Record<string, unknown>
}

// Every stored record of every data key, rev included.
async function allRaw(): Promise<Array<RawRecord>> {
  const out: Array<RawRecord> = []
  for (const key of Array.from(mockStore.keys()).sort()) {
    if (!DATA_KEY.test(key)) continue
    const raw = mockStore.get(key)
    if (!(raw instanceof Uint8Array)) continue
    const value = await decryptValue(dek, raw)
    for (const record of Array.isArray(value) ? value : [value]) {
      out.push({ key, record: record as Record<string, unknown> })
    }
  }
  return out
}

// The revs above `n`, ascending, over the whole store.
async function revsAbove(n: number): Promise<Array<number>> {
  return (await allRaw())
    .map((r) => r.record.rev)
    .filter((rev): rev is number => typeof rev === 'number' && rev > n)
    .sort((a, b) => a - b)
}

function range(from: number, count: number): Array<number> {
  return Array.from({ length: count }, (_, i) => from + i)
}

function snapshot(): Map<string, unknown> {
  return new Map(mockStore)
}

function expectUnchanged(before: Map<string, unknown>) {
  expect(Array.from(mockStore.keys()).sort()).toEqual(Array.from(before.keys()).sort())
  for (const [key, value] of before) expect(mockStore.get(key)).toBe(value)
}

function item(overrides: Partial<RecurringItem> = {}): RecurringItem {
  return {
    id: 'r1',
    kind: 'expense',
    amount: 100,
    currency: 'UAH',
    categoryId: 'cat1',
    description: 'Gym',
    frequency: { unit: 'month', interval: 1 },
    startDate: '2026-04-15',
    end: { type: 'never' },
    mode: 'auto',
    paused: false,
    handledThrough: null,
    handledAhead: [],
    occurrenceCount: 0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

function expenseInput(categoryId: string, createdAt = MARCH, amount = 5) {
  return { amount, currency: 'UAH' as const, categoryId, createdAt }
}

beforeEach(async () => {
  mockStore.clear()
  ctl.failSetMany = 0
  ctl.setManyCalls.length = 0
  setSyncChannel(null)
  vi.useFakeTimers({ toFake: ['Date'] })
  setNow(T1)
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  setSyncChannel(undefined)
})

// ── The counter ───────────────────────────────────────────────────────────────

describe('the constants and getLocalRev', () => {
  it('exports the documented names', () => {
    expect(SYNC_META_KEY).toBe('meta:sync')
    expect(SYNCED_SETTINGS_KEY).toBe('syncedSettings')
    expect(SETTINGS_DEFAULT_UPDATED_AT).toBe('1970-01-01T00:00:00.000Z')
  })

  it('is 0 when meta:sync does not exist', async () => {
    expect(await getLocalRev()).toBe(0)
  })

  it('reads the stored counter', async () => {
    mockStore.set('meta:sync', { localRev: 41 })
    expect(await getLocalRev()).toBe(41)

    mockStore.set('meta:sync', { localRev: 7 })
    expect(await getLocalRev()).toBe(7)
  })

  it('works before unlock: the counter is plaintext', async () => {
    mockStore.set('meta:sync', { localRev: 12 })
    wipeLocalDbKey()

    expect(await getLocalRev()).toBe(12)
  })

  it.each([
    ['a string', 'junk'],
    ['an empty object', {}],
    ['a string counter', { localRev: '7' }],
    ['a null counter', { localRev: null }],
  ])('reads %s as 0', async (_name, value) => {
    mockStore.set('meta:sync', value)

    expect(await getLocalRev()).toBe(0)
  })

  it('a write over a junk meta:sync starts counting from 0', async () => {
    mockStore.set('meta:sync', 'junk')

    await addCategory({ name: 'Food' })

    expect(mockStore.get('meta:sync')).toEqual({ localRev: 1 })
    expect(await revsAbove(0)).toEqual([1])
  })

  it('meta:sync is plaintext and holds nothing but the counter', async () => {
    await addCategory({ name: 'Food' })
    await addCategory({ name: 'Rent' })

    expect(mockStore.get('meta:sync')).toEqual({ localRev: 2 })
  })
})

// ── Every user write stamps rev in its own transaction ────────────────────────

interface Case {
  name: string
  // How many records the write creates, changes or soft-deletes.
  touches: number
  // Data keys that must be in the setMany next to meta:sync.
  keys: Array<string>
  // Does the setup and returns the write to measure.
  prepare: () => Promise<() => Promise<unknown>>
}

const CASES: Array<Case> = [
  {
    name: 'addExpense',
    touches: 1,
    keys: [MARCH_CHUNK],
    prepare: async () => () => addExpense(expenseInput('c1')),
  },
  {
    name: 'updateExpense in the same month',
    touches: 1,
    keys: [MARCH_CHUNK],
    prepare: async () => {
      const cat = await addCategory({ name: 'Food' })
      const e = await addExpense(expenseInput(cat.id))
      return () => updateExpense(e.id, e.createdAt, { amount: 9 })
    },
  },
  {
    name: 'updateExpense moving to another month',
    touches: 1,
    keys: [MARCH_CHUNK, APRIL_CHUNK],
    prepare: async () => {
      const cat = await addCategory({ name: 'Food' })
      const e = await addExpense(expenseInput(cat.id))
      return () => updateExpense(e.id, e.createdAt, { createdAt: APRIL })
    },
  },
  {
    name: 'deleteExpense',
    touches: 1,
    keys: [MARCH_CHUNK],
    prepare: async () => {
      const e = await addExpense(expenseInput('c1'))
      return () => deleteExpense(e.id, e.createdAt)
    },
  },
  {
    name: 'undeleteExpense',
    touches: 1,
    keys: [MARCH_CHUNK],
    prepare: async () => {
      const e = await addExpense(expenseInput('c1'))
      await deleteExpense(e.id, e.createdAt)
      return () => undeleteExpense(e.id, e.createdAt)
    },
  },
  {
    name: 'addIncome',
    touches: 1,
    keys: ['income'],
    prepare: async () => () =>
      addIncome({ categoryId: 'ic1', amount: 1, currency: 'UAH' }),
  },
  {
    name: 'deleteIncome',
    touches: 1,
    keys: ['income'],
    prepare: async () => {
      const i = await addIncome({ categoryId: 'ic1', amount: 1, currency: 'UAH' })
      return () => deleteIncome(i.id)
    },
  },
  {
    name: 'addCategory',
    touches: 1,
    keys: ['categories'],
    prepare: async () => () => addCategory({ name: 'Food' }),
  },
  {
    name: 'updateCategory',
    touches: 1,
    keys: ['categories'],
    prepare: async () => {
      const c = await addCategory({ name: 'Food' })
      return () => updateCategory({ id: c.id, name: 'Meals' })
    },
  },
  {
    name: 'updateCategory changing only the default currency',
    touches: 1,
    keys: ['categories'],
    prepare: async () => {
      const c = await addCategory({ name: 'Food' })
      return () => updateCategory({ id: c.id, name: 'Food', defaultCurrency: 'USD' })
    },
  },
  {
    name: 'addIncomeCategory',
    touches: 1,
    keys: ['incomeCategories'],
    prepare: async () => () => addIncomeCategory({ name: 'Salary' }),
  },
  {
    name: 'updateIncomeCategory',
    touches: 1,
    keys: ['incomeCategories'],
    prepare: async () => {
      const c = await addIncomeCategory({ name: 'Salary' })
      return () => updateIncomeCategory({ id: c.id, name: 'Wages' })
    },
  },
  {
    name: 'deleteIncomeCategory',
    touches: 1,
    keys: ['incomeCategories'],
    prepare: async () => {
      const c = await addIncomeCategory({ name: 'Salary' })
      return () => deleteIncomeCategory(c.id)
    },
  },
  {
    name: 'deleteCategory without a budget',
    touches: 1,
    keys: ['categories'],
    prepare: async () => {
      const c = await addCategory({ name: 'Food' })
      return () => deleteCategory(c.id)
    },
  },
  {
    name: 'deleteCategory with a budget (category and budget)',
    touches: 2,
    keys: ['categories', 'budgets'],
    prepare: async () => {
      const c = await addCategory({ name: 'Food' })
      await upsertBudget({ categoryId: c.id, monthlyLimit: 10, currency: 'UAH' })
      return () => deleteCategory(c.id)
    },
  },
  {
    name: 'provisionDefaultCategories (six defaults)',
    touches: 6,
    keys: ['categories'],
    prepare: async () => () => provisionDefaultCategories(),
  },
  {
    name: 'upsertBudget creating',
    touches: 1,
    keys: ['budgets'],
    prepare: async () => () =>
      upsertBudget({ categoryId: 'c1', monthlyLimit: 10, currency: 'UAH' }),
  },
  {
    name: 'upsertBudget updating',
    touches: 1,
    keys: ['budgets'],
    prepare: async () => {
      await upsertBudget({ categoryId: 'c1', monthlyLimit: 10, currency: 'UAH' })
      return () => upsertBudget({ categoryId: 'c1', monthlyLimit: 20, currency: 'UAH' })
    },
  },
  {
    name: 'deleteBudget',
    touches: 1,
    keys: ['budgets'],
    prepare: async () => {
      const b = await upsertBudget({ categoryId: 'c1', monthlyLimit: 10, currency: 'UAH' })
      return () => deleteBudget(b.id)
    },
  },
  {
    name: 'addRecurring with three generated records (item and records)',
    touches: 4,
    keys: ['recurring', 'expenses_2026_03', 'expenses_2026_04', 'expenses_2026_05'],
    prepare: async () => {
      const c = await addCategory({ name: 'Gym' })
      return () =>
        addRecurring(
          {
            kind: 'expense',
            amount: 5,
            currency: 'UAH',
            categoryId: c.id,
            frequency: { unit: 'month', interval: 1 },
            startDate: '2026-03-15',
            end: { type: 'never' },
            mode: 'auto',
          },
          { createThroughToday: true, today: TODAY },
        )
    },
  },
  {
    name: 'addRecurring without generated records',
    touches: 1,
    keys: ['recurring'],
    prepare: async () => {
      const c = await addCategory({ name: 'Gym' })
      return () =>
        addRecurring(
          {
            kind: 'expense',
            amount: 5,
            currency: 'UAH',
            categoryId: c.id,
            frequency: { unit: 'month', interval: 1 },
            startDate: '2026-03-15',
            end: { type: 'never' },
            mode: 'ask',
          },
          { createThroughToday: false, today: TODAY },
        )
    },
  },
  {
    name: 'updateRecurring',
    touches: 1,
    keys: ['recurring'],
    prepare: async () => {
      await seed('categories', [{ id: 'cat1', name: 'Gym', icon: null, updatedAt: T0 }])
      await seed('recurring', [item()])
      return () => updateRecurring('r1', { amount: 7 })
    },
  },
  {
    name: 'setRecurringPaused',
    touches: 1,
    keys: ['recurring'],
    prepare: async () => {
      await seed('recurring', [item()])
      return () => setRecurringPaused('r1', true)
    },
  },
  {
    name: 'deleteRecurring',
    touches: 1,
    keys: ['recurring'],
    prepare: async () => {
      await seed('recurring', [item()])
      return () => deleteRecurring('r1')
    },
  },
  {
    name: 'processDueRecurring (item and two generated records)',
    touches: 3,
    keys: ['recurring', 'expenses_2026_04', 'expenses_2026_05'],
    prepare: async () => {
      await seed('categories', [{ id: 'cat1', name: 'Gym', icon: null, updatedAt: T0 }])
      await seed('recurring', [item()])
      return () => processDueRecurring(TODAY)
    },
  },
  {
    name: 'confirmRecurringOccurrence (item and record)',
    touches: 2,
    keys: ['recurring', 'expenses_2026_04'],
    prepare: async () => {
      await seed('categories', [{ id: 'cat1', name: 'Gym', icon: null, updatedAt: T0 }])
      await seed('recurring', [item({ mode: 'ask' })])
      return () => confirmRecurringOccurrence('r1', '2026-04-15')
    },
  },
  {
    name: 'skipRecurringOccurrence',
    touches: 1,
    keys: ['recurring'],
    prepare: async () => {
      await seed('recurring', [item({ mode: 'ask' })])
      return () => skipRecurringOccurrence('r1', '2026-04-15')
    },
  },
  {
    name: 'addRepeatingExpense (expense and item)',
    touches: 2,
    keys: ['recurring', MARCH_CHUNK],
    prepare: async () => () =>
      addRepeatingExpense(expenseInput('c1', MARCH), 'month'),
  },
  {
    name: 'addRepeatingIncome (income and item)',
    touches: 2,
    keys: ['recurring', 'income'],
    prepare: async () => () =>
      addRepeatingIncome(
        { categoryId: 'ic1', amount: 1, currency: 'UAH', createdAt: MARCH },
        'month',
      ),
  },
  {
    name: 'ensureIncomeCategories (the six defaults get a rev)',
    touches: 6,
    keys: ['incomeCategories', 'income'],
    prepare: async () => () => ensureIncomeCategories(),
  },
]

describe('every user write stamps rev = previous localRev + 1 in the same setMany as meta:sync', () => {
  it.each(CASES)('$name', async ({ prepare, touches, keys }) => {
    const run = await prepare()
    const before = await getLocalRev()
    ctl.setManyCalls.length = 0

    await run()

    // One transaction with the data and the counter together.
    expect(ctl.setManyCalls).toHaveLength(1)
    expect(ctl.setManyCalls[0]).toContain('meta:sync')
    for (const key of keys) expect(ctl.setManyCalls[0]).toContain(key)
    // The counter advanced by the number of records the write touched ...
    expect(await getLocalRev()).toBe(before + touches)
    expect(mockStore.get('meta:sync')).toEqual({ localRev: before + touches })
    // ... and those records carry exactly the new revs, one each.
    expect(await revsAbove(before)).toEqual(range(before + 1, touches))
  })

  it('successive writes keep counting', async () => {
    await addCategory({ name: 'Food' })
    await addIncome({ categoryId: 'ic1', amount: 1, currency: 'UAH' })
    await upsertBudget({ categoryId: 'c1', monthlyLimit: 5, currency: 'UAH' })

    expect(await getLocalRev()).toBe(3)
    expect(await revsAbove(0)).toEqual([1, 2, 3])
  })

  it('a record that is changed again gets a new, higher rev', async () => {
    const cat = await addCategory({ name: 'Food' })
    await addCategory({ name: 'Rent' })
    await updateCategory({ id: cat.id, name: 'Meals' })

    const raw = await readRaw<Category & { rev?: number }>('categories')
    expect(raw.find((c) => c.id === cat.id)?.rev).toBe(3)
    expect(raw.find((c) => c.id !== cat.id)?.rev).toBe(2)
  })

  it('the legacy income rewrite of ensureIncomeCategories gets no rev (only the new categories do)', async () => {
    await seed('income', [
      {
        id: 'l1',
        source: 'Upwork',
        amount: 5,
        currency: 'UAH',
        createdAt: MARCH,
        updatedAt: T0,
      },
    ])

    await ensureIncomeCategories()

    const income = await readRaw<IncomeEntry & { rev?: number }>('income')
    expect(income[0].rev).toBeUndefined()
    expect(await getLocalRev()).toBe(7)
  })

  it('a write that fails validation does not touch the counter', async () => {
    await addCategory({ name: 'Food' })
    ctl.setManyCalls.length = 0

    await expect(addCategory({ name: 'food' })).rejects.toThrow(/already exists/)
    await expect(updateCategory({ id: 'missing', name: 'X' })).rejects.toThrow()

    expect(ctl.setManyCalls).toHaveLength(0)
    expect(await getLocalRev()).toBe(1)
  })
})

// ── No rev in what the app sees ───────────────────────────────────────────────

describe('rev never leaves localDb through the public API', () => {
  function hasRev(value: unknown): boolean {
    return JSON.stringify(value).includes('"rev"')
  }

  it('the stored records do carry it (so the checks below mean something)', async () => {
    await addCategory({ name: 'Food' })

    expect((await readRaw<{ rev?: number }>('categories'))[0].rev).toBe(1)
  })

  it('expenses', async () => {
    const cat = await addCategory({ name: 'Food' })
    const added = await addExpense(expenseInput(cat.id))
    const updated = await updateExpense(added.id, added.createdAt, { amount: 9 })
    await deleteExpense(added.id, added.createdAt)
    const revived = await undeleteExpense(added.id, added.createdAt)

    expect(hasRev(added)).toBe(false)
    expect(hasRev(updated)).toBe(false)
    expect(hasRev(revived)).toBe(false)
    expect(hasRev(await getAllExpenses())).toBe(false)
    expect(
      hasRev(
        await getExpensesForRange('2026-03-01T00:00:00.000Z', '2026-03-31T23:59:59.999Z'),
      ),
    ).toBe(false)
  })

  it('income, categories and budgets', async () => {
    const income = await addIncome({ categoryId: 'ic1', amount: 1, currency: 'UAH' })
    const category = await addCategory({ name: 'Food' })
    const renamed = await updateCategory({ id: category.id, name: 'Meals' })
    const incomeCategory = await addIncomeCategory({ name: 'Salary' })
    const budget = await upsertBudget({
      categoryId: category.id,
      monthlyLimit: 10,
      currency: 'UAH',
    })

    for (const value of [income, category, renamed, incomeCategory, budget]) {
      expect(hasRev(value)).toBe(false)
    }
    expect(hasRev(await getAllIncome())).toBe(false)
    expect(hasRev(await getAllCategories())).toBe(false)
    expect(hasRev(await getAllIncomeCategories())).toBe(false)
    expect(hasRev(await getAllBudgets())).toBe(false)
  })

  it('recurring items and the occurrences built from them', async () => {
    await seed('categories', [{ id: 'cat1', name: 'Gym', icon: null, updatedAt: T0 }])
    const created = await addRecurring(
      {
        kind: 'expense',
        amount: 5,
        currency: 'UAH',
        categoryId: 'cat1',
        frequency: { unit: 'month', interval: 1 },
        startDate: '2026-03-15',
        end: { type: 'never' },
        mode: 'ask',
      },
      { createThroughToday: false, today: '2026-03-01' },
    )
    const updated = await updateRecurring(created.id, { amount: 6 })
    const paused = await setRecurringPaused(created.id, true)

    expect(hasRev(created)).toBe(false)
    expect(hasRev(updated)).toBe(false)
    expect(hasRev(paused)).toBe(false)
    expect(hasRev(await getAllRecurring())).toBe(false)
    await setRecurringPaused(created.id, false, '2026-03-01')
    expect(hasRev(await getDueRecurring('2026-06-20'))).toBe(false)
  })

  it('addRepeatingExpense and addRepeatingIncome', async () => {
    const expense = await addRepeatingExpense(expenseInput('c1'), 'month')
    const income = await addRepeatingIncome(
      { categoryId: 'ic1', amount: 1, currency: 'UAH' },
      'week',
    )

    expect(hasRev(expense)).toBe(false)
    expect(hasRev(income)).toBe(false)
  })
})

// ── Atomicity and concurrency ─────────────────────────────────────────────────

describe('a failure inside setMany leaves the data and meta:sync byte-identical', () => {
  const FAILING: Array<string> = [
    'addExpense',
    'updateExpense moving to another month',
    'deleteExpense',
    'addIncome',
    'upsertBudget creating',
    'deleteCategory with a budget (category and budget)',
    'addRecurring with three generated records (item and records)',
    'processDueRecurring (item and two generated records)',
    'addRepeatingExpense (expense and item)',
    'provisionDefaultCategories (six defaults)',
  ]

  it.each(CASES.filter((c) => FAILING.includes(c.name)))(
    '$name',
    async ({ prepare, touches }) => {
      const run = await prepare()
      const before = snapshot()
      const rev = await getLocalRev()
      const channel = fakeChannel()
      setSyncChannel(channel)
      ctl.failSetMany = 1

      await expect(run()).rejects.toThrow('transaction aborted')

      expectUnchanged(before)
      expect(await getLocalRev()).toBe(rev)
      expect(channel.postMessage).not.toHaveBeenCalled()

      // Nothing was consumed: the retry continues at rev + 1.
      await run()
      expect(await getLocalRev()).toBe(rev + touches)
      expect(await revsAbove(rev)).toEqual(range(rev + 1, touches))
    },
  )

  it('a failed first write leaves no meta:sync behind', async () => {
    ctl.failSetMany = 1

    await expect(addCategory({ name: 'Food' })).rejects.toThrow('transaction aborted')

    expect(mockStore.has('meta:sync')).toBe(false)
    expect(mockStore.has('categories')).toBe(false)
  })
})

describe('concurrent writes get distinct, consecutive revs', () => {
  it('5 concurrent writes into different keys', async () => {
    await Promise.all([
      addExpense(expenseInput('c1', MARCH)),
      addExpense(expenseInput('c1', APRIL)),
      addIncome({ categoryId: 'ic1', amount: 1, currency: 'UAH' }),
      addCategory({ name: 'Food' }),
      upsertBudget({ categoryId: 'c1', monthlyLimit: 5, currency: 'UAH' }),
    ])

    expect(await getLocalRev()).toBe(5)
    expect(await revsAbove(0)).toEqual([1, 2, 3, 4, 5])
  })

  it('5 concurrent writes into the same chunk', async () => {
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) => addExpense(expenseInput('c1', MARCH, n))),
    )

    expect(await getLocalRev()).toBe(5)
    expect(await revsAbove(0)).toEqual([1, 2, 3, 4, 5])
    expect((await readRaw<Expense>(MARCH_CHUNK)).map((e) => e.amount).sort()).toEqual([
      1, 2, 3, 4, 5,
    ])
  })

  it('writes that touch several records still leave no gap and no duplicate', async () => {
    await Promise.all([
      provisionDefaultCategories(),
      addRepeatingExpense(expenseInput('c1', MARCH), 'month'),
      addIncome({ categoryId: 'ic1', amount: 1, currency: 'UAH' }),
    ])

    // 6 defaults + (expense + item) + 1 income.
    expect(await getLocalRev()).toBe(9)
    expect(await revsAbove(0)).toEqual(range(1, 9))
  })

  it('a rejected write among them uses no rev', async () => {
    await addCategory({ name: 'Food' })

    const results = await Promise.allSettled([
      addCategory({ name: 'food' }),
      addCategory({ name: 'Rent' }),
      addCategory({ name: 'Gym' }),
    ])

    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
    expect(await getLocalRev()).toBe(3)
    expect(await revsAbove(0)).toEqual([1, 2, 3])
  })
})

// ── Derived writes ────────────────────────────────────────────────────────────

describe('derived writes do not touch the change counter, rev or updatedAt', () => {
  it('conversion (applyEntryConversions)', async () => {
    const e = await addExpense({
      amount: 20,
      currency: 'USD',
      categoryId: 'c1',
      createdAt: MARCH,
    })
    const rev = await getLocalRev()
    const syncBlob = mockStore.get('meta:sync')
    setNow(T2)

    const written = await applyEntryConversions(MARCH_CHUNK, 'UAH', [
      {
        id: e.id,
        amount: 20,
        currency: 'USD',
        createdAt: MARCH,
        conversion: {
          mainCurrency: 'UAH',
          rate: 41.5,
          mainAmount: 830,
          rateDate: '2026-03-15',
          source: 'nbu',
        },
      },
    ])

    expect(written).toBe(1)
    const [raw] = await readRaw<Expense & { rev?: number }>(MARCH_CHUNK)
    expect(raw.conversion?.mainAmount).toBe(830)
    expect(raw.rev).toBe(1)
    expect(raw.updatedAt).toBe(T1)
    expect(await getLocalRev()).toBe(rev)
    expect(mockStore.get('meta:sync')).toBe(syncBlob)
  })

  it('a conversion of a record that has no rev leaves it without one', async () => {
    await seed(MARCH_CHUNK, [
      { id: 'e1', amount: 20, currency: 'USD', categoryId: 'c1', createdAt: MARCH, updatedAt: T0 },
    ])

    await applyEntryConversions(MARCH_CHUNK, 'UAH', [
      {
        id: 'e1',
        amount: 20,
        currency: 'USD',
        createdAt: MARCH,
        conversion: {
          mainCurrency: 'UAH',
          rate: 41.5,
          mainAmount: 830,
          rateDate: '2026-03-15',
          source: 'nbu',
        },
      },
    ])

    const [raw] = await readRaw<Expense & { rev?: number }>(MARCH_CHUNK)
    expect('rev' in raw).toBe(false)
    expect(raw.updatedAt).toBe(T0)
    expect(mockStore.has('meta:sync')).toBe(false)
  })

  it('quarantine', async () => {
    await addCategory({ name: 'Food' })
    await addExpense(expenseInput('c1'))
    const rev = await getLocalRev()
    const syncBlob = mockStore.get('meta:sync')

    await quarantineKey(MARCH_CHUNK)
    await quarantineKey('categories')

    expect(await getLocalRev()).toBe(rev)
    expect(mockStore.get('meta:sync')).toBe(syncBlob)
  })
})

// ── listChangedRecords ────────────────────────────────────────────────────────

describe('listChangedRecords', () => {
  // One record of every type, with chosen revs.
  async function seedOneOfEach() {
    await seed('expenses_2026_01', [
      {
        id: 'e-jan',
        amount: 1,
        currency: 'UAH',
        categoryId: 'cat',
        createdAt: '2026-01-10T10:00:00.000Z',
        updatedAt: '2026-01-10T10:00:00.000Z',
        rev: 3,
      },
    ])
    await seed('expenses_2026_02', [
      {
        id: 'e-feb-1',
        amount: 2,
        currency: 'UAH',
        categoryId: 'cat',
        createdAt: '2026-02-10T10:00:00.000Z',
        updatedAt: '2026-02-10T10:00:00.000Z',
        rev: 1,
      },
      {
        id: 'e-feb-2',
        amount: 3,
        currency: 'UAH',
        categoryId: 'cat',
        createdAt: '2026-02-11T10:00:00.000Z',
        updatedAt: '2026-02-11T10:00:00.000Z',
        rev: 7,
      },
    ])
    await seed('categories', [{ id: 'cat', name: 'Food', icon: null, updatedAt: T0, rev: 2 }])
    await seed('incomeCategories', [
      { id: 'icat', name: 'Salary', icon: null, updatedAt: T0, rev: 4 },
    ])
    await seed('income', [
      {
        id: 'inc',
        categoryId: 'icat',
        amount: 5,
        currency: 'UAH',
        createdAt: T0,
        updatedAt: T0,
        rev: 5,
      },
    ])
    await seed('budgets', [
      { id: 'bud', categoryId: 'cat', monthlyLimit: 9, currency: 'UAH', updatedAt: T0, rev: 6 },
    ])
    await seed('recurring', [{ ...item({ id: 'rec' }), rev: 8 }])
    await seed('syncedSettings', {
      id: 'settings',
      mainCurrency: 'EUR',
      fetchExchangeRates: false,
      updatedAt: T0,
      rev: 9,
    })
    mockStore.set('meta:sync', { localRev: 9 })
  }

  it('returns every record with a rev above sinceRev, with the type and the highest rev', async () => {
    await seedOneOfEach()

    const result = await listChangedRecords(0)

    expect(result.maxRev).toBe(9)
    expect(result.records).toHaveLength(9)
    expect(Object.keys(result).sort()).toEqual(['maxRev', 'records'])
  })

  it('maps the keys to the types, chunks in key order first, then the single keys in a fixed order', async () => {
    await seedOneOfEach()

    const { records } = await listChangedRecords(-1)

    expect(records.map((r) => [r.type, r.id])).toEqual([
      ['expense', 'e-jan'],
      ['expense', 'e-feb-1'],
      ['expense', 'e-feb-2'],
      ['category', 'cat'],
      ['incomeCategory', 'icat'],
      ['income', 'inc'],
      ['budget', 'bud'],
      ['recurring', 'rec'],
      ['settings', 'settings'],
    ])
  })

  it('returns exactly the records with rev > n, for several n', async () => {
    await seedOneOfEach()

    const above5 = await listChangedRecords(5)
    const above8 = await listChangedRecords(8)
    const above9 = await listChangedRecords(9)

    expect(above5.records.map((r) => r.id)).toEqual(['e-feb-2', 'bud', 'rec', 'settings'])
    expect(above8.records.map((r) => r.id)).toEqual(['settings'])
    expect(above9.records).toEqual([])
    expect([above5.maxRev, above8.maxRev, above9.maxRev]).toEqual([9, 9, 9])
  })

  it('a record whose rev equals sinceRev is not returned, one equal to maxRev is', async () => {
    await seedOneOfEach()

    const ids = (await listChangedRecords(7)).records.map((r) => r.id)

    expect(ids).not.toContain('e-feb-2')
    expect(ids).toEqual(['rec', 'settings'])
  })

  it('does not return a record whose rev is above maxRev (a write still in flight)', async () => {
    await seedOneOfEach()
    await seed('income', [
      {
        id: 'inc',
        categoryId: 'icat',
        amount: 5,
        currency: 'UAH',
        createdAt: T0,
        updatedAt: T0,
        rev: 12,
      },
    ])

    const { records, maxRev } = await listChangedRecords(-1)

    expect(maxRev).toBe(9)
    expect(records.map((r) => r.id)).not.toContain('inc')
  })

  it('a record without a rev counts as rev 0: -1 returns it, 0 does not', async () => {
    await seed('income', [
      { id: 'old', categoryId: 'ic', amount: 5, currency: 'UAH', createdAt: T0, updatedAt: T0 },
    ])

    expect((await listChangedRecords(-1)).records.map((r) => r.id)).toEqual(['old'])
    expect((await listChangedRecords(0)).records).toEqual([])
  })

  it('an empty store gives maxRev 0 and no records', async () => {
    expect(await listChangedRecords(-1)).toEqual({ maxRev: 0, records: [] })
    expect(await listChangedRecords(0)).toEqual({ maxRev: 0, records: [] })
  })

  it('includes tombstones, with deletedAt only on those', async () => {
    const cat = await addCategory({ name: 'Food' })
    const keep = await addExpense(expenseInput(cat.id, MARCH, 1))
    const drop = await addExpense(expenseInput(cat.id, MARCH, 2))
    setNow(T2)
    await deleteExpense(drop.id, drop.createdAt)

    const { records } = await listChangedRecords(0)

    const live = records.find((r) => r.id === keep.id)
    const dead = records.find((r) => r.id === drop.id)
    expect(live).toBeDefined()
    expect(live && 'deletedAt' in live).toBe(false)
    expect(dead?.deletedAt).toBe(T2)
    expect(dead?.updatedAt).toBe(T2)
    expect(dead?.data.deletedAt).toBe(T2)
    expect(dead?.data.amount).toBe(2)
  })

  it('strips rev, conversion and the joined category from data, and keeps the rest', async () => {
    await seed(MARCH_CHUNK, [
      {
        id: 'e1',
        amount: 20,
        currency: 'USD',
        categoryId: 'cat',
        description: 'Lunch',
        createdAt: MARCH,
        updatedAt: T0,
        rev: 4,
        conversion: {
          mainCurrency: 'UAH',
          rate: 41.5,
          mainAmount: 830,
          rateDate: '2026-03-15',
          source: 'nbu',
        },
        manualRate: { mainCurrency: 'UAH', rate: 40 },
        category: { id: 'cat', name: 'Food' },
      },
    ])
    mockStore.set('meta:sync', { localRev: 4 })

    const [record] = (await listChangedRecords(0)).records

    expect(record.type).toBe('expense')
    expect(record.id).toBe('e1')
    expect(record.updatedAt).toBe(T0)
    expect(record.data).toEqual({
      id: 'e1',
      amount: 20,
      currency: 'USD',
      categoryId: 'cat',
      description: 'Lunch',
      createdAt: MARCH,
      updatedAt: T0,
      manualRate: { mainCurrency: 'UAH', rate: 40 },
    })
    expect('rev' in record.data).toBe(false)
    expect('conversion' in record.data).toBe(false)
    expect('category' in record.data).toBe(false)
  })

  it('records written by the app have the same shape (identity conversion and rev stripped)', async () => {
    await addExpense(expenseInput('c1', MARCH, 5))
    expect((await readRaw<Expense & { rev?: number }>(MARCH_CHUNK))[0].conversion).toBeDefined()

    const [record] = (await listChangedRecords(0)).records

    expect('conversion' in record.data).toBe(false)
    expect('rev' in record.data).toBe(false)
    expect(record.data.amount).toBe(5)
  })

  it('the settings record becomes a "settings" record without its rev', async () => {
    await seedOneOfEach()

    const settings = (await listChangedRecords(0)).records.find((r) => r.type === 'settings')

    expect(settings).toEqual({
      type: 'settings',
      id: 'settings',
      updatedAt: T0,
      data: {
        id: 'settings',
        mainCurrency: 'EUR',
        fetchExchangeRates: false,
        updatedAt: T0,
      },
    })
  })

  it('updatedAt falls back to createdAt, then to the epoch default', async () => {
    await seed('income', [
      { id: 'no-updated', categoryId: 'ic', amount: 5, currency: 'UAH', createdAt: T1, rev: 1 },
    ])
    await seed('categories', [{ id: 'bare', name: 'Bare', icon: null, rev: 2 }])
    mockStore.set('meta:sync', { localRev: 2 })

    const { records } = await listChangedRecords(0)

    expect(records.find((r) => r.id === 'no-updated')?.updatedAt).toBe(T1)
    expect(records.find((r) => r.id === 'bare')?.updatedAt).toBe(SETTINGS_DEFAULT_UPDATED_AT)
  })

  it('returns what changed since a given rev, following real writes', async () => {
    const cat = await addCategory({ name: 'Food' })
    const first = await addExpense(expenseInput(cat.id, MARCH, 1))
    const mark = await getLocalRev()
    const second = await addExpense(expenseInput(cat.id, APRIL, 2))
    await updateCategory({ id: cat.id, name: 'Meals' })
    await deleteExpense(first.id, first.createdAt)

    const { records, maxRev } = await listChangedRecords(mark)

    expect(maxRev).toBe(await getLocalRev())
    expect(maxRev).toBe(mark + 3)
    expect(records.map((r) => r.id).sort()).toEqual([cat.id, first.id, second.id].sort())
    expect(records.find((r) => r.id === cat.id)?.data.name).toBe('Meals')
    expect(records.find((r) => r.id === first.id)?.deletedAt).toBeDefined()
  })

  it('listChangedRecords(-1) after a mix of writes is the full snapshot, once per record', async () => {
    const cat = await addCategory({ name: 'Food' })
    await addExpense(expenseInput(cat.id))
    await addIncome({ categoryId: 'ic1', amount: 1, currency: 'UAH' })
    await upsertBudget({ categoryId: cat.id, monthlyLimit: 5, currency: 'UAH' })

    const { records } = await listChangedRecords(-1)

    expect(records.map((r) => r.type).sort()).toEqual([
      'budget',
      'category',
      'expense',
      'income',
    ])
    expect(new Set(records.map((r) => r.id)).size).toBe(4)
  })

  it('reads only: nothing is written or announced, and no lock-free read changes a rev', async () => {
    await addCategory({ name: 'Food' })
    const before = snapshot()
    const channel = fakeChannel()
    setSyncChannel(channel)
    ctl.setManyCalls.length = 0

    await listChangedRecords(0)

    expect(ctl.setManyCalls).toHaveLength(0)
    expect(channel.postMessage).not.toHaveBeenCalled()
    expectUnchanged(before)
  })

  it('a DecryptError propagates', async () => {
    await addCategory({ name: 'Food' })
    mockStore.set(MARCH_CHUNK, new Uint8Array(40))

    await expect(listChangedRecords(0)).rejects.toBeInstanceOf(DecryptError)
  })
})

describe('the budget helper types still line up', () => {
  it('a budget record keeps its fields apart from rev', async () => {
    await upsertBudget({ categoryId: 'c1', monthlyLimit: 5, currency: 'UAH' })

    const [record] = (await listChangedRecords(0)).records
    const data = record.data as unknown as BudgetEntry

    expect(record.type).toBe('budget')
    expect(data.categoryId).toBe('c1')
    expect(data.monthlyLimit).toBe(5)
    expect(data.currency).toBe('UAH')
  })
})
