// No CONTRACT_GAPs: transaction-recurring-icon, its title and the optional
// recurringId / occurrenceDate fields are specified in the Interface Contract
// (component changes: TransactionsTable). The required mainCurrency prop comes
// from the EntryAmount contract; the onSave prop is replaced by onEdit.

import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Category, Expense } from '@/lib/domain'
import { TransactionsTable } from '@/components/transactions/TransactionsTable'

const categories: Array<Category> = [
  { id: 'cat-food', name: 'Food', icon: '🍔' },
  { id: 'cat-transport', name: 'Transport', icon: '🚌' },
]

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'tx-1',
    amount: 12.5,
    currency: 'UAH',
    categoryId: 'cat-food',
    description: 'Lunch',
    createdAt: '2026-03-15T12:00:00.000Z',
    category: categories[0],
    ...overrides,
  }
}

function renderTable(transactions: Array<Expense>) {
  return render(
    <TransactionsTable
      transactions={transactions}
      categories={categories}
      isLoading={false}
      isError={false}
      isDeleting={false}
      mainCurrency="UAH"
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />,
  )
}

function rowFor(description: string) {
  const row = screen
    .getAllByTestId('transaction-row')
    .find((r) => r.textContent.includes(description))
  if (!row) throw new Error(`no row with ${description}`)
  return row
}

describe('TransactionsTable recurring icon', () => {
  it('shows the Repeat icon with the title on a record that has recurringId', () => {
    renderTable([expense({ recurringId: 'r1', occurrenceDate: '2026-03-15' })])

    const icon = screen.getByTestId('transaction-recurring-icon')
    expect(icon.getAttribute('title')).toBe('From a recurring item')
    expect(icon.querySelector('svg')).not.toBeNull()
  })

  it('shows no icon on an ordinary record', () => {
    renderTable([expense()])

    expect(screen.queryByTestId('transaction-recurring-icon')).toBeNull()
  })

  it('shows the icon only on the generated rows of a mixed list', () => {
    renderTable([
      expense({ id: 'a', description: 'Generated', recurringId: 'r1' }),
      expense({ id: 'b', description: 'Manual' }),
      expense({
        id: 'c',
        description: 'Also generated',
        categoryId: 'cat-transport',
        category: categories[1],
        recurringId: 'r2',
      }),
    ])

    expect(screen.getAllByTestId('transaction-recurring-icon')).toHaveLength(2)
    expect(
      within(rowFor('Generated')).queryByTestId('transaction-recurring-icon'),
    ).not.toBeNull()
    expect(
      within(rowFor('Manual')).queryByTestId('transaction-recurring-icon'),
    ).toBeNull()
    expect(
      within(rowFor('Also generated')).queryByTestId('transaction-recurring-icon'),
    ).not.toBeNull()
  })

  it('keeps the category and description of a generated row intact', () => {
    renderTable([expense({ recurringId: 'r1' })])

    const row = screen.getByTestId('transaction-row')
    expect(row.textContent).toContain('Food')
    expect(row.textContent).toContain('🍔')
    expect(row.textContent).toContain('Lunch')
  })

  it('a record without a category still shows the icon next to "Uncategorized"', () => {
    renderTable([expense({ category: undefined, recurringId: 'r1' })])

    const row = screen.getByTestId('transaction-row')
    expect(row.textContent).toContain('Uncategorized')
    expect(within(row).queryByTestId('transaction-recurring-icon')).not.toBeNull()
  })

  it('a generated foreign-currency row shows its amount state next to the icon', () => {
    renderTable([expense({ currency: 'USD', recurringId: 'r1' })])

    const row = screen.getByTestId('transaction-row')
    expect(within(row).getByTestId('entry-amount').getAttribute('data-state')).toBe(
      'pending',
    )
    expect(within(row).queryByTestId('transaction-recurring-icon')).not.toBeNull()
  })
})
