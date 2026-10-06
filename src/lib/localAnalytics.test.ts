// No CONTRACT_GAPs: computeRangeAnalytics(input, currency) and RangeAnalytics
// (#2 lib, #6) are fully specified in the Interface Contract.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Expense, IncomeEntry } from '@/lib/domain'
import { computeRangeAnalytics } from '@/lib/localAnalytics'
import {
  getAllBudgets,
  getAllIncome,
  getExpensesForRange,
} from '@/lib/localDb'

vi.mock('@/lib/localDb', () => ({
  getExpensesForRange: vi.fn(),
  getAllIncome: vi.fn(),
  getAllBudgets: vi.fn(),
}))

const originalTZ = process.env.TZ
process.env.TZ = 'Europe/Kyiv'
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ
  else process.env.TZ = originalTZ
})

const FOOD = { id: 'c1', name: 'Food' }
const RANGE = { from: '2024-01-01', to: '2024-01-31' }

function expense(
  id: string,
  amount: number,
  currency: Expense['currency'],
  createdAt = '2024-01-10T12:00:00.000Z',
): Expense {
  return {
    id,
    amount,
    currency,
    categoryId: 'c1',
    createdAt,
    category: FOOD,
  }
}

function income(
  id: string,
  amount: number,
  currency: IncomeEntry['currency'],
): IncomeEntry {
  return {
    id,
    source: 'Job',
    amount,
    currency,
    createdAt: '2024-01-12T12:00:00.000Z',
  }
}

function budget(currency: 'UAH' | 'USD', limit: number) {
  return {
    id: `b-${currency}`,
    categoryId: 'c1',
    monthlyLimit: limit,
    currency,
    categoryName: 'Food',
    categoryIcon: null,
  }
}

function setup(
  expenses: Array<Expense>,
  incomes: Array<IncomeEntry> = [],
  budgets: Array<ReturnType<typeof budget>> = [],
) {
  vi.mocked(getExpensesForRange).mockResolvedValue(expenses)
  vi.mocked(getAllIncome).mockResolvedValue(incomes)
  vi.mocked(getAllBudgets).mockResolvedValue(budgets)
}

describe('computeRangeAnalytics currency handling (#2)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('defaults to UAH: sums only UAH expenses and reports USD as excluded', async () => {
    setup([expense('e1', 100, 'USD'), expense('e2', 1000, 'UAH')])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.categoryBreakdown).toHaveLength(1)
    expect(result.categoryBreakdown[0].total).toBe(1000)
    expect(result.excluded).toEqual([
      { currency: 'USD', expenses: 100, income: 0 },
    ])
  })

  it('with USD selected, totals 100 and reports UAH 1000 as excluded', async () => {
    setup([expense('e1', 100, 'USD'), expense('e2', 1000, 'UAH')])

    const result = await computeRangeAnalytics(RANGE, 'USD')

    expect(result.categoryBreakdown[0].total).toBe(100)
    expect(result.excluded).toEqual([
      { currency: 'UAH', expenses: 1000, income: 0 },
    ])
  })

  it('keeps other-currency spend out of the timeline', async () => {
    setup([expense('e1', 100, 'USD'), expense('e2', 1000, 'UAH')])

    const uah = await computeRangeAnalytics(RANGE, 'UAH')
    const usd = await computeRangeAnalytics(RANGE, 'USD')

    expect(uah.timeline.map((p) => p.total)).toEqual([1000])
    expect(usd.timeline.map((p) => p.total)).toEqual([100])
  })

  it('has an empty excluded list when everything is in the selected currency', async () => {
    setup([expense('e1', 50, 'UAH')])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.excluded).toEqual([])
  })

  it('does not compare a USD budget to UAH spend', async () => {
    setup([expense('e1', 100, 'USD'), expense('e2', 1000, 'UAH')], [], [
      budget('USD', 200),
    ])

    const uah = await computeRangeAnalytics(RANGE, 'UAH')

    expect(uah.budgetVariance).toEqual([])
  })

  it('compares a USD budget to USD spend only', async () => {
    setup([expense('e1', 100, 'USD'), expense('e2', 1000, 'UAH')], [], [
      budget('USD', 200),
    ])

    const usd = await computeRangeAnalytics(RANGE, 'USD')

    expect(usd.budgetVariance).toHaveLength(1)
    expect(usd.budgetVariance[0].actual).toBe(100)
    expect(usd.budgetVariance[0].budget).toBe(200)
    expect(usd.budgetVariance[0].overBudget).toBe(false)
  })

  it('flags a same-currency budget as over budget only when that currency overspends', async () => {
    setup([expense('e1', 100, 'USD'), expense('e2', 1000, 'UAH')], [], [
      budget('UAH', 500),
    ])

    const uah = await computeRangeAnalytics(RANGE, 'UAH')

    expect(uah.budgetVariance[0].actual).toBe(1000)
    expect(uah.budgetVariance[0].overBudget).toBe(true)
  })

  it('counts only selected-currency income and moves the rest to excluded[].income', async () => {
    setup(
      [expense('e1', 100, 'USD')],
      [income('i1', 300, 'UAH'), income('i2', 50, 'EUR')],
    )

    const uah = await computeRangeAnalytics(RANGE, 'UAH')
    const eur = await computeRangeAnalytics(RANGE, 'EUR')

    expect(uah.totalIncome).toBe(300)
    expect(eur.totalIncome).toBe(50)
    // Sorted by currency ascending.
    expect(uah.excluded).toEqual([
      { currency: 'EUR', expenses: 0, income: 50 },
      { currency: 'USD', expenses: 100, income: 0 },
    ])
  })

  it('merges expense and income of the same other currency into one entry', async () => {
    setup([expense('e1', 100, 'USD')], [income('i1', 70, 'USD')])

    const result = await computeRangeAnalytics(RANGE, 'UAH')

    expect(result.excluded).toEqual([
      { currency: 'USD', expenses: 100, income: 70 },
    ])
  })
})

describe('computeRangeAnalytics timeline day (#6)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('buckets an expense at 00:30 local (22:30Z the previous day) on its local day', async () => {
    setup([expense('e1', 40, 'UAH', '2024-01-14T22:30:00.000Z')])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.timeline).toHaveLength(1)
    expect(result.timeline[0].date).toBe('2024-01-15')
  })

  it('keeps a midday expense on the same day and splits two local days apart', async () => {
    setup([
      expense('e1', 10, 'UAH', '2024-01-15T10:00:00.000Z'),
      expense('e2', 20, 'UAH', '2024-01-14T22:30:00.000Z'),
    ])

    const result = await computeRangeAnalytics(RANGE)

    // Both are local 2024-01-15, so they must land in one bucket.
    expect(result.timeline).toHaveLength(1)
    expect(result.timeline[0].date).toBe('2024-01-15')
    expect(result.timeline[0].total).toBe(30)
  })
})
