// No CONTRACT_GAPs: computeRangeAnalytics(input, mainCurrency) and
// RangeAnalytics (mainCurrency, pendingCount, budgetsExcluded) are fully
// specified in the Interface Contract.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EntryConversion, Expense, IncomeEntry } from '@/lib/domain'
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
const SALARY = { id: 'ic1', name: 'Salary', icon: '💼', updatedAt: '2024-01-01' }
const RANGE = { from: '2024-01-01', to: '2024-01-31' }

function conversion(
  mainCurrency: EntryConversion['mainCurrency'],
  rate: number,
  amount: number,
): EntryConversion {
  return {
    mainCurrency,
    rate,
    mainAmount: amount * rate,
    rateDate: '2024-01-10',
    source: 'nbu',
  }
}

function expense(
  id: string,
  amount: number,
  currency: Expense['currency'],
  createdAt = '2024-01-10T12:00:00.000Z',
  conv?: EntryConversion,
): Expense {
  return {
    id,
    amount,
    currency,
    categoryId: 'c1',
    createdAt,
    category: FOOD,
    ...(conv ? { conversion: conv } : {}),
  }
}

function income(
  id: string,
  amount: number,
  currency: IncomeEntry['currency'],
  conv?: EntryConversion,
): IncomeEntry {
  return {
    id,
    categoryId: 'ic1',
    category: SALARY,
    amount,
    currency,
    createdAt: '2024-01-12T12:00:00.000Z',
    ...(conv ? { conversion: conv } : {}),
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

describe('computeRangeAnalytics main-currency handling', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('defaults to UAH: sums UAH expenses and counts a pending USD expense', async () => {
    setup([expense('e1', 100, 'USD'), expense('e2', 1000, 'UAH')])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.mainCurrency).toBe('UAH')
    expect(result.categoryBreakdown).toHaveLength(1)
    expect(result.categoryBreakdown[0].total).toBe(1000)
    expect(result.pendingCount).toBe(1)
  })

  it('adds a converted USD expense at its stored mainAmount', async () => {
    setup([
      expense('e1', 100, 'USD', undefined, conversion('UAH', 41.5, 100)),
      expense('e2', 1000, 'UAH'),
    ])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.categoryBreakdown[0].total).toBeCloseTo(1000 + 4150, 6)
    expect(result.pendingCount).toBe(0)
  })

  it('with main USD, totals the USD expense (100) and counts the UAH one as pending', async () => {
    setup([expense('e1', 100, 'USD'), expense('e2', 1000, 'UAH')])

    const result = await computeRangeAnalytics(RANGE, 'USD')

    expect(result.mainCurrency).toBe('USD')
    expect(result.categoryBreakdown[0].total).toBe(100)
    expect(result.pendingCount).toBe(1)
  })

  it('treats a conversion made for another main currency as pending', async () => {
    setup([expense('e1', 100, 'UAH', undefined, conversion('UAH', 1, 100))])

    const eur = await computeRangeAnalytics(RANGE, 'EUR')

    expect(eur.categoryBreakdown).toEqual([])
    expect(eur.pendingCount).toBe(1)
  })

  it('keeps pending spend out of the timeline and puts converted spend in', async () => {
    setup([
      expense('e1', 100, 'USD'),
      expense('e2', 1000, 'UAH'),
      expense('e3', 2, 'EUR', '2024-01-11T12:00:00.000Z', conversion('UAH', 45, 2)),
    ])

    const uah = await computeRangeAnalytics(RANGE, 'UAH')

    expect(uah.timeline.map((p) => p.date)).toEqual(['2024-01-10', '2024-01-11'])
    expect(uah.timeline.map((p) => p.total)).toEqual([1000, 90])
  })

  it('reports pendingCount 0 when everything is in the main currency', async () => {
    setup([expense('e1', 50, 'UAH')])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.pendingCount).toBe(0)
  })

  it('no longer returns an excluded list', async () => {
    setup([expense('e1', 100, 'USD')])

    const result = await computeRangeAnalytics(RANGE)

    expect('excluded' in result).toBe(false)
  })

  it('does not compare a USD budget to UAH spend and counts it as excluded', async () => {
    setup([expense('e1', 100, 'USD'), expense('e2', 1000, 'UAH')], [], [
      budget('USD', 200),
    ])

    const uah = await computeRangeAnalytics(RANGE, 'UAH')

    expect(uah.budgetVariance).toEqual([])
    expect(uah.budgetsExcluded).toBe(1)
  })

  it('compares a main-currency budget to the main-currency totals (converted spend included)', async () => {
    setup(
      [
        expense('e1', 2, 'USD', undefined, conversion('UAH', 40, 2)),
        expense('e2', 1000, 'UAH'),
      ],
      [],
      [budget('UAH', 500)],
    )

    const uah = await computeRangeAnalytics(RANGE, 'UAH')

    expect(uah.budgetsExcluded).toBe(0)
    expect(uah.budgetVariance).toHaveLength(1)
    expect(uah.budgetVariance[0].actual).toBeCloseTo(1080, 6)
    expect(uah.budgetVariance[0].budget).toBe(500)
    expect(uah.budgetVariance[0].overBudget).toBe(true)
  })

  it('does not flag a main-currency budget when pending spend is the only overspend', async () => {
    setup([expense('e1', 100, 'USD'), expense('e2', 100, 'UAH')], [], [
      budget('UAH', 500),
    ])

    const uah = await computeRangeAnalytics(RANGE, 'UAH')

    expect(uah.budgetVariance[0].actual).toBe(100)
    expect(uah.budgetVariance[0].overBudget).toBe(false)
  })

  it('counts income by mainAmount and pending income in pendingCount, together with pending expenses', async () => {
    setup(
      [expense('e1', 100, 'USD')],
      [
        income('i1', 300, 'UAH'),
        income('i2', 50, 'EUR'),
        income('i3', 10, 'USD', conversion('UAH', 40, 10)),
      ],
    )

    const uah = await computeRangeAnalytics(RANGE, 'UAH')
    const eur = await computeRangeAnalytics(RANGE, 'EUR')

    expect(uah.totalIncome).toBeCloseTo(700, 6)
    expect(uah.pendingCount).toBe(2) // USD expense + EUR income
    expect(eur.totalIncome).toBe(50)
    expect(eur.pendingCount).toBe(3) // USD expense + UAH income + stale USD income
  })

  it('does not count pending income outside the range', async () => {
    // getExpensesForRange already filters by range; income is filtered here.
    setup(
      [],
      [
        {
          ...income('i-old', 50, 'EUR'),
          createdAt: '2023-06-12T12:00:00.000Z',
        },
        income('i-in', 20, 'EUR'),
      ],
    )

    const result = await computeRangeAnalytics(RANGE, 'UAH')

    expect(result.pendingCount).toBe(1)
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
