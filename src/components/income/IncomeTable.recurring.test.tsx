// No CONTRACT_GAPs: income-recurring-icon, its title and the optional
// recurringId / occurrenceDate fields are specified in the Interface Contract
// (component changes: IncomeTable).

import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { IncomeEntry } from '@/lib/domain'
import { IncomeTable } from '@/components/income/IncomeTable'

function entry(overrides: Partial<IncomeEntry> = {}): IncomeEntry {
  return {
    id: 'i1',
    categoryId: 'ic1',
    category: { id: 'ic1', name: 'Salary', icon: '💼' },
    amount: 1000,
    currency: 'UAH',
    description: 'Paycheck',
    createdAt: '2026-03-10T12:00:00.000Z',
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
      onDelete={vi.fn()}
    />,
  )
}

function rowFor(description: string) {
  const row = screen
    .getAllByTestId('income-row')
    .find((r) => r.textContent.includes(description))
  if (!row) throw new Error(`no row with ${description}`)
  return row
}

describe('IncomeTable recurring icon', () => {
  it('shows the Repeat icon with the title on an entry that has recurringId', () => {
    renderTable([entry({ recurringId: 'r1', occurrenceDate: '2026-03-10' })])

    const icon = screen.getByTestId('income-recurring-icon')
    expect(icon.getAttribute('title')).toBe('From a recurring item')
    expect(icon.querySelector('svg')).not.toBeNull()
  })

  it('shows no icon on an ordinary entry', () => {
    renderTable([entry()])

    expect(screen.queryByTestId('income-recurring-icon')).toBeNull()
  })

  it('shows the icon only on the generated rows of a mixed list', () => {
    renderTable([
      entry({ id: 'a', description: 'Generated', recurringId: 'r1' }),
      entry({ id: 'b', description: 'Manual' }),
    ])

    expect(screen.getAllByTestId('income-recurring-icon')).toHaveLength(1)
    expect(
      within(rowFor('Generated')).queryByTestId('income-recurring-icon'),
    ).not.toBeNull()
    expect(
      within(rowFor('Manual')).queryByTestId('income-recurring-icon'),
    ).toBeNull()
  })

  it('keeps the category cell of a generated row intact', () => {
    renderTable([entry({ recurringId: 'r1' })])

    const cell = screen.getByTestId('income-row-category')
    expect(cell.textContent).toContain('💼')
    expect(cell.textContent).toContain('Salary')
  })
})
