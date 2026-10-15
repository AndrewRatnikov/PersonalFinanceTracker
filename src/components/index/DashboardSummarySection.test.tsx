// No CONTRACT_GAPs: the Interface Contract's "Component: DashboardSummarySection"
// section plus the ConversionPendingNote contract specify props (summary,
// optional fetchExchangeRates) and every testid this file uses.

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

// Locale-independent assertions: every amount is shown with 2 decimals.
const fmt = (n: number) =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

// Counts non-overlapping occurrences of `needle` in `haystack` (no RegExp, so
// no escaping concerns with non-ASCII separators).
const countOccurrences = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1

const baseSummary: DashboardSummary = {
  mainCurrency: 'UAH',
  monthIncome: 1000,
  monthExpenses: 400,
  net: 600,
  pendingCount: 0,
  budgetsExcluded: 0,
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
  it('shows left-to-spend and daily allowance (2 decimals, not rounded to whole) when leftToSpend is not null, and hides the fallback', () => {
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
    expect(allowanceEl.textContent).toContain(fmt(dailyAllowance))
    expect(allowanceEl.textContent).not.toContain(fmt(Math.round(dailyAllowance)))
    expect(allowanceEl.textContent).toContain('UAH')

    expect(screen.queryByTestId('dashboard-no-budget-fallback')).toBeNull()
  })

  it('no budget: each month figure appears exactly once, inside the hero, with 2 decimals and currency', () => {
    const summary: DashboardSummary = {
      ...baseSummary,
      leftToSpend: null,
      dailyAllowance: null,
      monthIncome: 1234,
      monthExpenses: 321,
      net: 913,
      // No pace figure so its amount cannot add a stray occurrence.
      pace: { spentSoFar: 0, lastMonthSameDay: 0, changePct: null },
    }
    render(<DashboardSummarySection summary={summary} />)

    expect(screen.queryByTestId('dashboard-left-to-spend')).toBeNull()
    expect(screen.queryByTestId('dashboard-daily-allowance')).toBeNull()

    const hero = screen.getByTestId('dashboard-hero')
    const cases: Array<[string, number]> = [
      ['dashboard-month-income', 1234],
      ['dashboard-month-expenses', 321],
      ['dashboard-month-net', 913],
    ]
    for (const [id, value] of cases) {
      expect(screen.getAllByTestId(id)).toHaveLength(1)
      const el = within(hero).getByTestId(id)
      expect(el.textContent).toContain(fmt(value))
      expect(el.textContent).toContain('UAH')
    }

    // Each value appears exactly once in the whole rendered section.
    const all = screen.getByTestId('dashboard-summary').textContent
    expect(countOccurrences(all, fmt(1234))).toBe(1)
    expect(countOccurrences(all, fmt(321))).toBe(1)
    expect(countOccurrences(all, fmt(913))).toBe(1)
  })

  it('no budget: figures follow the data (different values, still once each)', () => {
    const summary: DashboardSummary = {
      ...baseSummary,
      monthIncome: 5678,
      monthExpenses: 432,
      net: 5246,
      pace: { spentSoFar: 0, lastMonthSameDay: 0, changePct: null },
    }
    render(<DashboardSummarySection summary={summary} />)

    const hero = screen.getByTestId('dashboard-hero')
    expect(
      within(hero).getByTestId('dashboard-month-income').textContent,
    ).toContain(fmt(5678))
    expect(
      within(hero).getByTestId('dashboard-month-expenses').textContent,
    ).toContain(fmt(432))
    expect(
      within(hero).getByTestId('dashboard-month-net').textContent,
    ).toContain(fmt(5246))

    const all = screen.getByTestId('dashboard-summary').textContent
    expect(countOccurrences(all, fmt(5678))).toBe(1)
    expect(countOccurrences(all, fmt(432))).toBe(1)
    expect(countOccurrences(all, fmt(5246))).toBe(1)
    expect(countOccurrences(all, fmt(1234))).toBe(0)
  })

  it('no budget: the figures are in the summary main currency', () => {
    render(
      <DashboardSummarySection summary={{ ...baseSummary, mainCurrency: 'EUR' }} />,
    )

    expect(screen.getByTestId('dashboard-month-income').textContent).toContain(
      'EUR',
    )
    expect(screen.getByTestId('dashboard-month-income').textContent).not.toContain(
      'UAH',
    )
  })

  it('no budget: the setup link is in the hero alongside the figures and points to /settings', () => {
    render(<DashboardSummarySection summary={baseSummary} />)

    const hero = screen.getByTestId('dashboard-hero')
    const fallback = within(hero).getByTestId('dashboard-no-budget-fallback')
    const link = within(fallback).getByTestId('dashboard-budget-setup-link')
    expect(link.getAttribute('href')).toBe('/settings')
    expect(within(fallback).getByTestId('dashboard-month-income')).toBeTruthy()
    expect(
      within(fallback).getByTestId('dashboard-month-expenses'),
    ).toBeTruthy()
    expect(within(fallback).getByTestId('dashboard-month-net')).toBeTruthy()
  })

  it('no budget: BudgetSummaryCard is not rendered', () => {
    render(<DashboardSummarySection summary={baseSummary} />)

    expect(screen.queryByTestId('budget-summary-card')).toBeNull()
    expect(screen.queryByTestId('budget-summary-income')).toBeNull()
    expect(screen.queryByTestId('budget-summary-expenses')).toBeNull()
    expect(screen.queryByTestId('budget-summary-net-balance')).toBeNull()
  })

  it('no budget: net is red when negative', () => {
    const summary: DashboardSummary = {
      ...baseSummary,
      monthIncome: 100,
      monthExpenses: 250,
      net: -150,
    }
    render(<DashboardSummarySection summary={summary} />)

    const net = screen.getByTestId('dashboard-month-net')
    expect(net.className).toContain('text-destructive')
    expect(net.textContent).toContain(fmt(-150))
  })

  it('no budget: net is not red when positive or zero', () => {
    const { unmount } = render(
      <DashboardSummarySection summary={{ ...baseSummary, net: 600 }} />,
    )
    expect(screen.getByTestId('dashboard-month-net').className).not.toContain(
      'text-destructive',
    )
    unmount()

    render(
      <DashboardSummarySection
        summary={{
          ...baseSummary,
          monthIncome: 300,
          monthExpenses: 300,
          net: 0,
        }}
      />,
    )
    expect(screen.getByTestId('dashboard-month-net').className).not.toContain(
      'text-destructive',
    )
  })

  it('no budget with pending entries: the note renders and BudgetSummaryCard stays absent', () => {
    const summary: DashboardSummary = { ...baseSummary, pendingCount: 2 }
    render(<DashboardSummarySection summary={summary} />)

    expect(screen.getByTestId('conversion-pending-note').textContent).toBe(
      '2 entries waiting for exchange rates',
    )
    expect(screen.queryByTestId('budget-summary-card')).toBeNull()
    expect(screen.getByTestId('dashboard-month-income')).toBeTruthy()
  })

  it('with budget: hero shows left-to-spend and allowance, no month testids or setup link, BudgetSummaryCard present once per figure', () => {
    const summary: DashboardSummary = {
      ...baseSummary,
      leftToSpend: 1100,
      dailyAllowance: 1100 / 17,
      monthIncome: 1234,
      monthExpenses: 321,
      net: 913,
    }
    render(<DashboardSummarySection summary={summary} />)

    expect(screen.getByTestId('dashboard-left-to-spend')).toBeTruthy()
    expect(screen.getByTestId('dashboard-daily-allowance')).toBeTruthy()
    expect(screen.queryByTestId('dashboard-month-income')).toBeNull()
    expect(screen.queryByTestId('dashboard-month-expenses')).toBeNull()
    expect(screen.queryByTestId('dashboard-month-net')).toBeNull()
    expect(screen.queryByTestId('dashboard-no-budget-fallback')).toBeNull()
    expect(screen.queryByTestId('dashboard-budget-setup-link')).toBeNull()

    expect(screen.getByTestId('budget-summary-card')).toBeTruthy()
    const income = screen.getAllByTestId('budget-summary-income')
    const expenses = screen.getAllByTestId('budget-summary-expenses')
    const net = screen.getAllByTestId('budget-summary-net-balance')
    expect(income).toHaveLength(1)
    expect(expenses).toHaveLength(1)
    expect(net).toHaveLength(1)
    expect(income[0].textContent).toContain(fmt(1234))
    expect(expenses[0].textContent).toContain(fmt(321))
    expect(net[0].textContent).toContain(fmt(913))

    const all = screen.getByTestId('dashboard-summary').textContent
    expect(countOccurrences(all, fmt(1234))).toBe(1)
    expect(countOccurrences(all, fmt(321))).toBe(1)
    expect(countOccurrences(all, fmt(913))).toBe(1)
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

describe('criterion 11: pending-entries note replaces the "Not included" line', () => {
  it('shows the note with the count when entries are pending', () => {
    render(<DashboardSummarySection summary={{ ...baseSummary, pendingCount: 3 }} />)

    expect(screen.getByTestId('conversion-pending-note').textContent).toBe(
      '3 entries waiting for exchange rates',
    )
  })

  it('uses the singular for one pending entry', () => {
    render(<DashboardSummarySection summary={{ ...baseSummary, pendingCount: 1 }} />)

    expect(screen.getByTestId('conversion-pending-note').textContent).toBe(
      '1 entry waiting for exchange rates',
    )
  })

  it('is absent when nothing is pending', () => {
    render(<DashboardSummarySection summary={baseSummary} />)

    expect(screen.queryByTestId('conversion-pending-note')).toBeNull()
  })

  it('also renders with a budget set', () => {
    const summary: DashboardSummary = {
      ...baseSummary,
      leftToSpend: 1100,
      dailyAllowance: 1100 / 17,
      pendingCount: 1,
    }
    render(<DashboardSummarySection summary={summary} />)

    expect(screen.getByTestId('conversion-pending-note')).toBeTruthy()
    expect(screen.getByTestId('budget-summary-card')).toBeTruthy()
  })

  it('comes right after the hero, before the budget summary and the budget watch', () => {
    const summary: DashboardSummary = {
      ...baseSummary,
      leftToSpend: 1100,
      dailyAllowance: 1100 / 17,
      pendingCount: 1,
      budgetWatch: [
        {
          categoryId: 'cat-a',
          name: 'Food',
          spent: 10,
          limit: 100,
          ratio: 0.1,
          status: 'ok',
        },
      ],
    }
    render(<DashboardSummarySection summary={summary} />)

    const hero = screen.getByTestId('dashboard-hero')
    const note = screen.getByTestId('conversion-pending-note')
    const card = screen.getByTestId('budget-summary-card')
    const watch = screen.getByTestId('budget-watch')
    expect(hero.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(note.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(note.compareDocumentPosition(watch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('has no settings link while rates are on (the default)', () => {
    render(<DashboardSummarySection summary={{ ...baseSummary, pendingCount: 2 }} />)

    expect(screen.queryByTestId('conversion-pending-settings-link')).toBeNull()
  })

  it('links to Settings when exchange rates are off', () => {
    render(
      <DashboardSummarySection
        summary={{ ...baseSummary, pendingCount: 2 }}
        fetchExchangeRates={false}
      />,
    )

    const link = screen.getByTestId('conversion-pending-settings-link')
    expect(link.getAttribute('href')).toBe('/settings')
  })

  it('shows the budget note for budgets in another currency', () => {
    render(
      <DashboardSummarySection summary={{ ...baseSummary, budgetsExcluded: 1 }} />,
    )

    expect(screen.getByTestId('budget-conversion-pending-note')).toBeTruthy()
    expect(screen.queryByTestId('conversion-pending-note')).toBeNull()
    // Without a comparable budget there is still no BudgetSummaryCard.
    expect(screen.queryByTestId('budget-summary-card')).toBeNull()
  })

  it('no longer renders the excluded-currency line or "Not included"', () => {
    render(
      <DashboardSummarySection
        summary={{ ...baseSummary, pendingCount: 2, budgetsExcluded: 1 }}
      />,
    )

    expect(screen.queryByTestId('dashboard-excluded')).toBeNull()
    expect(screen.getByTestId('dashboard-summary').textContent).not.toContain(
      'Not included',
    )
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
    const summary: DashboardSummary = {
      ...baseSummary,
      budgetWatch: budgetWatchItems,
    }
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

  it('shows spent and limit with 2 decimals in the main currency', () => {
    const summary: DashboardSummary = {
      ...baseSummary,
      mainCurrency: 'EUR',
      budgetWatch: [{ ...budgetWatchItems[0], spent: 33.333333, limit: 100 }],
    }
    render(<DashboardSummarySection summary={summary} />)

    const item = screen.getByTestId('budget-watch-item')
    expect(item.textContent).toContain(fmt(33.33))
    expect(item.textContent).toContain(fmt(100))
    expect(item.textContent).toContain('EUR')
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
    expect(screen.getByTestId('dashboard-month-income')).toBeTruthy()
    expect(screen.getByTestId('dashboard-month-expenses')).toBeTruthy()
    expect(screen.getByTestId('dashboard-month-net')).toBeTruthy()
    expect(screen.queryByTestId('dashboard-pace')).toBeNull()
    expect(screen.queryByTestId('conversion-pending-note')).toBeNull()
    expect(screen.queryByTestId('budget-watch')).toBeNull()
  })
})
