// No CONTRACT_GAPs: the Interface Contract's "Component: DashboardSummarySection"
// section fully specifies props and every testid this file uses.

import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { BudgetWatchItem, DashboardSummary } from '@/lib/dashboardSummary'
import { computeDashboardSummary } from '@/lib/dashboardSummary'
import DashboardSummarySection from '@/components/index/DashboardSummarySection'

// The component needs a router context for `Link`. Per the contract's testing
// note, replace it with a plain anchor that forwards rest props (so
// data-testid survives) and drops `search`.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...rest
  }: {
    to: string
    search?: unknown
    children?: ReactNode
  } & Record<string, unknown>) => {
    void search
    return (
      <a href={to} {...rest}>
        {children}
      </a>
    )
  },
}))

// Locale-independent thousands-separator assertions, per the repo's testing rule.
const fmt = (n: number) => n.toLocaleString()

const baseSummary: DashboardSummary = {
  baseCurrency: 'UAH',
  monthIncome: 1000,
  monthExpenses: 400,
  net: 600,
  excluded: [],
  leftToSpend: null,
  dailyAllowance: null,
  pace: { spentSoFar: 400, lastMonthSameDay: 0, changePct: null },
  budgetWatch: [],
  recent: [],
}

describe('root wrapper and hero', () => {
  it('always renders the root wrapper and hero card testids', () => {
    render(<DashboardSummarySection summary={baseSummary} />)
    expect(screen.getByTestId('dashboard-summary')).toBeTruthy()
    expect(screen.getByTestId('dashboard-hero')).toBeTruthy()
  })
})

describe('criterion 9: hero left-to-spend vs no-budget fallback', () => {
  it('shows left-to-spend and daily allowance when leftToSpend is not null, and hides the fallback', () => {
    const dailyAllowance = 1100 / 17
    const summary: DashboardSummary = {
      ...baseSummary,
      leftToSpend: 1100,
      dailyAllowance,
    }
    render(<DashboardSummarySection summary={summary} />)

    const leftEl = screen.getByTestId('dashboard-left-to-spend')
    expect(leftEl.textContent).toContain(fmt(1100))
    expect(leftEl.textContent).toContain('UAH')

    const allowanceEl = screen.getByTestId('dashboard-daily-allowance')
    expect(allowanceEl.textContent).toContain(fmt(Math.round(dailyAllowance)))
    expect(allowanceEl.textContent).toContain('UAH')

    expect(screen.queryByTestId('dashboard-no-budget-fallback')).toBeNull()
  })

  it('shows the no-budget fallback (income/expenses/net + Settings link) when leftToSpend is null', () => {
    const summary: DashboardSummary = {
      ...baseSummary,
      leftToSpend: null,
      dailyAllowance: null,
      monthIncome: 1234,
      monthExpenses: 321,
      net: 913,
    }
    render(<DashboardSummarySection summary={summary} />)

    expect(screen.queryByTestId('dashboard-left-to-spend')).toBeNull()
    expect(screen.queryByTestId('dashboard-daily-allowance')).toBeNull()

    expect(screen.getByTestId('dashboard-no-budget-fallback')).toBeTruthy()

    const incomeEl = screen.getByTestId('dashboard-month-income')
    expect(incomeEl.textContent).toContain(fmt(1234))
    expect(incomeEl.textContent).toContain('UAH')

    const expensesEl = screen.getByTestId('dashboard-month-expenses')
    expect(expensesEl.textContent).toContain(fmt(321))
    expect(expensesEl.textContent).toContain('UAH')

    const netEl = screen.getByTestId('dashboard-month-net')
    expect(netEl.textContent).toContain(fmt(913))
    expect(netEl.textContent).toContain('UAH')

    const link = screen.getByTestId('dashboard-budget-setup-link')
    expect(link.getAttribute('href')).toBe('/settings')
  })
})

