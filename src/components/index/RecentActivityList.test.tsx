// No CONTRACT_GAPs: the Interface Contract's "Component: RecentActivityList"
// section fully specifies props and every testid this file uses.

import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Expense, IncomeEntry } from '@/lib/domain'
import type { RecentItem } from '@/lib/dashboardSummary'
import RecentActivityList from '@/components/index/RecentActivityList'

const fmt = (n: number) => n.toLocaleString()

function mkExpenseItem(overrides: Partial<Expense> = {}): RecentItem {
  const expense: Expense = {
    id: 'exp-1',
    amount: 250,
    currency: 'UAH',
    categoryId: 'cat-food',
    createdAt: '2026-07-10T12:00:00.000Z',
    ...overrides,
  }
  return { ...expense, kind: 'expense' }
}

function mkIncomeItem(overrides: Partial<IncomeEntry> = {}): RecentItem {
  const income: IncomeEntry = {
    id: 'inc-1',
    source: 'Salary',
    amount: 500,
    currency: 'UAH',
    createdAt: '2026-07-11T12:00:00.000Z',
    ...overrides,
  }
  return { ...income, kind: 'income' }
}

describe('root wrapper and empty state', () => {
  it('renders the root wrapper testid and the empty-state card when items is empty', () => {
    render(<RecentActivityList items={[]} />)
    expect(screen.getByTestId('recent-activity')).toBeTruthy()
    expect(screen.getByTestId('recent-activity-empty')).toBeTruthy()
    expect(screen.queryAllByTestId('recent-activity-item')).toHaveLength(0)
  })

  it('hides the empty state when there is at least one item', () => {
    render(<RecentActivityList items={[mkExpenseItem()]} />)
    expect(screen.queryByTestId('recent-activity-empty')).toBeNull()
  })
})

describe('criterion 14: merged items, one row each, in order, tagged by kind', () => {
  it('renders one recent-activity-item per entry, in the given order, with data-kind', () => {
    const items = [
      mkExpenseItem({ id: 'e1' }),
      mkIncomeItem({ id: 'i1' }),
      mkExpenseItem({ id: 'e2' }),
    ]
    render(<RecentActivityList items={items} />)

    const rows = screen.getAllByTestId('recent-activity-item')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual([
      'expense',
      'income',
      'expense',
    ])
  })
})

describe('criterion 14: expense rows', () => {
  it('shows an amount with a leading "-", the currency, and no emerald color class', () => {
    const items = [mkExpenseItem({ amount: 250, currency: 'USD' })]
    render(<RecentActivityList items={items} />)

    const row = screen.getAllByTestId('recent-activity-item')[0]
    const amountEl = within(row).getByTestId('recent-activity-amount')

    expect(amountEl.textContent?.trim().startsWith('-')).toBe(true)
    expect(amountEl.textContent).toContain(fmt(250))
    expect(amountEl.textContent).toContain('USD')
    expect(amountEl.className).not.toContain('text-emerald')
  })
})

describe('criterion 14: income rows', () => {
  it('shows an amount with a leading "+", the currency, and the emerald color class', () => {
    const items = [mkIncomeItem({ amount: 500, currency: 'EUR' })]
    render(<RecentActivityList items={items} />)

    const row = screen.getAllByTestId('recent-activity-item')[0]
    const amountEl = within(row).getByTestId('recent-activity-amount')

    expect(amountEl.textContent?.trim().startsWith('+')).toBe(true)
    expect(amountEl.textContent).toContain(fmt(500))
    expect(amountEl.textContent).toContain('EUR')
    expect(amountEl.className).toContain('text-emerald-600')
  })
})

describe('criterion 14: currency always shown, per row', () => {
  it('shows the correct currency for each row when kinds and currencies differ', () => {
    const items = [
      mkExpenseItem({ currency: 'UAH' }),
      mkIncomeItem({ currency: 'USD' }),
    ]
    render(<RecentActivityList items={items} />)

    const rows = screen.getAllByTestId('recent-activity-item')
    expect(
      within(rows[0]).getByTestId('recent-activity-amount').textContent,
    ).toContain('UAH')
    expect(
      within(rows[1]).getByTestId('recent-activity-amount').textContent,
    ).toContain('USD')
  })
})
