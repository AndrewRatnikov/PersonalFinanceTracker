// No CONTRACT_GAPs: scaleMonthlyLimitToRange and the B1 budget comparison are
// fully specified in the Interface Contract.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Expense } from '@/lib/domain'
import {
  computeRangeAnalytics,
  scaleMonthlyLimitToRange,
} from '@/lib/localAnalytics'
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

function expense(id: string, amount: number, createdAt: string): Expense {
  return {
    id,
    amount,
    currency: 'UAH',
    categoryId: 'c1',
    createdAt,
    category: FOOD,
  }
}

function budget(limit: number) {
  return {
    id: 'b1',
    categoryId: 'c1',
    monthlyLimit: limit,
    currency: 'UAH' as const,
    categoryName: 'Food',
    categoryIcon: null,
  }
}

function setup(expenses: Array<Expense>, limit = 1000) {
  vi.mocked(getExpensesForRange).mockResolvedValue(expenses)
  vi.mocked(getAllIncome).mockResolvedValue([])
  vi.mocked(getAllBudgets).mockResolvedValue([budget(limit)])
}

describe('scaleMonthlyLimitToRange', () => {
  it('gives exactly the monthly limit for a range covering one whole month', () => {
    expect(scaleMonthlyLimitToRange(1000, '2024-01-01', '2024-01-31')).toBe(1000)
    expect(scaleMonthlyLimitToRange(1000, '2024-04-01', '2024-04-30')).toBe(1000)
    expect(scaleMonthlyLimitToRange(777, '2024-02-01', '2024-02-29')).toBe(777)
    expect(scaleMonthlyLimitToRange(777, '2023-02-01', '2023-02-28')).toBe(777)
  })

  it('stays exact across daylight saving changes (Europe/Kyiv)', () => {
    expect(scaleMonthlyLimitToRange(1000, '2024-03-01', '2024-03-31')).toBe(1000)
    expect(scaleMonthlyLimitToRange(1000, '2024-10-01', '2024-10-31')).toBe(1000)
  })

  it('scales a partial month by days in range over days in month', () => {
    expect(scaleMonthlyLimitToRange(1000, '2024-01-01', '2024-01-15')).toBe(
      483.87,
    )
    expect(scaleMonthlyLimitToRange(1000, '2024-04-01', '2024-04-15')).toBe(500)
    expect(scaleMonthlyLimitToRange(1000, '2024-01-01', '2024-01-01')).toBe(
      32.26,
    )
  })

  it('uses the real length of February', () => {
    // 2024 is a leap year (29 days), 2023 is not (28 days).
    expect(scaleMonthlyLimitToRange(2900, '2024-02-01', '2024-02-10')).toBe(1000)
    expect(scaleMonthlyLimitToRange(2800, '2023-02-01', '2023-02-10')).toBe(1000)
  })

  it('sums the share of every calendar month the range touches', () => {
    // Jan 1 .. Mar 30 2024: 1000 + 1000 + 1000 * 30 / 31.
    expect(scaleMonthlyLimitToRange(1000, '2024-01-01', '2024-03-30')).toBe(
      2967.74,
    )
    // Jan 16 .. Feb 14: 16/31 + 14/29 of 1000.
    expect(scaleMonthlyLimitToRange(1000, '2024-01-16', '2024-02-14')).toBe(
      998.89,
    )
  })

  it('scales linearly with the monthly limit', () => {
    expect(scaleMonthlyLimitToRange(2000, '2024-01-01', '2024-03-30')).toBe(
      5935.48,
    )
    expect(scaleMonthlyLimitToRange(0, '2024-01-01', '2024-03-30')).toBe(0)
  })

  it('counts a range across a year boundary', () => {
    // Dec 16..31 = 16/31, Jan 1..15 = 15/31.
    expect(scaleMonthlyLimitToRange(3100, '2023-12-16', '2024-01-15')).toBe(3100)
  })

  it('returns 0 when the range ends before it starts', () => {
    expect(scaleMonthlyLimitToRange(1000, '2024-02-10', '2024-02-01')).toBe(0)
  })
})

describe('computeRangeAnalytics budget vs. actual over arbitrary ranges (B1)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('a 90-day range with 800 UAH per month against a 1000 UAH monthly budget is not over budget', async () => {
    setup([
      expense('e1', 800, '2024-01-15T12:00:00.000Z'),
      expense('e2', 800, '2024-02-15T12:00:00.000Z'),
      expense('e3', 800, '2024-03-15T12:00:00.000Z'),
    ])

    const result = await computeRangeAnalytics({
      from: '2024-01-01',
      to: '2024-03-30',
    })

    expect(result.budgetVariance).toHaveLength(1)
    const item = result.budgetVariance[0]
    expect(item.actual).toBe(2400)
    expect(item.budget).toBeCloseTo(2967.74, 2)
    expect(item.overBudget).toBe(false)
  })

  it('the same 90-day range is over budget once spend exceeds the scaled limit', async () => {
    setup([
      expense('e1', 1100, '2024-01-15T12:00:00.000Z'),
      expense('e2', 1100, '2024-02-15T12:00:00.000Z'),
      expense('e3', 1100, '2024-03-15T12:00:00.000Z'),
    ])

    const result = await computeRangeAnalytics({
      from: '2024-01-01',
      to: '2024-03-30',
    })

    expect(result.budgetVariance[0].actual).toBe(3300)
    expect(result.budgetVariance[0].overBudget).toBe(true)
  })

  it('a range covering exactly one calendar month with 1200 spent is over budget and reports the plain monthly limit', async () => {
    setup([expense('e1', 1200, '2024-01-10T12:00:00.000Z')])

    const result = await computeRangeAnalytics({
      from: '2024-01-01',
      to: '2024-01-31',
    })

    expect(result.budgetVariance[0].actual).toBe(1200)
    expect(result.budgetVariance[0].budget).toBe(1000)
    expect(result.budgetVariance[0].overBudget).toBe(true)
  })

  it('a range covering exactly one calendar month with 900 spent is not over budget', async () => {
    setup([expense('e1', 900, '2024-01-10T12:00:00.000Z')])

    const result = await computeRangeAnalytics({
      from: '2024-01-01',
      to: '2024-01-31',
    })

    expect(result.budgetVariance[0].budget).toBe(1000)
    expect(result.budgetVariance[0].overBudget).toBe(false)
  })

  it('a half-month range gets half the limit, so 600 spent is over it', async () => {
    setup([expense('e1', 600, '2024-04-05T12:00:00.000Z')])

    const result = await computeRangeAnalytics({
      from: '2024-04-01',
      to: '2024-04-15',
    })

    expect(result.budgetVariance[0].budget).toBe(500)
    expect(result.budgetVariance[0].overBudget).toBe(true)
  })

  it('a half-month range with 400 spent is within the scaled limit', async () => {
    setup([expense('e1', 400, '2024-04-05T12:00:00.000Z')])

    const result = await computeRangeAnalytics({
      from: '2024-04-01',
      to: '2024-04-15',
    })

    expect(result.budgetVariance[0].budget).toBe(500)
    expect(result.budgetVariance[0].overBudget).toBe(false)
  })

  it('spending exactly the scaled limit is not over budget', async () => {
    setup([expense('e1', 500, '2024-04-05T12:00:00.000Z')])

    const result = await computeRangeAnalytics({
      from: '2024-04-01',
      to: '2024-04-15',
    })

    expect(result.budgetVariance[0].overBudget).toBe(false)
  })
})
