// No CONTRACT_GAPs: the analytics page testids and approach (#2 page) are
// fully specified in the Interface Contract.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Expense } from '@/lib/domain'
import { Route } from '@/routes/analytics'
import {
  getAllBudgets,
  getAllIncome,
  getExpensesForRange,
} from '@/lib/localDb'

vi.mock('@/lib/localDb', () => ({
  getExpensesForRange: vi.fn(),
  getAllIncome: vi.fn(),
  getAllBudgets: vi.fn(),
}))

const fmt = (n: number) => n.toLocaleString()

function expense(
  id: string,
  amount: number,
  currency: Expense['currency'],
): Expense {
  return {
    id,
    amount,
    currency,
    categoryId: 'c1',
    createdAt: new Date().toISOString(),
    category: { id: 'c1', name: 'Food' },
  }
}

function renderPage() {
  const Page = Route.options.component
  if (!Page) throw new Error('analytics route has no component')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  )
}

describe('analytics page: one currency at a time (#2)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.spyOn(Route, 'useSearch').mockReturnValue({})
    vi.mocked(getAllIncome).mockResolvedValue([])
    vi.mocked(getAllBudgets).mockResolvedValue([])
  })

  it('defaults to UAH, totals only UAH spend and notes the excluded USD amount', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([
      expense('e1', 1000, 'UAH'),
      expense('e2', 100, 'USD'),
    ])

    renderPage()

    const select = await screen.findByTestId<HTMLSelectElement>(
      'analytics-currency-select',
    )
    expect(select.value).toBe('UAH')
    expect(screen.getByTestId('analytics-total-spent').textContent).toContain(
      '₴1000.00',
    )
    expect(screen.getByTestId('analytics-excluded').textContent).toContain(
      `${fmt(100)} USD`,
    )
    const statsTotal = screen.getByTestId('dashboard-stats-total').textContent
    expect(statsTotal).toContain(fmt(1000))
    expect(statsTotal).toContain('UAH')
  })

  it('switching to USD relabels the cards, the notice and the monthly stats', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([
      expense('e1', 1000, 'UAH'),
      expense('e2', 100, 'USD'),
    ])

    renderPage()

    const select = await screen.findByTestId<HTMLSelectElement>(
      'analytics-currency-select',
    )
    fireEvent.change(select, { target: { value: 'USD' } })

    await waitFor(() => {
      expect(
        screen.getByTestId('analytics-total-spent').textContent,
      ).toContain('$100.00')
    })
    expect(screen.getByTestId('analytics-total-spent').textContent).not.toContain(
      '₴',
    )
    expect(screen.getByTestId('analytics-excluded').textContent).toContain(
      `${fmt(1000)} UAH`,
    )
    const statsTotal = screen.getByTestId('dashboard-stats-total').textContent
    expect(statsTotal).toContain(fmt(100))
    expect(statsTotal).toContain('USD')
    expect(statsTotal).not.toContain('UAH')
  })

  it('shows the selected-currency symbol on the income card', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e1', 5, 'UAH')])
    vi.mocked(getAllIncome).mockResolvedValue([
      {
        id: 'i1',
        source: 'Job',
        amount: 250,
        currency: 'EUR',
        createdAt: new Date().toISOString(),
      },
    ])

    renderPage()

    const select = await screen.findByTestId<HTMLSelectElement>(
      'analytics-currency-select',
    )
    fireEvent.change(select, { target: { value: 'EUR' } })

    await waitFor(() => {
      expect(
        screen.getByTestId('analytics-total-income').textContent,
      ).toContain('€250.00')
    })
  })

  it('renders no notice when every expense is in the selected currency', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([
      expense('e1', 1000, 'UAH'),
    ])

    renderPage()

    await screen.findByTestId('analytics-currency-select')
    expect(screen.queryByTestId('analytics-excluded')).toBeNull()
  })
})
