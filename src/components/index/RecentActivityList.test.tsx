// No CONTRACT_GAPs: the Interface Contract's "Component: RecentActivityList"
// section plus the EntryAmount contract specify props (mainCurrency is now
// required) and every testid this file uses.
//
// i18n: the UI language is pinned in beforeEach; amounts are built with the
// @/i18n/format helpers and an explicit language. The Ukrainian wording is the
// Coder's, so the Ukrainian block asserts "Ukrainian, not the English text".

import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { EntryConversion, Expense, IncomeEntry } from '@/lib/domain'
import type { RecentItem } from '@/lib/dashboardSummary'
import { setLang } from '@/i18n/core'
import { formatAmount } from '@/i18n/format'
import { I18nProvider } from '@/i18n/react'
import RecentActivityList from '@/components/index/RecentActivityList'

const fmt2 = (n: number) => formatAmount(n, 'en')

function conv(overrides: Partial<EntryConversion> = {}): EntryConversion {
  return {
    mainCurrency: 'UAH',
    rate: 41.52,
    mainAmount: 830.4,
    rateDate: '2026-07-10',
    source: 'nbu',
    ...overrides,
  }
}

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
    categoryId: 'ic-salary',
    category: { id: 'ic-salary', name: 'Salary', icon: '💼' },
    amount: 500,
    currency: 'UAH',
    createdAt: '2026-07-11T12:00:00.000Z',
    ...overrides,
  }
  return { ...income, kind: 'income' }
}

function rowText(item: RecentItem): string {
  render(<RecentActivityList items={[item]} mainCurrency="UAH" />)
  return screen.getAllByTestId('recent-activity-item')[0].textContent
}

beforeEach(() => {
  setLang('en', { persist: false })
})

afterEach(() => {
  setLang('en', { persist: false })
})

