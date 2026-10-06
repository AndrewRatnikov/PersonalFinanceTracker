// No CONTRACT_GAPs: the transactions route approach and fake testids (#5) are
// fully specified in the Interface Contract.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Expense } from '@/lib/domain'
import { Route } from '@/routes/transactions'

const { items } = vi.hoisted(() => ({ items: [] as Array<Expense> }))

vi.mock('@/lib/localDb', () => ({
  getAllCategories: vi.fn(() => Promise.resolve([])),
  getAllExpenses: vi.fn(() => Promise.resolve([...items])),
  deleteExpense: vi.fn((id: string) => {
    const index = items.findIndex((e) => e.id === id)
    if (index !== -1) items.splice(index, 1)
    return Promise.resolve()
  }),
  updateExpense: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/components/transactions/TransactionsPagination', () => ({
  TransactionsPagination: ({
    pageIndex,
    totalPages,
    onPageChange,
  }: {
    pageIndex: number
    totalPages: number
    onPageChange: (next: number) => void
  }) => (
    <div
      data-testid="fake-pagination"
      data-page-index={pageIndex}
      data-total-pages={totalPages}
    >
      <button
        data-testid="fake-pagination-next"
        onClick={() => onPageChange(pageIndex + 1)}
      />
    </div>
  ),
}))

vi.mock('@/components/transactions/TransactionsTable', () => ({
  TransactionsTable: ({
    transactions,
    onDelete,
  }: {
    transactions: Array<Expense>
    onDelete: (id: string, createdAt: string) => void
  }) => (
    <div>
      {transactions.map((t) => (
        <div data-testid="fake-row" key={t.id}>
          <button
            data-testid="fake-row-delete"
            onClick={() => onDelete(t.id, t.createdAt)}
          />
        </div>
      ))}
    </div>
  ),
}))

function fill(count: number) {
  items.length = 0
  for (let i = 0; i < count; i++) {
    items.push({
      id: `e${i}`,
      amount: 10 + i,
      currency: 'UAH',
      categoryId: 'c1',
      // Distinct, descending createdAt.
      createdAt: new Date(Date.UTC(2024, 0, 31, 12, 0, 0) - i * 3_600_000)
        .toISOString(),
    })
  }
}

function renderPage() {
  const Page = Route.options.component
  if (!Page) throw new Error('transactions route has no component')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  )
}

describe('transactions page clamps the page index (#5)', () => {
  beforeEach(() => {
    fill(31)
  })

  it('falls back to the last page when the only row on the current page is deleted', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(15)
    })

    fireEvent.click(screen.getByTestId('fake-pagination-next'))
    fireEvent.click(screen.getByTestId('fake-pagination-next'))
    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(1)
    })

    fireEvent.click(screen.getByTestId('fake-row-delete'))

    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(15)
    })
    const pagination = screen.getByTestId('fake-pagination')
    expect(pagination.getAttribute('data-page-index')).toBe('1')
    expect(pagination.getAttribute('data-total-pages')).toBe('2')
  })

  it('shows the first page for a small list and does not clamp prematurely', async () => {
    fill(20)
    renderPage()

    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(15)
    })
    expect(
      screen.getByTestId('fake-pagination').getAttribute('data-page-index'),
    ).toBe('0')

    fireEvent.click(screen.getByTestId('fake-pagination-next'))

    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(5)
    })
    expect(
      screen.getByTestId('fake-pagination').getAttribute('data-page-index'),
    ).toBe('1')
  })
})