describe('criterion 10: pace line', () => {
  it('shows the rounded percentage and "less" (not the raw signed number or "more") when changePct is negative', () => {
    const summary: DashboardSummary = {
      ...baseSummary,
      pace: { spentSoFar: 880, lastMonthSameDay: 1000, changePct: -12.4 },
    }
    render(<DashboardSummarySection summary={summary} />)
    const pace = screen.getByTestId('dashboard-pace')
    expect(pace.textContent).toContain('12%')
    expect(pace.textContent).toContain('less')
    expect(pace.textContent).toContain('than this time last month')
    expect(pace.textContent).not.toContain('-12')
    expect(pace.textContent).not.toContain('more')
  })

  it('shows the rounded percentage, "more" and the spent amount (not "less") when changePct is positive', () => {
    const summary: DashboardSummary = {
      ...baseSummary,
      pace: { spentSoFar: 1256, lastMonthSameDay: 1000, changePct: 25.6 },
    }
    render(<DashboardSummarySection summary={summary} />)
    const pace = screen.getByTestId('dashboard-pace')
    expect(pace.textContent).toContain('26%')
    expect(pace.textContent).toContain('more')
    expect(pace.textContent).toContain(fmt(1256))
    expect(pace.textContent).toContain('UAH')
    expect(pace.textContent).not.toContain('less')
  })

  it('is absent when changePct is null', () => {
    render(<DashboardSummarySection summary={baseSummary} />)
    expect(screen.queryByTestId('dashboard-pace')).toBeNull()
  })
})

describe('criterion 11: excluded-currency line', () => {
  it('lists excluded amounts and currencies with a + prefix for income parts', () => {
    const summary: DashboardSummary = {
      ...baseSummary,
      excluded: [
        { currency: 'EUR', expenses: 0, income: 50 },
        { currency: 'USD', expenses: 120, income: 0 },
      ],
    }
    render(<DashboardSummarySection summary={summary} />)
    const el = screen.getByTestId('dashboard-excluded')
    expect(el.textContent).toContain(fmt(120))
    expect(el.textContent).toContain('USD')
    expect(el.textContent).toContain(fmt(50))
    expect(el.textContent).toContain('EUR')
    expect(el.textContent).toContain('+50')
  })

  it('is absent when excluded is empty', () => {
    render(<DashboardSummarySection summary={baseSummary} />)
    expect(screen.queryByTestId('dashboard-excluded')).toBeNull()
  })
})

describe('criterion 12: budget watch', () => {
  const budgetWatchItems: Array<BudgetWatchItem> = [
    {
      categoryId: 'cat-a',
      name: 'Food',
      spent: 90,
      limit: 100,
      ratio: 0.9,
      status: 'warning',
    },
    {
      categoryId: 'cat-b',
      name: 'Transport',
      spent: 120,
      limit: 100,
      ratio: 1.2,
      status: 'over',
    },
    {
      categoryId: 'cat-c',
      name: 'Rent',
      spent: 30,
      limit: 100,
      ratio: 0.3,
      status: 'ok',
    },
  ]

  it('is absent when budgetWatch is empty', () => {
    render(<DashboardSummarySection summary={baseSummary} />)
    expect(screen.queryByTestId('budget-watch')).toBeNull()
  })

  it('renders one item per entry, in order, with status/category attributes and correctly colored bars', () => {
    const summary: DashboardSummary = { ...baseSummary, budgetWatch: budgetWatchItems }
    render(<DashboardSummarySection summary={summary} />)

    expect(screen.getByTestId('budget-watch')).toBeTruthy()

    const items = screen.getAllByTestId('budget-watch-item')
    expect(items).toHaveLength(3)
    expect(items.map((el) => el.getAttribute('data-category-id'))).toEqual([
      'cat-a',
      'cat-b',
      'cat-c',
    ])
    expect(items.map((el) => el.getAttribute('data-status'))).toEqual([
      'warning',
      'over',
      'ok',
    ])
    expect(items[0].textContent).toContain('Food')
    expect(items[1].textContent).toContain('Transport')
    expect(items[2].textContent).toContain('Rent')

    const warningBar = within(items[0]).getByTestId('budget-watch-bar')
    expect(warningBar.className).toContain('bg-amber-500')

    const overBar = within(items[1]).getByTestId('budget-watch-bar')
    expect(overBar.className).toContain('bg-destructive')

    const okBar = within(items[2]).getByTestId('budget-watch-bar')
    expect(okBar.className).toContain('bg-primary')
  })
})

describe('criterion 20: empty-data render', () => {
  it('does not throw and shows the no-budget fallback with empty expenses/income/budgets', () => {
    const summary = computeDashboardSummary({
      expenses: [],
      income: [],
      budgets: [],
      categories: [],
      now: new Date(2026, 6, 15, 12, 0, 0),
    })

    expect(() =>
      render(<DashboardSummarySection summary={summary} />),
    ).not.toThrow()

    expect(screen.getByTestId('dashboard-summary')).toBeTruthy()
    expect(screen.getByTestId('dashboard-no-budget-fallback')).toBeTruthy()
    expect(screen.queryByTestId('dashboard-pace')).toBeNull()
    expect(screen.queryByTestId('dashboard-excluded')).toBeNull()
    expect(screen.queryByTestId('budget-watch')).toBeNull()
  })
})
