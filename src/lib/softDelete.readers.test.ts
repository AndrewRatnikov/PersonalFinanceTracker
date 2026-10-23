// No CONTRACT_GAPs: every reader and computation ignores records whose
// deletedAt is set (Interface Contract, "Readers"). The pure readers get lists
// that contain tombstones; the ones that read the store (analytics, CSV
// export and import, conversion) run on the real localDb over a Map-backed
// idb-keyval, with the tombstones seeded raw.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  BudgetEntry,
  Category,
  Expense,
  IncomeEntry,
  RecurringItem,
} from '@/lib/domain'
import type { RateProvider, RateTable } from '@/lib/rates/types'
import { convertPending, getConversionStatus } from '@/lib/conversion'
import { decryptValue, encryptValue } from '@/lib/crypto'
import { computeDashboardSummary } from '@/lib/dashboardSummary'
import {
  addCategory,
  addExpense,
  addIncome,
  addIncomeCategory,
  deleteCategory,
  deleteExpense,
  deleteIncome,
  deleteIncomeCategory,
  getAllExpenses,
  getAllIncome,
  unlockLocalDb,
} from '@/lib/localDb'
import { buildCsvFiles } from '@/lib/localExport'
import {
  importCategoriesFromCSV,
  importExpensesFromCSV,
  importIncomeFromCSV,
} from '@/lib/localImport'
import { computeRangeAnalytics } from '@/lib/localAnalytics'
import {
  dueOccurrences,
  monthlyTotals,
  monthlyTotalsInMain,
  upcomingOccurrences,
} from '@/lib/recurrence'
import { repeatLastCandidates } from '@/lib/repeatLast'
import { suggestDescriptions } from '@/lib/suggestions'

const { mockStore } = vi.hoisted(() => ({
  mockStore: new Map<string, unknown>(),
}))

vi.mock('idb-keyval', () => ({
  createStore: () => 'mock-store',
  get: (key: string) => Promise.resolve(mockStore.get(key)),
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
  clear: () => {
    mockStore.clear()
    return Promise.resolve()
  },
  keys: () => Promise.resolve(Array.from(mockStore.keys())),
}))

const OLD = '2026-01-05T08:00:00.000Z'
const DELETED = '2026-05-20T08:00:00.000Z'

// Local noon, so the local calendar date is the same in every timezone.
const at = (y: number, m: number, d: number) =>
  new Date(y, m - 1, d, 12, 0, 0).toISOString()

let dek: CryptoKey

async function seed(storageKey: string, value: unknown) {
  mockStore.set(storageKey, await encryptValue(dek, value))
}

async function rawList<T>(storageKey: string): Promise<Array<T>> {
  const raw = mockStore.get(storageKey)
  if (!(raw instanceof Uint8Array)) throw new Error(`nothing under ${storageKey}`)
  return (await decryptValue(dek, raw)) as Array<T>
}

