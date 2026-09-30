// No CONTRACT_GAPs: the Interface Contract for `computeDashboardSummary` /
// `getBudgetStatus` (src/lib/dashboardSummary.ts) fully specifies exports,
// field names and formulas.

import { describe, expect, it } from 'vitest'

import type { BudgetEntry, Category, Currency, Expense, IncomeEntry } from '@/lib/domain'
import { computeDashboardSummary, getBudgetStatus } from '@/lib/dashboardSummary'

// ---- fixture helpers -------------------------------------------------

let nextId = 0
const id = (prefix: string) => `${prefix}-${++nextId}`

// Local time constructor, per the contract's testing notes, so fixtures
// don't depend on the host timezone.
const dateAt = (y: number, m: number, d: number, h = 12) =>
  new Date(y, m, d, h, 0, 0).toISOString()

function mkExpense(
  amount: number,
  currency: Currency,
  categoryId: string,
  createdAt: string,
  overrideId?: string,
): Expense {
  return { id: overrideId ?? id('exp'), amount, currency, categoryId, createdAt }
}

function mkIncome(
  amount: number,
  currency: Currency,
  createdAt: string,
  overrideId?: string,
): IncomeEntry {
  return { id: overrideId ?? id('inc'), source: 'Salary', amount, currency, createdAt }
}

function mkBudget(
  categoryId: string,
  monthlyLimit: number,
  currency: Currency = 'UAH',
  overrideId?: string,
): BudgetEntry {
  return { id: overrideId ?? id('budget'), categoryId, monthlyLimit, currency }
}

const catFood: Category = { id: 'cat-food', name: 'Food' }
const catTransport: Category = { id: 'cat-transport', name: 'Transport' }

// ---- getBudgetStatus ---------------------------------------------------

describe('getBudgetStatus', () => {
  it('returns "ok" below 0.8', () => {
    expect(getBudgetStatus(0)).toBe('ok')
    expect(getBudgetStatus(0.79)).toBe('ok')
  })

  it('returns "warning" at the 0.8 boundary (inclusive)', () => {
    expect(getBudgetStatus(0.8)).toBe('warning')
  })

  it('returns "warning" between 0.8 and 1.0, including the 1.0 boundary', () => {
    expect(getBudgetStatus(0.95)).toBe('warning')
    expect(getBudgetStatus(1.0)).toBe('warning')
  })

  it('returns "over" above 1.0', () => {
    expect(getBudgetStatus(1.01)).toBe('over')
    expect(getBudgetStatus(2)).toBe('over')
  })
})

// ---- criterion 2: month + year totals (bug 1 fix) -----------------------

describe('criterion 2: this-month totals exclude the same month in an earlier year (bug 1)', () => {
  it('sums only entries whose createdAt is in now\'s calendar month AND year', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0) // July 2026

    const expenses = [
      mkExpense(100, 'UAH', catFood.id, dateAt(2026, 6, 10)), // this month -> included
      mkExpense(50, 'UAH', catFood.id, dateAt(2025, 6, 10)), // same month, earlier year -> excluded
      mkExpense(30, 'UAH', catFood.id, dateAt(2026, 5, 20)), // different month -> excluded
    ]
    const income = [
      mkIncome(200, 'UAH', dateAt(2026, 6, 5)), // this month -> included
      mkIncome(80, 'UAH', dateAt(2024, 6, 5)), // same month, earlier year -> excluded
    ]

    const result = computeDashboardSummary({
      expenses,
      income,
      budgets: [],
      categories: [],
      now,
    })

    expect(result.monthExpenses).toBe(100)
    expect(result.monthIncome).toBe(200)
    expect(result.net).toBe(100)
  })

  it('produces a different total when the in-month entry changes (falsifiable)', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0)
    const expenses = [mkExpense(999, 'UAH', catFood.id, dateAt(2026, 6, 1))]
    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets: [],
      categories: [],
      now,
    })
    expect(result.monthExpenses).toBe(999)
  })
})

// ---- criterion 3: excluded per-currency totals (bug 2 fix) --------------

