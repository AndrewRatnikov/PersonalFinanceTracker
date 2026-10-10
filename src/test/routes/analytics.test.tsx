// No CONTRACT_GAPs: the analytics page testids and approach (#2 page) are
// fully specified in the Interface Contract. Income donut testids come from the
// income categories run (analytics-income-donut, analytics-category-donut,
// analytics-no-data).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Expense, IncomeEntry } from '@/lib/domain'
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

function income(
  id: string,
  amount: number,
  currency: IncomeEntry['currency'],
  category: { id: string; name: string; icon: string | null },
): IncomeEntry {
  return {
    id,
    categoryId: category.id,
    category,
    amount,
    currency,
    createdAt: new Date().toISOString(),
  }
}

const SALARY = { id: 'ic1', name: 'Salary', icon: '💼' }
const GIFTS = { id: 'ic2', name: 'Gifts', icon: '🎁' }

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
      income('i1', 250, 'EUR', SALARY),
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

describe('analytics page: Where your money comes from', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.spyOn(Route, 'useSearch').mockReturnValue({})
    vi.mocked(getAllBudgets).mockResolvedValue([])
  })

  it('renders the income donut with the category names, after the spending donut', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([
      expense('e1', 100, 'UAH'),
    ])
    vi.mocked(getAllIncome).mockResolvedValue([
      income('i1', 3000, 'UAH', SALARY),
      income('i2', 200, 'UAH', GIFTS),
    ])

    renderPage()

    const incomeDonut = await screen.findByTestId('analytics-income-donut')
    expect(incomeDonut.textContent).toContain('Where your money comes from')
    expect(incomeDonut.textContent).toContain('Salary')
    expect(incomeDonut.textContent).toContain('Gifts')
    const spendingDonut = screen.getByTestId('analytics-category-donut')
    expect(spendingDonut.textContent).toContain('Food')
    expect(spendingDonut.textContent).not.toContain('Salary')
    // Directly after "By Category" in document order.
    expect(
      spendingDonut.compareDocumentPosition(incomeDonut) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.queryByTestId('analytics-no-data')).toBeNull()
  })

  it('an income-only range shows the income donut, not the no-data card', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([])
    vi.mocked(getAllIncome).mockResolvedValue([
      income('i1', 3000, 'UAH', SALARY),
    ])

    renderPage()

    const incomeDonut = await screen.findByTestId('analytics-income-donut')
    expect(incomeDonut.textContent).toContain('Salary')
    expect(screen.queryByTestId('analytics-no-data')).toBeNull()
    // The spending donut shows its empty text.
    expect(screen.getByTestId('analytics-category-donut').textContent).toContain(
      'No data found.',
    )
  })

  it('a range with neither income nor expenses shows the no-data card and no income donut', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([])
    vi.mocked(getAllIncome).mockResolvedValue([])

    renderPage()

    const noData = await screen.findByTestId('analytics-no-data')
    expect(noData.textContent).toContain('No data found for this period')
    expect(screen.queryByTestId('analytics-income-donut')).toBeNull()
  })

  it('income in another currency is not charted for the selected currency', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([
      expense('e1', 100, 'UAH'),
    ])
    vi.mocked(getAllIncome).mockResolvedValue([
      income('i1', 3000, 'UAH', SALARY),
      income('i2', 50, 'USD', GIFTS),
    ])

    renderPage()

    const incomeDonut = await screen.findByTestId('analytics-income-donut')
    expect(incomeDonut.textContent).toContain('Salary')
    expect(incomeDonut.textContent).not.toContain('Gifts')
    expect(screen.getByTestId('analytics-excluded').textContent).toContain(
      `+${fmt(50)} USD`,
    )
  })

  it('shows the empty income text when there is only spending', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([
      expense('e1', 100, 'UAH'),
    ])
    vi.mocked(getAllIncome).mockResolvedValue([])

    renderPage()

    const incomeDonut = await screen.findByTestId('analytics-income-donut')
    expect(incomeDonut.textContent).toContain('No income in this period.')
  })

  it('switching the currency re-groups the income donut', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([
      expense('e1', 100, 'UAH'),
    ])
    vi.mocked(getAllIncome).mockResolvedValue([
      income('i1', 3000, 'UAH', SALARY),
      income('i2', 50, 'USD', GIFTS),
    ])

    renderPage()

    const select = await screen.findByTestId<HTMLSelectElement>(
      'analytics-currency-select',
    )
    await screen.findByTestId('analytics-income-donut')
    fireEvent.change(select, { target: { value: 'USD' } })

    await waitFor(() => {
      expect(
        screen.getByTestId('analytics-income-donut').textContent,
      ).toContain('Gifts')
    })
    expect(screen.getByTestId('analytics-income-donut').textContent).not.toContain(
      'Salary',
    )
  })
})