describe('root wrapper and empty state', () => {
  it('renders the root wrapper testid and the empty-state card when items is empty', () => {
    render(<RecentActivityList items={[]} mainCurrency="UAH" />)
    expect(screen.getByTestId('recent-activity')).toBeTruthy()
    expect(screen.getByTestId('recent-activity-empty')).toBeTruthy()
    expect(screen.queryAllByTestId('recent-activity-item')).toHaveLength(0)
  })

  it('hides the empty state when there is at least one item', () => {
    render(<RecentActivityList items={[mkExpenseItem()]} mainCurrency="UAH" />)
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
    render(<RecentActivityList items={items} mainCurrency="UAH" />)

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
  it('shows a main-currency amount with a leading "-", 2 decimals, the currency, and no emerald color class', () => {
    const items = [mkExpenseItem({ amount: 250, currency: 'UAH' })]
    render(<RecentActivityList items={items} mainCurrency="UAH" />)

    const row = screen.getAllByTestId('recent-activity-item')[0]
    const amountEl = within(row).getByTestId('recent-activity-amount')

    expect(amountEl.textContent.trim().startsWith('-')).toBe(true)
    expect(amountEl.textContent).toContain(fmt2(250))
    expect(amountEl.textContent).toContain('UAH')
    expect(amountEl.className).not.toContain('text-emerald')
    expect(within(amountEl).getByTestId('entry-amount').getAttribute('data-state')).toBe(
      'main',
    )
  })
})

describe('criterion 14: income rows', () => {
  it('shows a main-currency amount with a leading "+", the currency, and the emerald color class', () => {
    const items = [mkIncomeItem({ amount: 500, currency: 'EUR' })]
    render(<RecentActivityList items={items} mainCurrency="EUR" />)

    const row = screen.getAllByTestId('recent-activity-item')[0]
    const amountEl = within(row).getByTestId('recent-activity-amount')

    expect(amountEl.textContent.trim().startsWith('+')).toBe(true)
    expect(amountEl.textContent).toContain(fmt2(500))
    expect(amountEl.textContent).toContain('EUR')
    expect(amountEl.className).toContain('text-emerald-600')
  })
})

describe('converted and pending amounts', () => {
  it('shows a USD expense as "20.00 USD ≈ 830.40 UAH" with the sign', () => {
    render(
      <RecentActivityList
        items={[mkExpenseItem({ amount: 20, currency: 'USD', conversion: conv() })]}
        mainCurrency="UAH"
      />,
    )

    const amountEl = screen.getByTestId('recent-activity-amount')
    expect(amountEl.textContent.trim().startsWith('-')).toBe(true)
    expect(amountEl.textContent).toContain(`${fmt2(20)} USD ≈ ${fmt2(830.4)} UAH`)
    expect(
      within(amountEl).getByTestId('entry-amount').getAttribute('data-state'),
    ).toBe('converted')
  })

  it('shows a converted income entry with the + sign and the emerald class', () => {
    render(
      <RecentActivityList
        items={[
          mkIncomeItem({
            amount: 10,
            currency: 'EUR',
            conversion: conv({ rate: 45.1, mainAmount: 451 }),
          }),
        ]}
        mainCurrency="UAH"
      />,
    )

    const amountEl = screen.getByTestId('recent-activity-amount')
    expect(amountEl.textContent.trim().startsWith('+')).toBe(true)
    expect(amountEl.textContent).toContain(`${fmt2(10)} EUR ≈ ${fmt2(451)} UAH`)
    expect(amountEl.className).toContain('text-emerald-600')
  })

  it('shows "rate pending" for an entry without a conversion', () => {
    render(
      <RecentActivityList
        items={[mkExpenseItem({ amount: 20, currency: 'USD' })]}
        mainCurrency="UAH"
      />,
    )

    const amountEl = screen.getByTestId('recent-activity-amount')
    expect(amountEl.textContent).toContain(`${fmt2(20)} USD · rate pending`)
    expect(amountEl.textContent).not.toContain('≈')
    expect(
      within(amountEl).getByTestId('entry-amount').getAttribute('data-state'),
    ).toBe('pending')
  })

  it('judges every row against the mainCurrency prop', () => {
    const items = [
      mkExpenseItem({ id: 'a', amount: 20, currency: 'USD', conversion: conv() }),
    ]
    const { rerender } = render(
      <RecentActivityList items={items} mainCurrency="UAH" />,
    )
    expect(screen.getByTestId('entry-amount').getAttribute('data-state')).toBe(
      'converted',
    )

    rerender(<RecentActivityList items={items} mainCurrency="EUR" />)
    expect(screen.getByTestId('entry-amount').getAttribute('data-state')).toBe(
      'pending',
    )
  })
})

describe('income rows show the income category', () => {
  it('shows the category name and icon', () => {
    const text = rowText(mkIncomeItem())

    expect(text).toContain('Salary')
    expect(text).toContain('💼')
    expect(text).not.toContain('💰')
  })

  it('shows another category name and icon for another entry', () => {
    const text = rowText(
      mkIncomeItem({
        categoryId: 'ic-gifts',
        category: { id: 'ic-gifts', name: 'Gifts', icon: '🎁' },
      }),
    )

    expect(text).toContain('Gifts')
    expect(text).toContain('🎁')
    expect(text).not.toContain('Salary')
  })

  it('uses the money-bag icon for a category without an icon', () => {
    const text = rowText(
      mkIncomeItem({
        category: { id: 'ic-salary', name: 'Salary', icon: null },
      }),
    )

    expect(text).toContain('Salary')
    expect(text).toContain('💰')
  })

  it('prefers the category name over a leftover legacy source', () => {
    const text = rowText(mkIncomeItem({ source: 'Old text' }))

    expect(text).toContain('Salary')
    expect(text).not.toContain('Old text')
  })

  it('falls back to the legacy source for an unconverted record', () => {
    const text = rowText(
      mkIncomeItem({
        categoryId: '',
        category: undefined,
        source: 'Freelance gig',
      }),
    )

    expect(text).toContain('Freelance gig')
    expect(text).toContain('💰')
    expect(text).not.toContain('Uncategorized')
  })

  it('falls back to Uncategorized when there is neither a category nor a source', () => {
    const text = rowText(mkIncomeItem({ categoryId: '', category: undefined }))

    expect(text).toContain('Uncategorized')
  })
})

describe('criterion 14: currency always shown, per row', () => {
  it('shows the correct currency for each row when kinds and currencies differ', () => {
    const items = [
      mkExpenseItem({ currency: 'UAH' }),
      mkIncomeItem({ currency: 'USD' }),
    ]
    render(<RecentActivityList items={items} mainCurrency="UAH" />)

    const rows = screen.getAllByTestId('recent-activity-item')
    expect(
      within(rows[0]).getByTestId('recent-activity-amount').textContent,
    ).toContain('UAH')
    expect(
      within(rows[1]).getByTestId('recent-activity-amount').textContent,
    ).toContain('USD')
  })
})

describe('in Ukrainian', () => {
  const CYRILLIC = /[Ѐ-ӿ]/

  function renderUk(items: Array<RecentItem>) {
    return render(
      <I18nProvider initialLang="uk">
        <RecentActivityList items={items} mainCurrency="UAH" />
      </I18nProvider>,
    )
  }

  it('shows signed amounts with грн and Ukrainian separators', () => {
    renderUk([mkExpenseItem({ amount: 1250.5 }), mkIncomeItem({ amount: 500 })])

    const amounts = screen.getAllByTestId('recent-activity-amount').map((a) => a.textContent)
    expect(amounts[0].trim().startsWith('-')).toBe(true)
    expect(amounts[0]).toMatch(/1\s250,50 грн/u)
    expect(amounts[1].trim().startsWith('+')).toBe(true)
    expect(amounts[1]).toContain(`${formatAmount(500, 'uk')} грн`)
    expect(amounts[0]).not.toContain('UAH')
  })

  it('shows a converted amount with грн only on the hryvnia', () => {
    renderUk([mkExpenseItem({ amount: 20, currency: 'USD', conversion: conv() })])

    expect(screen.getByTestId('entry-amount').textContent).toBe('-20,00 USD ≈ 830,40 грн')
  })

  it('translates the empty state', () => {
    renderUk([])

    const text = screen.getByTestId('recent-activity-empty').textContent
    expect(text).toMatch(CYRILLIC)
  })

  it('translates the Uncategorized fallback and keeps category names as typed', () => {
    renderUk([
      mkIncomeItem(),
      mkIncomeItem({ id: 'inc-2', categoryId: '', category: undefined }),
    ])

    const rows = screen.getAllByTestId('recent-activity-item').map((r) => r.textContent)
    expect(rows[0]).toContain('Salary')
    expect(rows[1]).not.toContain('Uncategorized')
    expect(rows[1]).toMatch(CYRILLIC)
  })
})