beforeEach(async () => {
  mockStore.clear()
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  unlockLocalDb(dek)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Pure readers ──────────────────────────────────────────────────────────────

function exp(
  id: string,
  createdAt: string,
  amount: number,
  extra: Partial<Expense> = {},
): Expense {
  return {
    id,
    amount,
    currency: 'UAH',
    categoryId: 'c1',
    description: null,
    createdAt,
    updatedAt: createdAt,
    ...extra,
  }
}

function inc(
  id: string,
  createdAt: string,
  amount: number,
  extra: Partial<IncomeEntry> = {},
): IncomeEntry {
  return {
    id,
    categoryId: 'ic1',
    amount,
    currency: 'UAH',
    description: null,
    createdAt,
    updatedAt: createdAt,
    ...extra,
  }
}

function item(overrides: Partial<RecurringItem> = {}): RecurringItem {
  return {
    id: 'r1',
    kind: 'expense',
    amount: 100,
    currency: 'UAH',
    categoryId: 'c1',
    description: null,
    frequency: { unit: 'month', interval: 1 },
    startDate: '2026-02-15',
    end: { type: 'never' },
    mode: 'ask',
    paused: false,
    handledThrough: null,
    handledAhead: [],
    occurrenceCount: 0,
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  }
}

describe('computeDashboardSummary ignores deleted records', () => {
  const now = new Date(2026, 4, 15, 12, 0, 0)
  const categories: Array<Category> = [
    { id: 'c1', name: 'Food', icon: null },
    { id: 'c2', name: 'Rent', icon: null },
  ]
  const liveExpenses = [
    exp('e1', at(2026, 5, 10), 100),
    exp('e2', at(2026, 4, 10), 200),
  ]
  const liveIncome = [inc('i1', at(2026, 5, 10), 1000)]
  const liveBudgets: Array<BudgetEntry> = [
    { id: 'b1', categoryId: 'c1', monthlyLimit: 500, currency: 'UAH', updatedAt: OLD },
  ]

  const deadExpenses = [
    exp('e-dead', at(2026, 5, 12), 900, { deletedAt: DELETED }),
    exp('e-dead-last-month', at(2026, 4, 5), 700, { deletedAt: DELETED }),
    // Would count as pending if it were live.
    exp('e-dead-usd', at(2026, 5, 13), 5, { currency: 'USD', deletedAt: DELETED }),
  ]
  const deadIncome = [inc('i-dead', at(2026, 5, 11), 5000, { deletedAt: DELETED })]
  const deadBudgets: Array<BudgetEntry> = [
    {
      id: 'b-dead',
      categoryId: 'c2',
      monthlyLimit: 9999,
      currency: 'UAH',
      updatedAt: OLD,
      deletedAt: DELETED,
    },
    {
      id: 'b-dead-usd',
      categoryId: 'c1',
      monthlyLimit: 1,
      currency: 'USD',
      updatedAt: OLD,
      deletedAt: DELETED,
    },
  ]

  it('gives the same summary as the live records alone', () => {
    const clean = computeDashboardSummary({
      expenses: liveExpenses,
      income: liveIncome,
      budgets: liveBudgets,
      categories,
      now,
      mainCurrency: 'UAH',
    })

    const withTombstones = computeDashboardSummary({
      expenses: [...liveExpenses, ...deadExpenses],
      income: [...liveIncome, ...deadIncome],
      budgets: [...liveBudgets, ...deadBudgets],
      categories,
      now,
      mainCurrency: 'UAH',
    })

    expect(withTombstones).toEqual(clean)
  })

  it('and that summary is the one of the live data (so the comparison means something)', () => {
    const summary = computeDashboardSummary({
      expenses: [...liveExpenses, ...deadExpenses],
      income: [...liveIncome, ...deadIncome],
      budgets: [...liveBudgets, ...deadBudgets],
      categories,
      now,
      mainCurrency: 'UAH',
    })

    expect(summary.monthExpenses).toBe(100)
    expect(summary.monthIncome).toBe(1000)
    expect(summary.net).toBe(900)
    expect(summary.pendingCount).toBe(0)
    expect(summary.budgetsExcluded).toBe(0)
    expect(summary.leftToSpend).toBe(400)
    expect(summary.budgetWatch.map((b) => b.categoryId)).toEqual(['c1'])
    expect(summary.pace.lastMonthSameDay).toBe(200)
    expect(summary.recent.map((r) => r.id).sort()).toEqual(['e1', 'e2', 'i1'])
  })
})

describe('suggestDescriptions ignores deleted entries', () => {
  const now = new Date(2026, 4, 15, 12, 0, 0)

  it('does not suggest a description that only exists on a deleted entry', () => {
    const result = suggestDescriptions(
      [
        {
          description: 'Taxi to the airport',
          categoryId: 'c1',
          amount: 40,
          currency: 'UAH',
          createdAt: at(2026, 5, 14),
          deletedAt: DELETED,
        },
        {
          description: 'Coffee',
          categoryId: 'c1',
          amount: 5,
          currency: 'UAH',
          createdAt: at(2026, 5, 13),
        },
      ],
      { query: '', now },
    )

    expect(result.map((s) => s.description)).toEqual(['Coffee'])
    expect(suggestDescriptions([], { query: 'taxi', now })).toEqual([])
  })

  it('a deleted entry does not count, and does not become the representative', () => {
    const result = suggestDescriptions(
      [
        {
          description: 'Coffee',
          categoryId: 'c1',
          amount: 99,
          currency: 'UAH',
          createdAt: at(2026, 5, 14),
          deletedAt: DELETED,
        },
        {
          description: 'Coffee',
          categoryId: 'c1',
          amount: 5,
          currency: 'UAH',
          createdAt: at(2026, 5, 10),
        },
      ],
      { query: 'cof', now },
    )

    expect(result).toHaveLength(1)
    expect(result[0].amount).toBe(5)
    expect(result[0].count).toBe(1)
    expect(result[0].lastUsed).toBe(at(2026, 5, 10))
  })
})

describe('repeatLastCandidates ignores deleted expenses', () => {
  const now = new Date(2026, 4, 15, 12, 0, 0)

  it('a deleted newest expense is not offered, the older live one is', () => {
    const result = repeatLastCandidates(
      [
        exp('dead', at(2026, 5, 14), 80, { description: 'Dinner', deletedAt: DELETED }),
        exp('live', at(2026, 5, 10), 50, { description: 'Lunch' }),
      ],
      { now },
    )

    expect(result.map((c) => c.description)).toEqual(['Lunch'])
  })

  it('a deleted copy does not move lastUsed of a live candidate', () => {
    const result = repeatLastCandidates(
      [
        exp('dead', at(2026, 5, 14), 50, { description: 'Lunch', deletedAt: DELETED }),
        exp('live', at(2026, 5, 10), 50, { description: 'Lunch' }),
      ],
      { now },
    )

    expect(result).toHaveLength(1)
    expect(result[0].lastUsed).toBe(at(2026, 5, 10))
  })
})

describe('the recurrence readers ignore deleted items', () => {
  it('dueOccurrences skips a deleted ask-mode item', () => {
    const due = dueOccurrences(
      [item({ id: 'live' }), item({ id: 'dead', deletedAt: DELETED })],
      '2026-04-20',
    )

    expect(due.length).toBeGreaterThan(0)
    expect(due.every((d) => d.item.id === 'live')).toBe(true)
  })

  it('upcomingOccurrences skips a deleted item', () => {
    const upcoming = upcomingOccurrences(
      [
        item({ id: 'live', mode: 'auto', startDate: '2026-05-20' }),
        item({ id: 'dead', mode: 'auto', startDate: '2026-05-20', deletedAt: DELETED }),
      ],
      '2026-05-18',
    )

    expect(upcoming.map((u) => u.item.id)).toEqual(['live'])
  })

  it('monthlyTotals leaves a deleted item out', () => {
    const live = item({ id: 'live', amount: 100, mode: 'auto' })
    const dead = item({ id: 'dead', amount: 900, mode: 'auto', deletedAt: DELETED })

    const totals = monthlyTotals([live, dead], '2026-05-15')

    expect(totals).toEqual(monthlyTotals([live], '2026-05-15'))
    expect(totals).toEqual([{ kind: 'expense', currency: 'UAH', total: 100 }])
  })

  it('monthlyTotalsInMain leaves a deleted item out, so it needs no rate for it', () => {
    const live = item({ id: 'live', amount: 100, mode: 'auto' })
    const deadUsd = item({
      id: 'dead',
      amount: 5,
      currency: 'USD',
      mode: 'auto',
      deletedAt: DELETED,
    })

    const totals = monthlyTotalsInMain([live, deadUsd], '2026-05-15', 'UAH', null)

    expect(totals).toEqual([{ kind: 'expense', total: 100, approximate: false }])
  })
})

// ── Analytics ─────────────────────────────────────────────────────────────────

describe('computeRangeAnalytics ignores deleted records', () => {
  it('totals, breakdowns, timeline and budget variance cover the live records only', async () => {
    await seed('categories', [
      { id: 'c1', name: 'Food', icon: '🍔', updatedAt: OLD },
      { id: 'c2', name: 'Gone', icon: null, updatedAt: OLD, deletedAt: DELETED },
    ])
    await seed('incomeCategories', [
      { id: 'ic1', name: 'Salary', icon: null, updatedAt: OLD },
    ])
    await seed('expenses_2026_05', [
      exp('e1', at(2026, 5, 10), 100),
      exp('e-dead', at(2026, 5, 12), 900, { deletedAt: DELETED }),
      exp('e-dead-other', at(2026, 5, 12), 50, { categoryId: 'c2', deletedAt: DELETED }),
      exp('e-dead-usd', at(2026, 5, 13), 5, { currency: 'USD', deletedAt: DELETED }),
    ])
    await seed('income', [
      inc('i1', at(2026, 5, 10), 1000),
      inc('i-dead', at(2026, 5, 11), 5000, { deletedAt: DELETED }),
    ])
    await seed('budgets', [
      { id: 'b1', categoryId: 'c1', monthlyLimit: 500, currency: 'UAH', updatedAt: OLD },
      {
        id: 'b-dead',
        categoryId: 'c1',
        monthlyLimit: 600,
        currency: 'UAH',
        updatedAt: OLD,
        deletedAt: DELETED,
      },
      {
        id: 'b-dead-usd',
        categoryId: 'c1',
        monthlyLimit: 1,
        currency: 'USD',
        updatedAt: OLD,
        deletedAt: DELETED,
      },
    ])

    const analytics = await computeRangeAnalytics(
      { from: '2026-05-01', to: '2026-05-31' },
      'UAH',
    )

    expect(analytics.categoryBreakdown).toHaveLength(1)
    expect(analytics.categoryBreakdown[0]).toMatchObject({ categoryId: 'c1', total: 100 })
    expect(analytics.timeline.map((p) => p.total)).toEqual([100])
    expect(analytics.totalIncome).toBe(1000)
    expect(analytics.incomeBreakdown.map((i) => i.total)).toEqual([1000])
    expect(analytics.pendingCount).toBe(0)
    expect(analytics.budgetsExcluded).toBe(0)
    expect(analytics.budgetVariance).toHaveLength(1)
    expect(analytics.budgetVariance[0]).toMatchObject({ categoryId: 'c1', actual: 100 })
  })

  it('deleting through the API gives the same result', async () => {
    const cat = await addCategory({ name: 'Food' })
    const jobs = await addIncomeCategory({ name: 'Job' })
    const keep = await addExpense({
      amount: 100,
      currency: 'UAH',
      categoryId: cat.id,
      createdAt: at(2026, 5, 10),
    })
    const drop = await addExpense({
      amount: 900,
      currency: 'UAH',
      categoryId: cat.id,
      createdAt: at(2026, 5, 12),
    })
    const pay = await addIncome({
      categoryId: jobs.id,
      amount: 1000,
      currency: 'UAH',
      createdAt: at(2026, 5, 10),
    })
    const bonus = await addIncome({
      categoryId: jobs.id,
      amount: 5000,
      currency: 'UAH',
      createdAt: at(2026, 5, 11),
    })
    const range = { from: '2026-05-01', to: '2026-05-31' }
    const before = await computeRangeAnalytics(range, 'UAH')
    expect(before.categoryBreakdown[0].total).toBe(1000)
    expect(before.totalIncome).toBe(6000)

    await deleteExpense(drop.id, drop.createdAt)
    await deleteIncome(bonus.id)

    const after = await computeRangeAnalytics(range, 'UAH')
    expect(after.categoryBreakdown[0].total).toBe(100)
    expect(after.totalIncome).toBe(1000)
    expect((await getAllExpenses()).map((e) => e.id)).toEqual([keep.id])
    expect((await getAllIncome()).map((i) => i.id)).toEqual([pay.id])
  })
})

// ── CSV export ────────────────────────────────────────────────────────────────

describe('buildCsvFiles skips deleted records', () => {
  it('leaves every tombstone out of all four files and adds no column', async () => {
    await seed('categories', [
      { id: 'c1', name: 'Food', icon: '🍔', updatedAt: OLD, rev: 1 },
      { id: 'c2', name: 'Gone', icon: '💀', updatedAt: OLD, deletedAt: DELETED, rev: 2 },
    ])
    await seed('incomeCategories', [
      { id: 'ic1', name: 'Salary', icon: null, updatedAt: OLD },
      { id: 'ic2', name: 'Gone income', icon: null, updatedAt: OLD, deletedAt: DELETED },
    ])
    await seed('expenses_2026_05', [
      exp('e1', at(2026, 5, 10), 100, { description: 'Lunch', rev: 3 }),
      exp('e2', at(2026, 5, 11), 900, { description: 'Dinner', deletedAt: DELETED }),
    ])
    await seed('income', [
      inc('i1', at(2026, 5, 10), 1000, { description: 'Pay' }),
      inc('i2', at(2026, 5, 11), 5000, { description: 'Bonus', deletedAt: DELETED }),
    ])
    await seed('budgets', [
      { id: 'b1', categoryId: 'c1', monthlyLimit: 500, currency: 'UAH', updatedAt: OLD },
      {
        id: 'b2',
        categoryId: 'c2',
        monthlyLimit: 777,
        currency: 'UAH',
        updatedAt: OLD,
        deletedAt: DELETED,
      },
    ])

    const files = await buildCsvFiles()

    expect(files['expenses.csv'].split('\n')).toEqual([
      '"date","amount","currency","category","description","main_amount","main_currency"',
      '"2026-05-10","100","UAH","Food","Lunch","100","UAH"',
    ])
    expect(files['income.csv'].split('\n')).toEqual([
      '"date","source","amount","currency","description","main_amount","main_currency"',
      '"2026-05-10","Salary","1000","UAH","Pay","1000","UAH"',
    ])
    expect(files['categories.csv'].split('\n')).toEqual(['"name","icon"', '"Food","🍔"'])
    expect(files['budgets.csv'].split('\n')).toEqual([
      '"category","monthly_limit","currency"',
      '"Food","500","UAH"',
    ])
    for (const csv of Object.values(files)) {
      expect(csv).not.toContain('rev')
      expect(csv).not.toContain('deletedAt')
      expect(csv).not.toContain('Gone')
      expect(csv).not.toContain('Dinner')
    }
  })
})

// ── CSV import ────────────────────────────────────────────────────────────────

describe('CSV import never sees deleted records', () => {
  const EXPENSE_HEADER = 'date,amount,currency,category,description'
  const INCOME_HEADER = 'date,source,amount,currency,description'

  it('a row equal to a deleted expense is not a duplicate; one equal to a live expense is', async () => {
    const cat = await addCategory({ name: 'Food' })
    const live = await addExpense({
      amount: 5,
      currency: 'UAH',
      categoryId: cat.id,
      description: 'live',
      createdAt: at(2024, 3, 10),
    })
    const dead = await addExpense({
      amount: 7,
      currency: 'UAH',
      categoryId: cat.id,
      description: 'dead',
      createdAt: at(2024, 3, 11),
    })
    await deleteExpense(dead.id, dead.createdAt)

    const result = await importExpensesFromCSV(
      [
        EXPENSE_HEADER,
        '2024-03-10,5,UAH,Food,live',
        '2024-03-11,7,UAH,Food,dead',
      ].join('\n'),
    )

    expect(result.duplicates).toBe(1)
    expect(result.duplicateRows).toEqual([2])
    expect(result.inserted).toBe(1)
    const ids = (await getAllExpenses()).map((e) => e.id)
    expect(ids).toContain(live.id)
    expect(ids).not.toContain(dead.id)
    expect(ids).toHaveLength(2)
  })

  it('a row for a deleted category is an unknown category', async () => {
    const kept = await addCategory({ name: 'Rent' })
    const gone = await addCategory({ name: 'Food' })
    await deleteCategory(gone.id)

    const result = await importExpensesFromCSV(
      [EXPENSE_HEADER, '2024-03-10,5,UAH,Food,x', '2024-03-10,6,UAH,Rent,y'].join('\n'),
    )

    expect(result.inserted).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.rowErrors).toEqual([
      { row: 2, code: 'unknown-category', value: 'Food' },
    ])
    expect((await getAllExpenses())[0].categoryId).toBe(kept.id)
  })

  it('importing expenses when every category is deleted asks for categories first', async () => {
    const gone = await addCategory({ name: 'Food' })
    await deleteCategory(gone.id)

    await expect(
      importExpensesFromCSV([EXPENSE_HEADER, '2024-03-10,5,UAH,Food,x'].join('\n')),
    ).rejects.toMatchObject({ code: 'import-needs-categories' })
  })

  it('importing a category whose name was deleted creates it again, with a new id', async () => {
    const gone = await addCategory({ name: 'Food' })
    await deleteCategory(gone.id)

    const result = await importCategoriesFromCSV('name,icon\nFood,🍔')

    expect(result.inserted).toBe(1)
    const raw = await rawList<{ id: string; name: string }>('categories')
    expect(raw.filter((c) => c.name === 'Food')).toHaveLength(2)
  })

  it('an income row equal to a deleted entry is not a duplicate', async () => {
    const job = await addIncomeCategory({ name: 'Job' })
    const dead = await addIncome({
      categoryId: job.id,
      amount: 100,
      currency: 'UAH',
      description: 'x',
      createdAt: at(2024, 3, 10),
    })
    await deleteIncome(dead.id)

    const result = await importIncomeFromCSV(
      [INCOME_HEADER, '2024-03-10,Job,100,UAH,x'].join('\n'),
    )

    expect(result.duplicates).toBe(0)
    expect(result.inserted).toBe(1)
    expect(await getAllIncome()).toHaveLength(1)
  })

  it('an income row for a deleted income category creates a new category with a new id', async () => {
    const dead = await addIncomeCategory({ name: 'Job' })
    await deleteIncomeCategory(dead.id)

    const result = await importIncomeFromCSV(
      [INCOME_HEADER, '2024-03-10,Job,100,UAH,x'].join('\n'),
    )

    expect(result.inserted).toBe(1)
    expect(result.createdCategories).toBe(1)
    const [entry] = await getAllIncome()
    expect(entry.categoryId).not.toBe(dead.id)
    expect(entry.category?.name).toBe('Job')
  })
})

// ── Conversion ────────────────────────────────────────────────────────────────

describe('conversion ignores deleted entries', () => {
  const OCT_14 = at(2026, 10, 14)
  const OCT_13 = at(2026, 10, 13)
  const OCT_CHUNK = 'expenses_2026_10'
  const TODAY = '2026-10-15'

  function provider() {
    const calls: Array<string> = []
    const table = (date: string): RateTable => ({
      base: 'UAH',
      effectiveDate: date,
      perBase: { UAH: 1, USD: 41.52, EUR: 45.1 },
    })
    const rateProvider: RateProvider = {
      id: 'nbu',
      getRates: vi.fn((date: string) => {
        calls.push(date)
        return Promise.resolve(table(date))
      }),
    }
    return { rateProvider, calls }
  }

  async function seedMixed() {
    await seed(OCT_CHUNK, [
      exp('live', OCT_14, 20, { currency: 'USD' }),
      exp('dead', OCT_13, 30, { currency: 'USD', deletedAt: DELETED }),
    ])
    await seed('income', [
      inc('dead-income', OCT_13, 50, { currency: 'EUR', deletedAt: DELETED }),
    ])
  }

  it('convertPending converts live entries only and never asks for the rates of a deleted one', async () => {
    await seedMixed()
    const { rateProvider, calls } = provider()

    const result = await convertPending({ provider: rateProvider, today: TODAY })

    expect(result).toEqual({ converted: 1, stillPending: 0 })
    expect(calls).toEqual(['2026-10-14'])
  })

  it('a deleted entry stays unconverted in the store', async () => {
    await seedMixed()
    const { rateProvider } = provider()

    await convertPending({ provider: rateProvider, today: TODAY })

    const stored = await rawList<Expense>(OCT_CHUNK)
    expect(stored.find((e) => e.id === 'live')?.conversion).toBeDefined()
    expect(stored.find((e) => e.id === 'dead')?.conversion).toBeUndefined()
    const income = await rawList<IncomeEntry>('income')
    expect(income[0].conversion).toBeUndefined()
  })

  it('getConversionStatus counts live entries and budgets only', async () => {
    await seedMixed()
    await seed('budgets', [
      { id: 'b-live', categoryId: 'c1', monthlyLimit: 5, currency: 'USD', updatedAt: OLD },
      {
        id: 'b-dead',
        categoryId: 'c2',
        monthlyLimit: 5,
        currency: 'USD',
        updatedAt: OLD,
        deletedAt: DELETED,
      },
    ])

    const status = await getConversionStatus()

    expect(status.totalEntries).toBe(1)
    expect(status.pendingEntries).toBe(1)
    expect(status.pendingBudgets).toBe(1)
  })

  it('when only deleted entries are pending, nothing is pending and no rate is requested', async () => {
    await seed(OCT_CHUNK, [
      exp('dead', OCT_13, 30, { currency: 'USD', deletedAt: DELETED }),
    ])
    const { rateProvider, calls } = provider()

    const result = await convertPending({ provider: rateProvider, today: TODAY })

    expect(result).toEqual({ converted: 0, stillPending: 0 })
    expect(calls).toEqual([])
    expect((await getConversionStatus()).pendingEntries).toBe(0)
  })
})
