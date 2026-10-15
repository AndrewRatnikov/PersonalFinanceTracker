// No CONTRACT_GAPs: incomeBreakdown (grouping by categoryId, joined name and
// icon, sorted by total descending, summing mainAmountOf in the main currency)
// is fully specified in the Interface Contract (module: localAnalytics).
// Income fixtures carry categoryId and the joined category, as the real
// getAllIncome returns them.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EntryConversion, IncomeEntry } from '@/lib/domain'
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

const RANGE = { from: '2024-01-01', to: '2024-01-31' }
const SALARY = { id: 'ic-sal', name: 'Salary', icon: '💼' }
const FREELANCE = { id: 'ic-free', name: 'Freelance', icon: '💻' }
const GIFTS = { id: 'ic-gift', name: 'Gifts', icon: null }

function income(
  id: string,
  amount: number,
  currency: IncomeEntry['currency'],
  category: { id: string; name: string; icon: string | null } | undefined,
  overrides: Partial<IncomeEntry> = {},
): IncomeEntry {
  return {
    id,
    categoryId: category?.id ?? '',
    ...(category ? { category } : {}),
    amount,
    currency,
    createdAt: '2024-01-12T12:00:00.000Z',
    ...overrides,
  }
}

function conversion(
  mainCurrency: EntryConversion['mainCurrency'],
  rate: number,
  amount: number,
): EntryConversion {
  return {
    mainCurrency,
    rate,
    mainAmount: amount * rate,
    rateDate: '2024-01-12',
    source: 'nbu',
  }
}

function setup(incomes: Array<IncomeEntry>) {
  vi.mocked(getExpensesForRange).mockResolvedValue([])
  vi.mocked(getAllIncome).mockResolvedValue(incomes)
  vi.mocked(getAllBudgets).mockResolvedValue([])
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('incomeBreakdown grouping and sorting', () => {
  it('groups by category, sums the totals and sorts by total descending', async () => {
    setup([
      income('i1', 500, 'UAH', GIFTS),
      income('i2', 3000, 'UAH', SALARY),
      income('i3', 1000, 'UAH', FREELANCE),
      income('i4', 700, 'UAH', SALARY),
    ])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.incomeBreakdown).toEqual([
      { categoryId: 'ic-sal', name: 'Salary', icon: '💼', total: 3700 },
      { categoryId: 'ic-free', name: 'Freelance', icon: '💻', total: 1000 },
      { categoryId: 'ic-gift', name: 'Gifts', icon: null, total: 500 },
    ])
  })

  it('re-orders when the totals change (not a fixed order)', async () => {
    setup([
      income('i1', 5000, 'UAH', GIFTS),
      income('i2', 30, 'UAH', SALARY),
    ])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.incomeBreakdown.map((b) => b.name)).toEqual(['Gifts', 'Salary'])
    expect(result.incomeBreakdown.map((b) => b.total)).toEqual([5000, 30])
  })

  it('is empty without income', async () => {
    setup([])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.incomeBreakdown).toEqual([])
  })

  it('keeps two categories with the same name but different ids apart', async () => {
    setup([
      income('i1', 10, 'UAH', { id: 'a', name: 'Same', icon: null }),
      income('i2', 20, 'UAH', { id: 'b', name: 'Same', icon: null }),
    ])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.incomeBreakdown.map((b) => b.categoryId)).toEqual(['b', 'a'])
  })

  it('totals add up to totalIncome (a pending USD entry is in neither)', async () => {
    setup([
      income('i1', 3000, 'UAH', SALARY),
      income('i2', 1000.5, 'UAH', FREELANCE),
      income('i3', 99, 'USD', GIFTS),
    ])

    const result = await computeRangeAnalytics(RANGE)

    const sum = result.incomeBreakdown.reduce((s, b) => s + b.total, 0)
    expect(sum).toBe(result.totalIncome)
    expect(result.totalIncome).toBe(4000.5)
  })

  it('does not change the spending breakdown', async () => {
    setup([income('i1', 3000, 'UAH', SALARY)])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.categoryBreakdown).toEqual([])
    expect(result.timeline).toEqual([])
    expect(result.incomeBreakdown).toHaveLength(1)
  })
})

