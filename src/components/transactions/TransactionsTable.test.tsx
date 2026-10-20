// No CONTRACT_GAPs: props and testids for TransactionsTable are fully specified
// in the Interface Contract; the required mainCurrency prop and the EntryAmount
// cell (data-testid="entry-amount") come from the EntryAmount contract.
//
// The inline row editor is gone: the edit button now calls onEdit(tx), and the
// tests of the old editor (prefill, validation, Escape, Enter, failed save) live
// in ExpenseDrawer.test.tsx.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Category, Currency, EntryConversion, Expense } from '@/lib/domain'
import { TransactionsTable } from '@/components/transactions/TransactionsTable'

const fmt2 = (n: number) =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

const categories: Array<Category> = [
  { id: 'cat-food', name: 'Food', icon: '🍔' },
  { id: 'cat-transport', name: 'Transport', icon: '🚌' },
]

const txFood: Expense = {
  id: 'tx-1',
  amount: 12.5,
  currency: 'UAH',
  categoryId: 'cat-food',
  description: 'Lunch',
  createdAt: '2026-03-15T12:00:00.000Z',
  category: categories[0],
}

const txTransport: Expense = {
  id: 'tx-2',
  amount: 40,
  currency: 'USD',
  categoryId: 'cat-transport',
  description: 'Taxi',
  createdAt: '2026-04-02T09:30:00.000Z',
  category: categories[1],
}

function renderTable(
  transactions: Array<Expense>,
  overrides: Partial<{
    onEdit: (expense: Expense) => void
    onDelete: (id: string, createdAt: string) => void
    mainCurrency: Currency
  }> = {},
) {
  const onEdit = overrides.onEdit ?? vi.fn<(expense: Expense) => void>()
  const onDelete = overrides.onDelete ?? vi.fn()
  const utils = render(
    <TransactionsTable
      transactions={transactions}
      categories={categories}
      isLoading={false}
      isError={false}
      isDeleting={false}
      mainCurrency={overrides.mainCurrency ?? 'UAH'}
      onEdit={onEdit}
      onDelete={onDelete}
    />,
  )
  return { ...utils, onEdit, onDelete }
}

function conversion(overrides: Partial<EntryConversion> = {}): EntryConversion {
  return {
    mainCurrency: 'UAH',
    rate: 41.52,
    mainAmount: 1660.8,
    rateDate: '2026-04-02',
    source: 'nbu',
    ...overrides,
  }
}

describe('TransactionsTable amount cell', () => {
  it('shows a main-currency expense as the plain amount with 2 decimals', () => {
    renderTable([txFood])

    const amount = within(screen.getByTestId('transaction-row')).getByTestId(
      'entry-amount',
    )
    expect(amount.getAttribute('data-state')).toBe('main')
    expect(amount.textContent).toBe(`${fmt2(12.5)} UAH`)
  })

  it('shows a converted expense as "typed ≈ main"', () => {
    renderTable([{ ...txTransport, conversion: conversion() }])

    const amount = screen.getByTestId('entry-amount')
    expect(amount.getAttribute('data-state')).toBe('converted')
    expect(amount.textContent).toBe(`${fmt2(40)} USD ≈ ${fmt2(1660.8)} UAH`)
  })

  it('shows an expense without a conversion as "rate pending"', () => {
    renderTable([txTransport])

    const amount = screen.getByTestId('entry-amount')
    expect(amount.getAttribute('data-state')).toBe('pending')
    expect(amount.textContent).toBe(`${fmt2(40)} USD · rate pending`)
  })

  it('renders one amount per row, each judged on its own conversion', () => {
    renderTable([
      txFood,
      { ...txTransport, conversion: conversion() },
      { ...txTransport, id: 'tx-3' },
    ])

    const states = screen
      .getAllByTestId('entry-amount')
      .map((el) => el.getAttribute('data-state'))
    expect(states).toEqual(['main', 'converted', 'pending'])
  })

  it('follows the mainCurrency prop', () => {
    renderTable([txFood], { mainCurrency: 'EUR' })

    expect(screen.getByTestId('entry-amount').getAttribute('data-state')).toBe(
      'pending',
    )
  })

  it('no longer prefixes a currency symbol', () => {
    renderTable([txFood, txTransport])

    const text = screen.getAllByTestId('transaction-row')[0].textContent
    expect(text).not.toContain('₴')
    expect(screen.getAllByTestId('transaction-row')[1].textContent).not.toContain('$')
  })
})

describe('TransactionsTable edit button', () => {
  it('calls onEdit with the expense of the clicked row', () => {
    const { onEdit } = renderTable([txFood, txTransport])

    fireEvent.click(screen.getAllByTestId('transaction-edit-button')[0])

    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith(txFood)
  })

  it('calls onEdit with the expense of another row', () => {
    const { onEdit } = renderTable([txFood, txTransport])

    fireEvent.click(screen.getAllByTestId('transaction-edit-button')[1])

    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith(txTransport)
  })

  it('has an accessible name', () => {
    renderTable([txFood])

    expect(
      screen.getByTestId('transaction-edit-button').getAttribute('aria-label'),
    ).toBe('Edit transaction')
  })

  it('never turns the row into an inline editor', () => {
    renderTable([txFood, txTransport])

    fireEvent.click(screen.getAllByTestId('transaction-edit-button')[0])

    expect(screen.queryByTestId('transaction-edit-row')).toBeNull()
    for (const id of [
      'edit-date-input',
      'edit-amount-input',
      'edit-currency-select',
      'edit-category-select',
      'edit-description-input',
      'edit-save-button',
      'edit-cancel-button',
      'edit-error-amount',
    ]) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
    expect(screen.getAllByTestId('transaction-row')).toHaveLength(2)
  })

  it('keeps the delete buttons enabled after an edit click', () => {
    renderTable([txFood, txTransport])

    fireEvent.click(screen.getAllByTestId('transaction-edit-button')[0])

    const deleteButtons = screen.getAllByTestId<HTMLButtonElement>(
      'transaction-delete-button',
    )
    expect(deleteButtons).toHaveLength(2)
    expect(deleteButtons[0].disabled).toBe(false)
    expect(deleteButtons[1].disabled).toBe(false)
  })

  it('does not call onDelete when editing', () => {
    const { onDelete } = renderTable([txFood])

    fireEvent.click(screen.getByTestId('transaction-edit-button'))

    expect(onDelete).not.toHaveBeenCalled()
  })

  it('disables the delete buttons while a delete runs, but not the edit buttons', () => {
    render(
      <TransactionsTable
        transactions={[txFood]}
        categories={categories}
        isLoading={false}
        isError={false}
        isDeleting
        mainCurrency="UAH"
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(
      screen.getByTestId<HTMLButtonElement>('transaction-delete-button').disabled,
    ).toBe(true)
    expect(
      screen.getByTestId<HTMLButtonElement>('transaction-edit-button').disabled,
    ).toBe(false)
  })
})