describe('criterion 3: non-base-currency this-month entries land in excluded, not totals (bug 2)', () => {
  it('groups non-base entries by currency, sorted ascending, and keeps totals base-currency only', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0)
    const expenses = [
      mkExpense(100, 'UAH', catFood.id, dateAt(2026, 6, 10)),
      mkExpense(120, 'USD', catFood.id, dateAt(2026, 6, 10)),
      mkExpense(30, 'EUR', catFood.id, dateAt(2026, 6, 10)),
      // Different month, non-base currency: must not appear in excluded at all.
      mkExpense(999, 'USD', catFood.id, dateAt(2026, 5, 10)),
    ]
    const income = [
      mkIncome(500, 'UAH', dateAt(2026, 6, 5)),
      mkIncome(50, 'EUR', dateAt(2026, 6, 5)),
    ]

    const result = computeDashboardSummary({
      expenses,
      income,
      budgets: [],
      categories: [],
      now,
    })

    expect(result.monthExpenses).toBe(100)
    expect(result.monthIncome).toBe(500)
    expect(result.excluded).toEqual([
      { currency: 'EUR', expenses: 30, income: 50 },
      { currency: 'USD', expenses: 120, income: 0 },
    ])
  })

  it('returns an empty array when every this-month entry is base-currency', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0)
    const result = computeDashboardSummary({
      expenses: [mkExpense(10, 'UAH', catFood.id, dateAt(2026, 6, 10))],
      income: [],
      budgets: [],
      categories: [],
      now,
    })
    expect(result.excluded).toEqual([])
  })
})

// ---- criteria 4 & 5: leftToSpend / dailyAllowance ------------------------

describe('criteria 4 & 5: leftToSpend and dailyAllowance', () => {
  it('is null (with null dailyAllowance and empty budgetWatch) when there are no base-currency budgets', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0)
    const result = computeDashboardSummary({
      expenses: [],
      income: [],
      budgets: [mkBudget(catFood.id, 500, 'USD')],
      categories: [catFood],
      now,
    })
    expect(result.leftToSpend).toBeNull()
    expect(result.dailyAllowance).toBeNull()
    expect(result.budgetWatch).toEqual([])
  })

  it('sums base budget limits minus budgeted-category spend, mid-month', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0) // July 15, 31-day month, 17 days left
    const budgets = [mkBudget(catFood.id, 1000), mkBudget(catTransport.id, 500)]
    const expenses = [
      mkExpense(300, 'UAH', catFood.id, dateAt(2026, 6, 10)),
      mkExpense(100, 'UAH', catTransport.id, dateAt(2026, 6, 10)),
      // Not in any budgeted category: counted in monthExpenses, not leftToSpend.
      mkExpense(50, 'UAH', 'cat-other', dateAt(2026, 6, 10)),
    ]

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets,
      categories: [catFood, catTransport],
      now,
    })

    expect(result.monthExpenses).toBe(450)
    expect(result.leftToSpend).toBe(1100) // 1500 - 400
    expect(result.dailyAllowance).toBeCloseTo(1100 / 17, 5)
  })

  it('gives a daily allowance equal to the full remaining amount on the last day of the month', () => {
    const now = new Date(2026, 6, 31, 12, 0, 0) // July 31, last day, 1 day left
    const budgets = [mkBudget(catFood.id, 200)]
    const expenses = [mkExpense(150, 'UAH', catFood.id, dateAt(2026, 6, 31))]

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets,
      categories: [catFood],
      now,
    })

    expect(result.leftToSpend).toBe(50)
    expect(result.dailyAllowance).toBe(50)
  })

  it('clamps dailyAllowance to 0 (not negative) when spend exceeds budget', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0)
    const budgets = [mkBudget(catFood.id, 100)]
    const expenses = [mkExpense(500, 'UAH', catFood.id, dateAt(2026, 6, 10))]

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets,
      categories: [catFood],
      now,
    })

    expect(result.leftToSpend).toBe(-400)
    expect(result.dailyAllowance).toBe(0)
  })

  it('does not reduce leftToSpend for a non-base-currency expense, even in a budgeted category', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0)
    const budgets = [mkBudget(catFood.id, 500)]
    const expenses = [mkExpense(200, 'USD', catFood.id, dateAt(2026, 6, 10))]

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets,
      categories: [catFood],
      now,
    })

    expect(result.leftToSpend).toBe(500)
    expect(result.excluded).toEqual([
      { currency: 'USD', expenses: 200, income: 0 },
    ])
  })

  it('ignores a non-base-currency budget while still honoring a base-currency budget in the same mix', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0)
    const budgets = [
      mkBudget(catFood.id, 500, 'UAH'),
      mkBudget(catTransport.id, 300, 'USD'),
    ]
    const expenses = [
      mkExpense(100, 'UAH', catFood.id, dateAt(2026, 6, 10)),
      mkExpense(50, 'USD', catTransport.id, dateAt(2026, 6, 10)),
    ]

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets,
      categories: [catFood, catTransport],
      now,
    })

    expect(result.leftToSpend).toBe(400) // 500 - 100; the USD budget/expense is ignored
    expect(result.budgetWatch.map((b) => b.categoryId)).toEqual([catFood.id])
  })
})

