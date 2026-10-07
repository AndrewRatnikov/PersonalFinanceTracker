// CONTRACT_GAP: no testid or props are specified for rendering the Settings
// CategoriesTab / BudgetTab in isolation (their props are not listed in the
// Interface Contract), so the settings error states are not covered here.
// Everything else (Dashboard, Analytics, Transactions, Income) is specified.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getExpensesForRange,
} from '@/lib/localDb'
import { Route as RootRoute } from '@/routes/__root'
import { Route as AnalyticsRoute } from '@/routes/analytics'
import { Route as IncomeRoute } from '@/routes/income'
import { Route as IndexRoute } from '@/routes/index'
import { Route as TransactionsRoute } from '@/routes/transactions'

vi.mock('@/lib/localDb', () => ({
  getAllCategories: vi.fn(),
  getExpensesForRange: vi.fn(),
  getAllExpenses: vi.fn(),
  getAllIncome: vi.fn(),
  getAllBudgets: vi.fn(),
  addExpense: vi.fn(),
  deleteExpense: vi.fn(),
  updateExpense: vi.fn(),
  deleteIncome: vi.fn(),
  addIncome: vi.fn(),
  // Used by the root route and the data problem gate (never at import time).
  initLocalDb: vi.fn(),
  provisionDefaultCategories: vi.fn(),
  unlockLocalDb: vi.fn(),
  clearLocalDb: vi.fn(),
  wipeLocalDbKey: vi.fn(),
  quarantineKey: vi.fn(),
  hasLocalData: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ getServerUser: vi.fn() }))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

function renderPage(Route: { options: { component?: unknown } }) {
  const Page = Route.options.component as React.ComponentType | undefined
  if (!Page) throw new Error('route has no component')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  )
}

function mockHealthyData() {
  vi.mocked(getAllCategories).mockResolvedValue([])
  vi.mocked(getExpensesForRange).mockResolvedValue([])
  vi.mocked(getAllExpenses).mockResolvedValue([])
  vi.mocked(getAllIncome).mockResolvedValue([])
  vi.mocked(getAllBudgets).mockResolvedValue([])
}

beforeEach(() => {
  vi.resetAllMocks()
  mockHealthyData()
  vi.spyOn(AnalyticsRoute, 'useSearch').mockReturnValue({})
  vi.spyOn(RootRoute, 'useRouteContext').mockReturnValue({
    auth: { user: { id: 'u1' }, isLoading: false },
  } as never)
})

describe('Analytics page query error', () => {
  const failures: Array<[string, () => void]> = [
    [
      'income',
      () => vi.mocked(getAllIncome).mockRejectedValue(new Error('boom')),
    ],
    [
      'budgets',
      () => vi.mocked(getAllBudgets).mockRejectedValue(new Error('boom')),
    ],
    [
      'expenses',
      () => vi.mocked(getExpensesForRange).mockRejectedValue(new Error('boom')),
    ],
  ]

  it.each(failures)(
    'renders query-error, not a spinner, when %s fails',
    async (_name, fail) => {
      fail()

      renderPage(AnalyticsRoute)

      await screen.findByTestId('query-error')
      expect(screen.queryByTestId('analytics-loading')).toBeNull()
      expect(screen.getByTestId('query-error-retry')).toBeTruthy()
    },
  )

  it('does not spin forever: the loading wrapper is gone once the query has failed', async () => {
    vi.mocked(getAllIncome).mockRejectedValue(new Error('boom'))

    renderPage(AnalyticsRoute)

    await waitFor(() => {
      expect(screen.queryByTestId('query-error')).toBeTruthy()
    })
    expect(screen.queryByTestId('analytics-loading')).toBeNull()
  })

  it('Retry refetches the failed query and recovers when it succeeds', async () => {
    vi.mocked(getAllIncome)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([])

    renderPage(AnalyticsRoute)
    await screen.findByTestId('query-error')
    expect(getAllIncome).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('query-error-retry'))

    await waitFor(() => {
      expect(getAllIncome).toHaveBeenCalledTimes(2)
    })
    await screen.findByTestId('analytics-currency-select')
    expect(screen.queryByTestId('query-error')).toBeNull()
  })

  it('shows no error block when every query succeeds', async () => {
    renderPage(AnalyticsRoute)

    await screen.findByTestId('analytics-currency-select')
    expect(screen.queryByTestId('query-error')).toBeNull()
    expect(screen.queryByTestId('analytics-loading')).toBeNull()
  })

  it('shows the loading wrapper while a query is still pending', async () => {
    vi.mocked(getAllIncome).mockReturnValue(new Promise(() => {}))

    renderPage(AnalyticsRoute)

    expect(await screen.findByTestId('analytics-loading')).toBeTruthy()
    expect(screen.queryByTestId('query-error')).toBeNull()
  })
})

