// No CONTRACT_GAPs: props and testids for TransactionsTable and ExpenseRowEditor
// are fully specified in the Interface Contract.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Category, Expense } from '@/lib/domain'
import { TransactionsTable } from '@/components/transactions/TransactionsTable'

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
  overrides: Partial<{ onSave: any; onDelete: any }> = {},
) {
  const onSave = overrides.onSave ?? vi.fn().mockResolvedValue(undefined)
  const onDelete = overrides.onDelete ?? vi.fn()
  const utils = render(
    <TransactionsTable
      transactions={transactions}
      categories={categories}
      isLoading={false}
      isError={false}
      isDeleting={false}
      onSave={onSave}
      onDelete={onDelete}
    />,
  )
  return { ...utils, onSave, onDelete }
}

describe('TransactionsTable inline row editing', () => {
  describe('criterion 6: entering edit mode', () => {
    it('turns the clicked row into an editor prefilled with that row\'s own values', () => {
      renderTable([txFood, txTransport])

      const editButtons = screen.getAllByTestId('transaction-edit-button')
      fireEvent.click(editButtons[0])

      expect(screen.getByTestId('transaction-edit-row')).toBeTruthy()
      expect(
        screen.getByTestId<HTMLInputElement>('edit-date-input').value,
      ).toBe('2026-03-15')
      expect(
        screen.getByTestId<HTMLInputElement>('edit-amount-input').value,
      ).toBe('12.5')
      expect(
        screen.getByTestId<HTMLSelectElement>('edit-currency-select')
          .value,
      ).toBe('UAH')
      expect(
        screen.getByTestId<HTMLSelectElement>('edit-category-select')
          .value,
      ).toBe('cat-food')
      expect(
        screen.getByTestId<HTMLInputElement>('edit-description-input')
          .value,
      ).toBe('Lunch')
    })

    it('prefills a different row with its own (different) values, proving the editor is not hardcoded', () => {
      renderTable([txFood, txTransport])

      const editButtons = screen.getAllByTestId('transaction-edit-button')
      fireEvent.click(editButtons[1])

      expect(
        screen.getByTestId<HTMLInputElement>('edit-date-input').value,
      ).toBe('2026-04-02')
      expect(
        screen.getByTestId<HTMLInputElement>('edit-amount-input').value,
      ).toBe('40')
      expect(
        screen.getByTestId<HTMLSelectElement>('edit-currency-select')
          .value,
      ).toBe('USD')
      expect(
        screen.getByTestId<HTMLSelectElement>('edit-category-select')
          .value,
      ).toBe('cat-transport')
    })
  })

  describe('criterion 6: only one row can be edited at a time', () => {
    it('exits edit mode on the first row, without saving it, when Edit is clicked on a second row', () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      renderTable([txFood, txTransport], { onSave })

      const editButtons = screen.getAllByTestId('transaction-edit-button')
      fireEvent.click(editButtons[0])
      expect(screen.getAllByTestId('transaction-edit-row')).toHaveLength(1)

      // Clicking Edit on the remaining read-only row's Edit button.
      const remainingEditButtons = screen.getAllByTestId(
        'transaction-edit-button',
      )
      fireEvent.click(remainingEditButtons[0])

      // Still exactly one editor row, now prefilled with the second transaction.
      expect(screen.getAllByTestId('transaction-edit-row')).toHaveLength(1)
      expect(
        screen.getByTestId<HTMLInputElement>('edit-amount-input').value,
      ).toBe('40')
      expect(onSave).not.toHaveBeenCalled()
    })
  })

  describe('criterion 8: invalid input shows an inline error and does not save', () => {
    it('shows an inline error for a non-positive amount and does not call onSave', () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      renderTable([txFood], { onSave })

      fireEvent.click(screen.getByTestId('transaction-edit-button'))
      fireEvent.change(screen.getByTestId('edit-amount-input'), {
        target: { value: '0' },
      })
      fireEvent.click(screen.getByTestId('edit-save-button'))

      expect(screen.getByTestId('edit-error-amount').textContent).toMatch(
        /greater than 0/i,
      )
      expect(onSave).not.toHaveBeenCalled()
      // Row stays in edit mode with the entered (invalid) value intact.
      expect(screen.getByTestId('transaction-edit-row')).toBeTruthy()
      expect(
        screen.getByTestId<HTMLInputElement>('edit-amount-input').value,
      ).toBe('0')
    })

    it('shows the same inline error for another non-positive amount, proving validation is not a one-off check', () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      renderTable([txFood], { onSave })

      fireEvent.click(screen.getByTestId('transaction-edit-button'))
      fireEvent.change(screen.getByTestId('edit-amount-input'), {
        target: { value: '-5' },
      })
      fireEvent.click(screen.getByTestId('edit-save-button'))

      expect(screen.getByTestId('edit-error-amount').textContent).toMatch(
        /greater than 0/i,
      )
      expect(onSave).not.toHaveBeenCalled()
    })
  })

  describe('criterion 7: Escape reverts the row without saving', () => {
    it('restores the read-only row and discards edits on Escape', () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      renderTable([txFood], { onSave })

      fireEvent.click(screen.getByTestId('transaction-edit-button'))
      fireEvent.change(screen.getByTestId('edit-amount-input'), {
        target: { value: '999' },
      })
      fireEvent.keyDown(screen.getByTestId('edit-amount-input'), {
        key: 'Escape',
        code: 'Escape',
      })

      expect(screen.queryByTestId('transaction-edit-row')).toBeNull()
      expect(screen.getByTestId('transaction-edit-button')).toBeTruthy()
      expect(onSave).not.toHaveBeenCalled()
      // Original (unedited) amount is still shown in the read-only row.
      expect(screen.getByTestId('transaction-row').textContent).toContain(
        '12.5',
      )
    })
  })

  describe('criterion 7 & 9: Enter saves with the Zod-parsed values', () => {
    it('calls onSave with the parsed values, keyed by id and originalCreatedAt, when Enter is pressed', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      renderTable([txFood], { onSave })

      fireEvent.click(screen.getByTestId('transaction-edit-button'))
      fireEvent.change(screen.getByTestId('edit-amount-input'), {
        target: { value: '42.5' },
      })
      fireEvent.keyDown(screen.getByTestId('edit-amount-input'), {
        key: 'Enter',
        code: 'Enter',
      })

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledTimes(1)
      })
      expect(onSave).toHaveBeenCalledWith(
        'tx-1',
        '2026-03-15T12:00:00.000Z',
        expect.objectContaining({
          amount: 42.5,
          currency: 'UAH',
          categoryId: 'cat-food',
          description: 'Lunch',
          createdAt: '2026-03-15T12:00:00.000Z',
        }),
      )
    })

    it('calls onSave via the Save button with a different amount, producing a different parsed payload', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      renderTable([txFood], { onSave })

      fireEvent.click(screen.getByTestId('transaction-edit-button'))
      fireEvent.change(screen.getByTestId('edit-amount-input'), {
        target: { value: '7.25' },
      })
      fireEvent.click(screen.getByTestId('edit-save-button'))

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledTimes(1)
      })
      expect(onSave).toHaveBeenCalledWith(
        'tx-1',
        '2026-03-15T12:00:00.000Z',
        expect.objectContaining({ amount: 7.25 }),
      )
    })

    it('calls onSave with the new categoryId when the edit-category-select value is changed', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      renderTable([txFood], { onSave })

      fireEvent.click(screen.getByTestId('transaction-edit-button'))
      fireEvent.change(screen.getByTestId('edit-category-select'), {
        target: { value: 'cat-transport' },
      })
      fireEvent.click(screen.getByTestId('edit-save-button'))

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledTimes(1)
      })
      expect(onSave).toHaveBeenCalledWith(
        'tx-1',
        '2026-03-15T12:00:00.000Z',
        expect.objectContaining({ categoryId: 'cat-transport' }),
      )
    })
  })

  describe('criterion 9: a successful save returns the row to read-only mode', () => {
    it('exits edit mode once the onSave promise resolves', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      renderTable([txFood], { onSave })

      fireEvent.click(screen.getByTestId('transaction-edit-button'))
      fireEvent.click(screen.getByTestId('edit-save-button'))

      await waitFor(() => {
        expect(screen.queryByTestId('transaction-edit-row')).toBeNull()
      })
      expect(screen.getByTestId('transaction-edit-button')).toBeTruthy()
    })
  })

  describe('criterion 10: a failed save keeps the row editable', () => {
    it('stays in edit mode with the entered values when onSave rejects', async () => {
      const onSave = vi.fn().mockRejectedValue(new Error('network down'))
      renderTable([txFood], { onSave })

      fireEvent.click(screen.getByTestId('transaction-edit-button'))
      fireEvent.change(screen.getByTestId('edit-amount-input'), {
        target: { value: '55' },
      })
      fireEvent.click(screen.getByTestId('edit-save-button'))

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledTimes(1)
      })
      expect(screen.getByTestId('transaction-edit-row')).toBeTruthy()
      expect(
        screen.getByTestId<HTMLInputElement>('edit-amount-input').value,
      ).toBe('55')
    })
  })

  describe('criterion 11: Delete is disabled only on the row currently in edit mode', () => {
    it('disables the editing row\'s Delete button while other rows stay enabled', () => {
      renderTable([txFood, txTransport])

      const editButtons = screen.getAllByTestId('transaction-edit-button')
      fireEvent.click(editButtons[0])

      const deleteButtons = screen.getAllByTestId('transaction-delete-button')
      expect(deleteButtons).toHaveLength(2)
      expect((deleteButtons[0] as HTMLButtonElement).disabled).toBe(true)
      expect((deleteButtons[1] as HTMLButtonElement).disabled).toBe(false)
    })

    it('re-enables the Delete button once the row exits edit mode via Escape', () => {
      renderTable([txFood, txTransport])

      const editButtons = screen.getAllByTestId('transaction-edit-button')
      fireEvent.click(editButtons[0])
      expect(
        (screen.getAllByTestId('transaction-delete-button')[0] as HTMLButtonElement)
          .disabled,
      ).toBe(true)

      fireEvent.keyDown(screen.getByTestId('edit-amount-input'), {
        key: 'Escape',
        code: 'Escape',
      })

      const deleteButtonsAfter = screen.getAllByTestId(
        'transaction-delete-button',
      )
      expect((deleteButtonsAfter[0] as HTMLButtonElement).disabled).toBe(
        false,
      )
    })
  })
})