// ---- criterion 6: pace ---------------------------------------------------

describe('criterion 6: pace', () => {
  it('sums last month through min(today, daysInLastMonth), excluding later days and non-base currency', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0) // July 15 -> cutoff in June = 15
    const expenses = [
      mkExpense(175, 'UAH', catFood.id, dateAt(2026, 6, 10)), // this month
      mkExpense(100, 'UAH', catFood.id, dateAt(2026, 5, 10)), // June day 10 <= cutoff -> included
      mkExpense(999, 'UAH', catFood.id, dateAt(2026, 5, 20)), // June day 20 > cutoff -> excluded
      mkExpense(9999, 'USD', catFood.id, dateAt(2026, 5, 5)), // non-base currency -> excluded
    ]

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets: [],
      categories: [],
      now,
    })

    expect(result.pace.spentSoFar).toBe(175)
    expect(result.pace.lastMonthSameDay).toBe(100)
    expect(result.pace.changePct).toBeCloseTo(75, 5)
  })

  it('caps the cutoff at the previous month\'s own day count (31-day month vs 30-day last month)', () => {
    const now = new Date(2026, 6, 31, 12, 0, 0) // July 31 (31 days); June has 30 days -> cutoff 30
    const expenses = [
      mkExpense(300, 'UAH', catFood.id, dateAt(2026, 6, 31)), // this month
      mkExpense(40, 'UAH', catFood.id, dateAt(2026, 6, 1)), // this month, July 1: counts in spentSoFar only
      mkExpense(50, 'UAH', catFood.id, dateAt(2026, 5, 1)), // June day 1
      mkExpense(200, 'UAH', catFood.id, dateAt(2026, 5, 30)), // June day 30, still within cutoff
    ]

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets: [],
      categories: [],
      now,
    })

    expect(result.pace.spentSoFar).toBe(340) // 300 + 40 (July 1 counts as this month)
    expect(result.pace.lastMonthSameDay).toBe(250) // July 1's expense does not leak into last month
    expect(result.pace.changePct).toBeCloseTo(36, 5)
  })

  it('is null when last month has no spending', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0)
    const expenses = [mkExpense(100, 'UAH', catFood.id, dateAt(2026, 6, 10))]

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets: [],
      categories: [],
      now,
    })

    expect(result.pace.lastMonthSameDay).toBe(0)
    expect(result.pace.changePct).toBeNull()
  })

  it('is negative when spending less than last month at the same point', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0)
    const expenses = [
      mkExpense(100, 'UAH', catFood.id, dateAt(2026, 6, 10)),
      mkExpense(200, 'UAH', catFood.id, dateAt(2026, 5, 10)),
    ]

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets: [],
      categories: [],
      now,
    })

    expect(result.pace.changePct).toBeCloseTo(-50, 5)
  })
})

// ---- criterion 7: budgetWatch ---------------------------------------------