describe('Dashboard query error', () => {
  const failures: Array<[string, () => void]> = [
    [
      'categories',
      () => vi.mocked(getAllCategories).mockRejectedValue(new Error('boom')),
    ],
    [
      'expenses',
      () => vi.mocked(getExpensesForRange).mockRejectedValue(new Error('boom')),
    ],
    [
      'income',
      () => vi.mocked(getAllIncome).mockRejectedValue(new Error('boom')),
    ],
    [
      'budgets',
      () => vi.mocked(getAllBudgets).mockRejectedValue(new Error('boom')),
    ],
  ]

  it.each(failures)(
    'renders query-error instead of default zeros when %s fails',
    async (_name, fail) => {
      fail()

      renderPage(IndexRoute)

      await screen.findByTestId('query-error')
      expect(screen.queryByTestId('dashboard-summary')).toBeNull()
      expect(screen.getByTestId('query-error-retry')).toBeTruthy()
    },
  )

  it('Retry calls the failed getter again', async () => {
    vi.mocked(getAllIncome).mockRejectedValue(new Error('boom'))

    renderPage(IndexRoute)
    await screen.findByTestId('query-error')
    expect(getAllIncome).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('query-error-retry'))

    await waitFor(() => {
      expect(getAllIncome).toHaveBeenCalledTimes(2)
    })
  })

  it('Retry does not refetch queries that succeeded', async () => {
    vi.mocked(getAllIncome).mockRejectedValue(new Error('boom'))

    renderPage(IndexRoute)
    await screen.findByTestId('query-error')
    const budgetCalls = vi.mocked(getAllBudgets).mock.calls.length

    fireEvent.click(screen.getByTestId('query-error-retry'))

    await waitFor(() => {
      expect(getAllIncome).toHaveBeenCalledTimes(2)
    })
    expect(vi.mocked(getAllBudgets).mock.calls.length).toBe(budgetCalls)
  })
})

describe('Transactions page query error', () => {
  const failures: Array<[string, () => void]> = [
    [
      'expenses',
      () => vi.mocked(getAllExpenses).mockRejectedValue(new Error('boom')),
    ],
    [
      'categories',
      () => vi.mocked(getAllCategories).mockRejectedValue(new Error('boom')),
    ],
  ]

  it.each(failures)(
    'renders query-error and keeps the page shell when %s fails',
    async (_name, fail) => {
      fail()

      renderPage(TransactionsRoute)

      await screen.findByTestId('query-error')
      expect(screen.getByTestId('transactions-page')).toBeTruthy()
      expect(screen.getByTestId('query-error-retry')).toBeTruthy()
    },
  )

  it('Retry refetches the failed query and recovers when it succeeds', async () => {
    vi.mocked(getAllExpenses)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([])

    renderPage(TransactionsRoute)
    await screen.findByTestId('query-error')

    fireEvent.click(screen.getByTestId('query-error-retry'))

    await waitFor(() => {
      expect(getAllExpenses).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.queryByTestId('query-error')).toBeNull()
    })
    expect(screen.getByTestId('transactions-page')).toBeTruthy()
  })

  it('shows no error block when every query succeeds', async () => {
    renderPage(TransactionsRoute)

    await screen.findByTestId('transactions-page')
    await waitFor(() => {
      expect(getAllExpenses).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('query-error')).toBeNull()
  })
})

describe('Income page query error', () => {
  it('renders query-error and keeps the page shell when income fails', async () => {
    vi.mocked(getAllIncome).mockRejectedValue(new Error('boom'))

    renderPage(IncomeRoute)

    await screen.findByTestId('query-error')
    expect(screen.getByTestId('income-page')).toBeTruthy()
    expect(screen.getByTestId('query-error-retry')).toBeTruthy()
  })

  it('Retry refetches income and recovers when it succeeds', async () => {
    vi.mocked(getAllIncome)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([])

    renderPage(IncomeRoute)
    await screen.findByTestId('query-error')
    expect(getAllIncome).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('query-error-retry'))

    await waitFor(() => {
      expect(getAllIncome).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.queryByTestId('query-error')).toBeNull()
    })
  })

  it('shows no error block when income loads', async () => {
    renderPage(IncomeRoute)

    await screen.findByTestId('income-page')
    await waitFor(() => {
      expect(getAllIncome).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('query-error')).toBeNull()
  })
})
