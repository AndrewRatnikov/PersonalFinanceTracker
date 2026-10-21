// No CONTRACT_GAPs: IncomeTable props and the income-row / income-row-category
// testids are fully specified in the Interface Contract; the required
// mainCurrency prop and the EntryAmount cell (data-testid="entry-amount") come
// from the EntryAmount contract.
//
// i18n: the UI language is pinned in beforeEach; amounts and dates are built
// with the @/i18n/format helpers and an explicit language. The Ukrainian wording
// of headers and fallbacks is the Coder's, so those cases assert "Ukrainian, not
// the English text".

import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EntryConversion, IncomeEntry } from '@/lib/domain'
import { setLang } from '@/i18n/core'
import { formatAmount, formatFullDate } from '@/i18n/format'
import { I18nProvider } from '@/i18n/react'
import { IncomeTable } from '@/components/income/IncomeTable'

const fmt2 = (n: number) => formatAmount(n, 'en')

function entry(overrides: Partial<IncomeEntry> = {}): IncomeEntry {
  return {
    id: 'i1',
    categoryId: 'ic1',
    category: { id: 'ic1', name: 'Salary', icon: '💼' },
    amount: 1000,
    currency: 'UAH',
    createdAt: '2026-03-10T12:00:00.000Z',
    ...overrides,
  }
}

function conversion(overrides: Partial<EntryConversion> = {}): EntryConversion {
  return {
    mainCurrency: 'UAH',
    rate: 45.1,
    mainAmount: 22550,
    rateDate: '2026-03-10',
    source: 'nbu',
    ...overrides,
  }
}

function renderTable(income: Array<IncomeEntry>) {
  return render(
    <IncomeTable
      income={income}
      isLoading={false}
      isError={false}
      isDeleting={false}
      mainCurrency="UAH"
      onDelete={vi.fn()}
    />,
  )
}

beforeEach(() => {
  setLang('en', { persist: false })
})

afterEach(() => {
  setLang('en', { persist: false })
})

describe('IncomeTable header', () => {
  it('has a Category column and no Source column', () => {
    renderTable([entry()])

    expect(screen.getByText('Category')).toBeTruthy()
    expect(screen.queryByText('Source')).toBeNull()
  })
})

describe('IncomeTable category cell', () => {
  it('shows the category icon and name', () => {
    renderTable([entry()])

    const cell = screen.getByTestId('income-row-category')
    expect(cell.textContent).toContain('💼')
    expect(cell.textContent).toContain('Salary')
  })

  it('shows a different category name for a different entry', () => {
    renderTable([
      entry({
        id: 'i2',
        categoryId: 'ic2',
        category: { id: 'ic2', name: 'Gifts', icon: '🎁' },
      }),
    ])

    const cell = screen.getByTestId('income-row-category')
    expect(cell.textContent).toContain('Gifts')
    expect(cell.textContent).toContain('🎁')
    expect(cell.textContent).not.toContain('Salary')
  })

  it('shows only the name for a category without an icon', () => {
    renderTable([
      entry({ category: { id: 'ic1', name: 'Salary', icon: null } }),
    ])

    expect(screen.getByTestId('income-row-category').textContent.trim()).toBe(
      'Salary',
    )
  })

  it('prefers the category name over a leftover legacy source', () => {
    renderTable([entry({ source: 'Old text' })])

    const cell = screen.getByTestId('income-row-category')
    expect(cell.textContent).toContain('Salary')
    expect(cell.textContent).not.toContain('Old text')
  })

  it('falls back to the legacy source for an unconverted record', () => {
    renderTable([
      entry({ categoryId: '', category: undefined, source: '  Freelance gig ' }),
    ])

    const cell = screen.getByTestId('income-row-category')
    expect(cell.textContent).toContain('Freelance gig')
    expect(cell.textContent).not.toContain('Uncategorized')
  })

  it('falls back to Uncategorized when there is no category and no source', () => {
    renderTable([entry({ categoryId: '', category: undefined })])

    expect(screen.getByTestId('income-row-category').textContent).toContain(
      'Uncategorized',
    )
  })

  it('treats a blank legacy source as missing', () => {
    renderTable([
      entry({ categoryId: '', category: undefined, source: '   ' }),
    ])

    expect(screen.getByTestId('income-row-category').textContent).toContain(
      'Uncategorized',
    )
  })
})