describe('criterion 7: budgetWatch', () => {
  const now = new Date(2026, 6, 15, 12, 0, 0)

  it('orders entries by spent/limit ratio descending', () => {
    const categories = [
      catFood,
      catTransport,
      { id: 'cat-rent', name: 'Rent' },
    ]
    const budgets = [
      mkBudget(catFood.id, 1000),
      mkBudget(catTransport.id, 1000),
      mkBudget('cat-rent', 1000),
    ]
    const expenses = [
      mkExpense(500, 'UAH', catFood.id, dateAt(2026, 6, 10)), // ratio 0.5
      mkExpense(900, 'UAH', catTransport.id, dateAt(2026, 6, 10)), // ratio 0.9
      mkExpense(100, 'UAH', 'cat-rent', dateAt(2026, 6, 10)), // ratio 0.1
    ]

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets,
      categories,
      now,
    })

    expect(result.budgetWatch.map((b) => b.categoryId)).toEqual([
      catTransport.id,
      catFood.id,
      'cat-rent',
    ])
  })

  it('assigns status at the exact 0.8 and 1.0 threshold boundaries', () => {
    const categories: Array<Category> = [
      { id: 'cat-1', name: 'One' },
      { id: 'cat-2', name: 'Two' },
      { id: 'cat-3', name: 'Three' },
      { id: 'cat-4', name: 'Four' },
    ]
    const budgets = categories.map((c) => mkBudget(c.id, 100))
    const expenses = [
      mkExpense(79, 'UAH', 'cat-1', dateAt(2026, 6, 10)), // 0.79 -> ok
      mkExpense(80, 'UAH', 'cat-2', dateAt(2026, 6, 10)), // 0.8 -> warning
      mkExpense(100, 'UAH', 'cat-3', dateAt(2026, 6, 10)), // 1.0 -> warning
      mkExpense(101, 'UAH', 'cat-4', dateAt(2026, 6, 10)), // 1.01 -> over
    ]

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets,
      categories,
      now,
    })

    const byId = (categoryId: string) =>
      result.budgetWatch.find((b) => b.categoryId === categoryId)

    expect(byId('cat-1')?.status).toBe('ok')
    expect(byId('cat-2')?.status).toBe('warning')
    expect(byId('cat-3')?.status).toBe('warning')
    expect(byId('cat-4')?.status).toBe('over')
  })

  it('caps the list at 5, keeping the top 5 by ratio', () => {
    const categories: Array<Category> = Array.from({ length: 6 }, (_, i) => ({
      id: `cat-${i + 1}`,
      name: `Category ${i + 1}`,
    }))
    const budgets = categories.map((c) => mkBudget(c.id, 100))
    const expenses = categories.map((c, i) =>
      mkExpense((i + 1) * 10, 'UAH', c.id, dateAt(2026, 6, 10)),
    ) // ratios 0.1 .. 0.6

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets,
      categories,
      now,
    })

    expect(result.budgetWatch).toHaveLength(5)
    expect(result.budgetWatch.map((b) => b.categoryId)).toEqual([
      'cat-6',
      'cat-5',
      'cat-4',
      'cat-3',
      'cat-2',
    ])
  })

  it('breaks ties in ratio by name ascending', () => {
    const categories: Array<Category> = [
      { id: 'cat-b', name: 'Banana' },
      { id: 'cat-a', name: 'Apple' },
    ]
    const budgets = [mkBudget('cat-b', 100), mkBudget('cat-a', 100)]
    const expenses = [
      mkExpense(50, 'UAH', 'cat-b', dateAt(2026, 6, 10)),
      mkExpense(50, 'UAH', 'cat-a', dateAt(2026, 6, 10)),
    ]

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets,
      categories,
      now,
    })

    expect(result.budgetWatch.map((b) => b.name)).toEqual(['Apple', 'Banana'])
  })

  it('resolves the category name, falling back to Uncategorized when the category is missing', () => {
    const budgets = [mkBudget('cat-missing', 100)]
    const expenses = [mkExpense(10, 'UAH', 'cat-missing', dateAt(2026, 6, 10))]

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets,
      categories: [],
      now,
    })

    expect(result.budgetWatch[0].name).toBe('Uncategorized')
  })

  it('sums monthlyLimit across multiple base budgets sharing the same categoryId into one entry', () => {
    const budgets = [mkBudget(catFood.id, 300), mkBudget(catFood.id, 200)]
    const expenses = [mkExpense(250, 'UAH', catFood.id, dateAt(2026, 6, 10))]

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets,
      categories: [catFood],
      now,
    })

    expect(result.budgetWatch).toHaveLength(1)
    expect(result.budgetWatch[0].limit).toBe(500)
    expect(result.budgetWatch[0].spent).toBe(250)
    expect(result.budgetWatch[0].ratio).toBeCloseTo(0.5, 5)
  })

  it('gives an Infinity ratio (status over) for a zero-limit budget with spend, and 0 (status ok) with no spend', () => {
    const budgets = [mkBudget(catFood.id, 0), mkBudget(catTransport.id, 0)]
    const expenses = [mkExpense(50, 'UAH', catFood.id, dateAt(2026, 6, 10))]

    const result = computeDashboardSummary({
      expenses,
      income: [],
      budgets,
      categories: [catFood, catTransport],
      now,
    })

    const food = result.budgetWatch.find((b) => b.categoryId === catFood.id)
    const transport = result.budgetWatch.find(
      (b) => b.categoryId === catTransport.id,
    )

    expect(food?.ratio).toBe(Infinity)
    expect(food?.status).toBe('over')
    expect(transport?.ratio).toBe(0)
    expect(transport?.status).toBe('ok')
  })
})

