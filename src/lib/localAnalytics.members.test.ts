// CONTRACT_GAP: members.months is asserted as the number of local calendar
//   months of the normalized range (monthsInRange); the exact range-string
//   format normalizeRange produces is not part of the contract.
//
// memberId filters every aggregate (category breakdown, timeline, income,
// pendingCount); byMember adds `members`; without the option the result keeps
// its exact old shape.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Expense, IncomeEntry } from '@/lib/domain'
import { computeRangeAnalytics } from '@/lib/localAnalytics'
import { getAllBudgets, getAllIncome, getExpensesForRange, spaceDb } from '@/lib/localDb'

const fam = vi.hoisted(() => ({
  getExpensesForRange: vi.fn(),
  getAllIncome: vi.fn(),
  getAllBudgets: vi.fn(),
}))

vi.mock('@/lib/localDb', () => ({
  getExpensesForRange: vi.fn(),
  getAllIncome: vi.fn(),
  getAllBudgets: vi.fn(),
  spaceDb: vi.fn(() => fam),
}))

const originalTZ = process.env.TZ
process.env.TZ = 'Europe/Kyiv'
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ
  else process.env.TZ = originalTZ
})

const RANGE = { from: '2026-09-01', to: '2026-10-31' }
const FOOD = { id: 'cat-food', name: 'Food', icon: '🍔' }
const HOME = { id: 'cat-home', name: 'Home', icon: '🏠' }

function exp(
  id: string,
  amount: number,
  paidBy: string | undefined,
  category = FOOD,
  extra: Partial<Expense> = {},
): Expense {
  return {
    id,
    amount,
    currency: 'UAH',
    categoryId: category.id,
    category,
    createdAt: '2026-10-12T10:00:00.000Z',
    ...(paidBy === undefined ? {} : { paidBy }),
    ...extra,
  }
}

function inc(id: string, amount: number, paidBy: string | undefined): IncomeEntry {
  return {
    id,
    amount,
    currency: 'UAH',
    categoryId: 'ic-sal',
    category: { id: 'ic-sal', name: 'Salary', icon: '💼' },
    createdAt: '2026-10-05T10:00:00.000Z',
    ...(paidBy === undefined ? {} : { paidBy }),
  }
}

const EXPENSES = [
  exp('e1', 100, 'u-me'),
  exp('e2', 300, 'u-olena'),
  exp('e3', 50, 'u-me', HOME),
  exp('e4', 25, 'u-olena', FOOD, { currency: 'USD' }), // pending, Olena
  exp('e5', 10, undefined),
]
const INCOMES = [inc('i1', 1000, 'u-me'), inc('i2', 4000, 'u-olena'), inc('i3', 500, undefined)]

function seed() {
  fam.getExpensesForRange.mockResolvedValue(EXPENSES)
  fam.getAllIncome.mockResolvedValue(INCOMES)
  fam.getAllBudgets.mockResolvedValue([])
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(spaceDb).mockReturnValue(fam as never)
  vi.mocked(getExpensesForRange).mockResolvedValue([])
  vi.mocked(getAllIncome).mockResolvedValue([])
  vi.mocked(getAllBudgets).mockResolvedValue([])
  seed()
})

describe('memberId filter', () => {
  it('filters the category breakdown, the timeline and the income by payer', async () => {
    const me = await computeRangeAnalytics(RANGE, 'UAH', { spaceId: 'fam-1', memberId: 'u-me' })
    const olena = await computeRangeAnalytics(RANGE, 'UAH', { spaceId: 'fam-1', memberId: 'u-olena' })

    expect(me.categoryBreakdown.map((c) => [c.categoryId, c.total])).toEqual([
      ['cat-food', 100],
      ['cat-home', 50],
    ])
    expect(me.timeline.reduce((s, p) => s + p.total, 0)).toBe(150)
    expect(me.totalIncome).toBe(1000)
    expect(olena.categoryBreakdown.map((c) => [c.categoryId, c.total])).toEqual([['cat-food', 300]])
    expect(olena.totalIncome).toBe(4000)
  })

  it('also filters pendingCount', async () => {
    const olena = await computeRangeAnalytics(RANGE, 'UAH', { spaceId: 'fam-1', memberId: 'u-olena' })
    const me = await computeRangeAnalytics(RANGE, 'UAH', { spaceId: 'fam-1', memberId: 'u-me' })
    const all = await computeRangeAnalytics(RANGE, 'UAH', { spaceId: 'fam-1' })

    expect(olena.pendingCount).toBe(1)
    expect(me.pendingCount).toBe(0)
    expect(all.pendingCount).toBe(1)
  })

  it('without memberId everything is counted (including entries without a payer)', async () => {
    const all = await computeRangeAnalytics(RANGE, 'UAH', { spaceId: 'fam-1' })

    expect(all.totalIncome).toBe(5500)
    expect(all.categoryBreakdown.find((c) => c.categoryId === 'cat-food')?.total).toBe(410)
  })

  it('an unknown member gives an empty result', async () => {
    const none = await computeRangeAnalytics(RANGE, 'UAH', { spaceId: 'fam-1', memberId: 'u-ghost' })

    expect(none.categoryBreakdown).toEqual([])
    expect(none.totalIncome).toBe(0)
  })
})

describe('byMember', () => {
  it('adds members with totals, shares and the months of the range (hand-computed)', async () => {
    const result = await computeRangeAnalytics(RANGE, 'UAH', { spaceId: 'fam-1', byMember: true })

    expect(result.members?.months).toBe(2)
    expect(result.members?.expense.map((r) => [r.memberId, r.total])).toEqual([
      ['u-olena', 300],
      ['u-me', 150],
      ['unknown', 10],
    ])
    expect(result.members?.expense[0].share).toBeCloseTo(300 / 460, 10)
    expect(result.members?.expense[1].averagePerMonth).toBeCloseTo(75, 10)
    expect(result.members?.income.map((r) => [r.memberId, r.total])).toEqual([
      ['u-olena', 4000],
      ['u-me', 1000],
      ['unknown', 500],
    ])
  })

  it('with a member filter the sections only hold that member', async () => {
    const result = await computeRangeAnalytics(RANGE, 'UAH', {
      spaceId: 'fam-1',
      byMember: true,
      memberId: 'u-me',
    })

    expect(result.members?.expense.map((r) => r.memberId)).toEqual(['u-me'])
    expect(result.members?.expense[0].share).toBe(1)
    expect(result.members?.income.map((r) => r.memberId)).toEqual(['u-me'])
  })

  it('leaves the pending entries out of the member totals', async () => {
    const result = await computeRangeAnalytics(RANGE, 'UAH', { spaceId: 'fam-1', byMember: true })

    const olena = result.members?.expense.find((r) => r.memberId === 'u-olena')
    expect(olena?.total).toBe(300)
    expect(result.pendingCount).toBe(1)
  })

  it('is absent without byMember and for plain personal calls', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([exp('p1', 5, undefined)])

    const family = await computeRangeAnalytics(RANGE, 'UAH', { spaceId: 'fam-1' })
    const personal = await computeRangeAnalytics(RANGE, 'UAH')

    expect('members' in family).toBe(false)
    expect('members' in personal).toBe(false)
    expect(personal.categoryBreakdown[0].total).toBe(5)
  })
})