describe('IncomeTable amount cell', () => {
  it('shows a main-currency entry as the plain amount with 2 decimals', () => {
    renderTable([entry()])

    const amount = within(screen.getByTestId('income-row')).getByTestId(
      'entry-amount',
    )
    expect(amount.getAttribute('data-state')).toBe('main')
    expect(amount.textContent).toBe(`${fmt2(1000)} UAH`)
  })

  it('shows a converted entry as "typed ≈ main"', () => {
    renderTable([entry({ amount: 500, currency: 'EUR', conversion: conversion() })])

    const amount = screen.getByTestId('entry-amount')
    expect(amount.getAttribute('data-state')).toBe('converted')
    expect(amount.textContent).toBe(`${fmt2(500)} EUR ≈ ${fmt2(22550)} UAH`)
  })

  it('shows an entry without a conversion as "rate pending"', () => {
    renderTable([entry({ amount: 500, currency: 'EUR' })])

    const amount = screen.getByTestId('entry-amount')
    expect(amount.getAttribute('data-state')).toBe('pending')
    expect(amount.textContent).toBe(`${fmt2(500)} EUR · rate pending`)
  })

  it('no longer prefixes a currency symbol', () => {
    renderTable([entry({ currency: 'EUR', amount: 5 })])

    expect(screen.getByTestId('income-row').textContent).not.toContain('€')
  })
})

describe('IncomeTable date cell', () => {
  it('shows the full date with the English month', () => {
    const first = entry()
    const second = entry({ id: 'i2', createdAt: '2026-05-20T12:00:00.000Z' })
    renderTable([first, second])

    const rows = screen.getAllByTestId('income-row')
    expect(rows[0].textContent).toContain(formatFullDate(first.createdAt, 'en'))
    expect(rows[1].textContent).toContain(formatFullDate(second.createdAt, 'en'))
    expect(rows[0].textContent).not.toContain(formatFullDate(second.createdAt, 'en'))
  })
})

describe('IncomeTable rows', () => {
  it('renders one income-row per entry, in the given order', () => {
    renderTable([
      entry({ id: 'a', amount: 10 }),
      entry({
        id: 'b',
        amount: 20,
        categoryId: 'ic2',
        category: { id: 'ic2', name: 'Gifts', icon: null },
      }),
      entry({ id: 'c', amount: 30, categoryId: '', category: undefined }),
    ])

    const rows = screen.getAllByTestId('income-row')
    expect(rows).toHaveLength(3)
    const label = (i: number) =>
      within(rows[i]).getByTestId('income-row-category').textContent
    expect(label(0)).toContain('Salary')
    expect(label(1)).toContain('Gifts')
    expect(label(2)).toContain('Uncategorized')
    expect(rows[0].textContent).toContain(fmt2(10))
    expect(rows[1].textContent).toContain(fmt2(20))
  })

  it('renders no income-row while loading, on error or when empty', () => {
    const { rerender } = render(
      <IncomeTable
        income={[]}
        isLoading
        isError={false}
        isDeleting={false}
        mainCurrency="UAH"
        onDelete={vi.fn()}
      />,
    )
    expect(screen.queryAllByTestId('income-row')).toHaveLength(0)

    rerender(
      <IncomeTable
        income={[]}
        isLoading={false}
        isError
        isDeleting={false}
        mainCurrency="UAH"
        onDelete={vi.fn()}
      />,
    )
    expect(screen.queryAllByTestId('income-row')).toHaveLength(0)

    rerender(
      <IncomeTable
        income={[]}
        isLoading={false}
        isError={false}
        isDeleting={false}
        mainCurrency="UAH"
        onDelete={vi.fn()}
      />,
    )
    expect(screen.queryAllByTestId('income-row')).toHaveLength(0)
    expect(screen.getByText('No income recorded yet')).toBeTruthy()
  })
})

describe('IncomeTable in Ukrainian', () => {
  function renderUk(income: Array<IncomeEntry>) {
    return render(
      <I18nProvider initialLang="uk">
        <IncomeTable
          income={income}
          isLoading={false}
          isError={false}
          isDeleting={false}
          mainCurrency="UAH"
          onDelete={vi.fn()}
        />
      </I18nProvider>,
    )
  }

  it('shows amounts with грн and Ukrainian separators', () => {
    renderUk([entry({ amount: 1234.5 })])

    const amount = screen.getByTestId('entry-amount').textContent
    expect(amount).toMatch(/^1\s234,50 грн$/u)
  })

  it('shows the date with the Ukrainian month', () => {
    const row = entry()
    renderUk([row])

    const text = screen.getByTestId('income-row').textContent
    expect(text).toContain(formatFullDate(row.createdAt, 'uk'))
    expect(text).toContain('бер.')
    expect(text).not.toContain(formatFullDate(row.createdAt, 'en'))
  })

  it('translates the header and the Uncategorized fallback, and keeps category names as typed', () => {
    renderUk([
      entry(),
      entry({ id: 'i2', categoryId: '', category: undefined }),
    ])

    expect(screen.queryByText('Category')).toBeNull()
    const cells = screen.getAllByTestId('income-row-category').map((c) => c.textContent)
    expect(cells[0]).toContain('Salary')
    expect(cells[1]).toMatch(/[Ѐ-ӿ]/)
    expect(cells[1]).not.toContain('Uncategorized')
  })

  it('translates the empty state', () => {
    renderUk([])

    expect(screen.queryByText('No income recorded yet')).toBeNull()
    expect(screen.queryAllByTestId('income-row')).toHaveLength(0)
  })
})