// ---- criterion 8: recent ---------------------------------------------------

describe('criterion 8: recent', () => {
  it('merges expenses and income, tags kind, sorts by createdAt descending and caps at 5', () => {
    const now = new Date(2026, 6, 31, 12, 0, 0)

    const exp1 = mkExpense(1, 'UAH', catFood.id, dateAt(2026, 0, 1), 'exp1')
    const inc1 = mkIncome(2, 'UAH', dateAt(2026, 1, 1), 'inc1')
    const exp2 = mkExpense(3, 'UAH', catFood.id, dateAt(2026, 2, 1), 'exp2')
    const inc2 = mkIncome(4, 'UAH', dateAt(2026, 3, 1), 'inc2')
    const exp3 = mkExpense(5, 'UAH', catFood.id, dateAt(2026, 4, 1), 'exp3')
    const inc3 = mkIncome(6, 'UAH', dateAt(2026, 5, 1), 'inc3')
    const exp4 = mkExpense(7, 'UAH', catFood.id, dateAt(2026, 6, 1), 'exp4')
    // Non-base currency, to prove recent isn't filtered by currency.
    const inc4 = mkIncome(8, 'USD', dateAt(2026, 6, 20), 'inc4')

    const result = computeDashboardSummary({
      expenses: [exp1, exp2, exp3, exp4],
      income: [inc1, inc2, inc3, inc4],
      budgets: [],
      categories: [],
      now,
    })

    expect(result.recent).toHaveLength(5)
    expect(result.recent.map((r) => ({ id: r.id, kind: r.kind }))).toEqual([
      { id: 'inc4', kind: 'income' },
      { id: 'exp4', kind: 'expense' },
      { id: 'inc3', kind: 'income' },
      { id: 'exp3', kind: 'expense' },
      { id: 'inc2', kind: 'income' },
    ])
  })

  it('does not mutate the input expenses/income arrays', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0)
    const expenses = [
      mkExpense(10, 'UAH', catFood.id, dateAt(2026, 6, 1), 'e1'),
      mkExpense(20, 'UAH', catFood.id, dateAt(2026, 6, 2), 'e2'),
    ]
    const income = [mkIncome(30, 'UAH', dateAt(2026, 6, 1), 'i1')]
    const expensesBefore = expenses.map((e) => e.id)
    const incomeBefore = income.map((i) => i.id)

    computeDashboardSummary({ expenses, income, budgets: [], categories: [], now })

    expect(expenses.map((e) => e.id)).toEqual(expensesBefore)
    expect(income.map((i) => i.id)).toEqual(incomeBefore)
  })
})

// ---- baseCurrency default / override ---------------------------------------

describe('baseCurrency', () => {
  it('defaults to UAH when omitted', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0)
    const result = computeDashboardSummary({
      expenses: [],
      income: [],
      budgets: [],
      categories: [],
      now,
    })
    expect(result.baseCurrency).toBe('UAH')
  })

  it('respects an explicit baseCurrency other than UAH', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0)
    const result = computeDashboardSummary({
      expenses: [mkExpense(100, 'USD', catFood.id, dateAt(2026, 6, 10))],
      income: [],
      budgets: [],
      categories: [],
      now,
      baseCurrency: 'USD',
    })
    expect(result.baseCurrency).toBe('USD')
    expect(result.monthExpenses).toBe(100)
    expect(result.excluded).toEqual([])
  })
})

// ---- empty input -------------------------------------------------------------

describe('empty input', () => {
  it('returns a zeroed/null/empty summary for empty expenses, income and budgets', () => {
    const now = new Date(2026, 6, 15, 12, 0, 0)
    const result = computeDashboardSummary({
      expenses: [],
      income: [],
      budgets: [],
      categories: [],
      now,
    })

    expect(result.monthIncome).toBe(0)
    expect(result.monthExpenses).toBe(0)
    expect(result.net).toBe(0)
    expect(result.excluded).toEqual([])
    expect(result.leftToSpend).toBeNull()
    expect(result.dailyAllowance).toBeNull()
    expect(result.pace.changePct).toBeNull()
    expect(result.budgetWatch).toEqual([])
    expect(result.recent).toEqual([])
  })
})
