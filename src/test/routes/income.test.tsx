// No CONTRACT_GAPs: the income route approach and fake testids (#5) are fully
// specified in the Interface Contract.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IncomeEntry } from '@/lib/domain'
import { Route } from '@/routes/income'

const { items } = vi.hoisted(() => ({ items: [] as Array<IncomeEntry> }))

vi.mock('@/lib/localDb', () => ({
  getAllIncome: vi.fn(() => Promise.resolve([...items])),
  addIncome: vi.fn(),
  deleteIncome: vi.fn((id: string) => {
    const index = items.findIndex((e) => e.id === id)
    if (index !== -1) items.splice(index, 1)
    return Promise.resolve()
  }),
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

vi.mock('@/components/income/IncomeTable', () => ({
  IncomeTable: ({
    income,
    onDelete,
  }: {
    income: Array<IncomeEntry>
    onDelete: (id: string) => void
  }) => (
    <div>
      {income.map((i) => (
        <div data-testid="fake-row" key={i.id}>
          <button data-testid="fake-row-delete" onClick={() => onDelete(i.id)} />
        </div>
      ))}
    </div>
  ),
}))

function fill(count: number) {
  items.length = 0
  for (let i = 0; i < count; i++) {
    items.push({
      id: `i${i}`,
      source: 'Job',
      amount: 100 + i,
      currency: 'UAH',
      createdAt: new Date(Date.UTC(2024, 0, 31, 12, 0, 0) - i * 3_600_000)
        .toISOString(),
    })
  }
}

function renderPage() {
  const Page = Route.options.component
  if (!Page) throw new Error('income route has no component')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  )
}

describe('income page clamps the page index (#5)', () => {
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

    fireEvent.click(screen.getByTestId('fake-pagination-next'))

    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(5)
    })
    expect(
      screen.getByTestId('fake-pagination').getAttribute('data-page-index'),
    ).toBe('1')
  })
})