describe('incomeBreakdown in the main currency and range', () => {
  const mixed = [
    income('i1', 3000, 'UAH', SALARY),
    income('i2', 50, 'USD', GIFTS),
    income('i3', 70, 'USD', SALARY, { conversion: conversion('UAH', 40, 70) }),
    income('i4', 10, 'EUR', FREELANCE),
  ]

  it('defaults to UAH: pending USD/EUR income is not charted and is counted', async () => {
    setup(mixed)

    const result = await computeRangeAnalytics(RANGE)

    // i2 and i4 are pending; i3 is converted into Salary.
    expect(result.incomeBreakdown).toEqual([
      { categoryId: 'ic-sal', name: 'Salary', icon: '💼', total: 3000 + 2800 },
    ])
    expect(result.totalIncome).toBe(5800)
    expect(result.pendingCount).toBe(2)
  })

  it('with main USD, charts only USD income at its amount; the converted-to-UAH entry is pending', async () => {
    setup(mixed)

    const result = await computeRangeAnalytics(RANGE, 'USD')

    // i2 (50 USD, no conversion) counts at 50; i3's conversion is for UAH, so
    // it is pending in USD.
    expect(result.incomeBreakdown).toEqual([
      { categoryId: 'ic-gift', name: 'Gifts', icon: null, total: 50 },
    ])
    expect(result.pendingCount).toBe(3) // UAH, converted-to-UAH USD, EUR
  })

  it('leaves out income outside the range', async () => {
    setup([
      income('in', 100, 'UAH', SALARY),
      income('before', 999, 'UAH', GIFTS, {
        createdAt: '2023-12-20T12:00:00.000Z',
      }),
      income('after', 888, 'UAH', FREELANCE, {
        createdAt: '2024-02-20T12:00:00.000Z',
      }),
    ])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.incomeBreakdown.map((b) => b.name)).toEqual(['Salary'])
    expect(result.totalIncome).toBe(100)
  })
})

describe('incomeBreakdown amounts', () => {
  it('skips zero, negative and non-finite amounts', async () => {
    setup([
      income('i1', 0, 'UAH', GIFTS),
      income('i2', -5, 'UAH', GIFTS),
      income('i3', Number.NaN, 'UAH', GIFTS),
      income('i4', Number.POSITIVE_INFINITY, 'UAH', GIFTS),
      income('i5', 40, 'UAH', FREELANCE),
    ])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.incomeBreakdown).toEqual([
      { categoryId: 'ic-free', name: 'Freelance', icon: '💻', total: 40 },
    ])
  })
})

describe('incomeBreakdown for records without a category', () => {
  it('labels an unconverted record by its legacy source', async () => {
    setup([
      income('i1', 200, 'UAH', undefined, { source: '  Freelance gig ' }),
    ])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.incomeBreakdown).toHaveLength(1)
    expect(result.incomeBreakdown[0]).toMatchObject({
      name: 'Freelance gig',
      icon: null,
      total: 200,
    })
  })

  it('labels a record with neither category nor source Uncategorized', async () => {
    setup([income('i1', 200, 'UAH', undefined)])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.incomeBreakdown).toHaveLength(1)
    expect(result.incomeBreakdown[0].name).toBe('Uncategorized')
    expect(result.incomeBreakdown[0].total).toBe(200)
  })

  it('groups records whose category id is gone under that id', async () => {
    setup([
      income('i1', 10, 'UAH', undefined, { categoryId: 'gone' }),
      income('i2', 15, 'UAH', undefined, { categoryId: 'gone' }),
      income('i3', 100, 'UAH', SALARY),
    ])

    const result = await computeRangeAnalytics(RANGE)

    expect(result.incomeBreakdown).toHaveLength(2)
    const gone = result.incomeBreakdown.find((b) => b.categoryId === 'gone')
    expect(gone?.total).toBe(25)
    expect(gone?.name).toBe('Uncategorized')
  })
})
