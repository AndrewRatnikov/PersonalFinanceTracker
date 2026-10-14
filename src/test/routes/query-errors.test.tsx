import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'

import { BudgetTab } from '@/components/settings/BudgetTab'
import { CategoriesTab } from '@/components/settings/CategoriesTab'
import {
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getAllIncomeCategories,
  getAllRecurring,
  getExpensesForRange,
} from '@/lib/localDb'
import { setVaultPhase } from '@/lib/vaultSession'
import { Route as AnalyticsRoute } from '@/routes/analytics'
import { Route as IncomeRoute } from '@/routes/income'
import { Route as IndexRoute } from '@/routes/index'
import { Route as SettingsRoute } from '@/routes/settings'
import { Route as TransactionsRoute } from '@/routes/transactions'

// The Dashboard's RecurringDashboardSection renders a router Link to
// /recurring; no router is mounted here, so Link is a plain anchor.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactRouter>()
  return {
    ...actual,
    Link: ({ to, children }: { to: string; children?: ReactNode }) => (
      <a href={to}>{children}</a>
    ),
  }
})

vi.mock('@/lib/localDb', () => ({
  getAllCategories: vi.fn(),
  getAllIncomeCategories: vi.fn(),
  getExpensesForRange: vi.fn(),
  getAllExpenses: vi.fn(),
  getAllIncome: vi.fn(),
  getAllBudgets: vi.fn(),
  getAllRecurring: vi.fn(),
  addExpense: vi.fn(),
  addRepeatingExpense: vi.fn(),
  deleteExpense: vi.fn(),
  updateExpense: vi.fn(),
  deleteIncome: vi.fn(),
  addIncome: vi.fn(),
  addRepeatingIncome: vi.fn(),
  confirmRecurringOccurrence: vi.fn(),
  skipRecurringOccurrence: vi.fn(),
  addCategory: vi.fn(),
  addIncomeCategory: vi.fn(),
  updateCategory: vi.fn(),
  updateIncomeCategory: vi.fn(),
  deleteCategory: vi.fn(),
  deleteIncomeCategory: vi.fn(),
  upsertBudget: vi.fn(),
  deleteBudget: vi.fn(),
  // Used by the root route and the data problem gate (never at import time).
  initLocalDb: vi.fn(),
  provisionDefaultCategories: vi.fn(),
  prepareUnlockedVault: vi.fn(),
  unlockLocalDb: vi.fn(),
  clearLocalDb: vi.fn(),
  wipeLocalDbKey: vi.fn(),
  quarantineKey: vi.fn(),
  hasLocalData: vi.fn(),
  getLocalStore: vi.fn(),
  getLocalDbKey: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ getServerUser: vi.fn() }))

// The Dashboard mounts InstallHintCard and the Settings page checks whether
// account UI is visible; neither is under test here, and both must stay away
// from navigator.matchMedia and Supabase in jsdom.
vi.mock('@/lib/installHint', () => ({ shouldShowInstallHint: () => false }))
vi.mock('@/lib/accountSession', () => ({
  ACCOUNT_SESSION_QUERY_KEY: ['account-session'],
  useAccountsVisible: () => false,
  useAccountSession: () => null,
}))

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

function renderUi(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

// A non-empty list keeps the income form on its select (the empty list shows a
// router Link, which needs a router).
const INCOME_CATEGORIES = [{ id: 'ic1', name: 'Salary', icon: null }]

function mockHealthyData() {
  vi.mocked(getAllCategories).mockResolvedValue([])
  vi.mocked(getAllIncomeCategories).mockResolvedValue(INCOME_CATEGORIES)
  vi.mocked(getExpensesForRange).mockResolvedValue([])
  vi.mocked(getAllExpenses).mockResolvedValue([])
  vi.mocked(getAllIncome).mockResolvedValue([])
  vi.mocked(getAllBudgets).mockResolvedValue([])
  vi.mocked(getAllRecurring).mockResolvedValue([])
}

beforeEach(() => {
  vi.resetAllMocks()
  mockHealthyData()
  vi.spyOn(AnalyticsRoute, 'useSearch').mockReturnValue({})
  // The Dashboard renders only once the vault session is unlocked.
  setVaultPhase('unlocked')
})

afterEach(() => {
  setVaultPhase('checking')
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

  it('renders query-error when the recurring items fail, and Retry calls getAllRecurring again', async () => {
    vi.mocked(getAllRecurring).mockRejectedValue(new Error('boom'))

    renderPage(IndexRoute)

    await screen.findByTestId('query-error')
    expect(getAllRecurring).toHaveBeenCalledTimes(1)

    vi.mocked(getAllRecurring).mockResolvedValue([])
    fireEvent.click(screen.getByTestId('query-error-retry'))

    await waitFor(() => {
      expect(getAllRecurring).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.queryByTestId('query-error')).toBeNull()
    })
  })

  it('shows no error block when every query, including recurring, succeeds', async () => {
    renderPage(IndexRoute)

    await screen.findByTestId('dashboard-summary')
    await waitFor(() => {
      expect(getAllRecurring).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('query-error')).toBeNull()
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

describe('Settings query error', () => {
  const food = [{ id: 'c1', name: 'Food' }]

  it('CategoriesTab renders query-error and Retry calls getAllCategories again', async () => {
    vi.mocked(getAllCategories).mockRejectedValue(new Error('boom'))

    renderUi(<CategoriesTab />)

    await screen.findByTestId('query-error')
    expect(getAllCategories).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('query-error-retry'))

    await waitFor(() => {
      expect(getAllCategories).toHaveBeenCalledTimes(2)
    })
  })

  it('CategoriesTab shows categories-tab and no error when categories load', async () => {
    vi.mocked(getAllCategories).mockResolvedValue(food as never)

    renderUi(<CategoriesTab />)

    await screen.findByTestId('categories-tab')
    await waitFor(() => {
      expect(getAllCategories).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(getAllIncomeCategories).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('query-error')).toBeNull()
  })

  it('CategoriesTab shows the income error in the income section and Retry calls getAllIncomeCategories again', async () => {
    vi.mocked(getAllCategories).mockResolvedValue(food as never)
    vi.mocked(getAllIncomeCategories).mockRejectedValue(new Error('boom'))

    renderUi(<CategoriesTab />)

    const income = within(await screen.findByTestId('income-categories-section'))
    await waitFor(() => {
      expect(income.getByTestId('query-error')).toBeTruthy()
    })
    expect(getAllIncomeCategories).toHaveBeenCalledTimes(1)
    const expenseCalls = vi.mocked(getAllCategories).mock.calls.length

    fireEvent.click(income.getByTestId('query-error-retry'))

    await waitFor(() => {
      expect(getAllIncomeCategories).toHaveBeenCalledTimes(2)
    })
    expect(vi.mocked(getAllCategories).mock.calls.length).toBe(expenseCalls)
  })

  it('BudgetTab renders query-error and Retry calls getAllBudgets again', async () => {
    vi.mocked(getAllBudgets).mockRejectedValue(new Error('boom'))

    renderUi(<BudgetTab categories={food as never} />)

    await screen.findByTestId('query-error')
    expect(getAllBudgets).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('query-error-retry'))

    await waitFor(() => {
      expect(getAllBudgets).toHaveBeenCalledTimes(2)
    })
  })

  it('BudgetTab shows budget-tab and no error when budgets load', async () => {
    renderUi(<BudgetTab categories={food as never} />)

    await screen.findByTestId('budget-tab')
    await waitFor(() => {
      expect(getAllBudgets).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('query-error')).toBeNull()
  })

  it('SettingsPage shows query-error instead of the tab when categories fail', async () => {
    vi.spyOn(SettingsRoute, 'useSearch').mockReturnValue({ tab: 'budget' })
    vi.mocked(getAllCategories).mockRejectedValue(new Error('boom'))
    vi.mocked(getAllBudgets).mockResolvedValue([])

    renderPage(SettingsRoute)

    await screen.findByTestId('query-error')
    expect(screen.queryByTestId('budget-tab')).toBeNull()
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

  it('renders query-error and no form when the income categories fail, and Retry calls getAllIncomeCategories again', async () => {
    vi.mocked(getAllIncomeCategories).mockRejectedValue(new Error('boom'))

    renderPage(IncomeRoute)

    await screen.findByTestId('query-error')
    expect(screen.getByTestId('income-page')).toBeTruthy()
    expect(screen.queryByTestId('add-income-form')).toBeNull()
    expect(getAllIncomeCategories).toHaveBeenCalledTimes(1)

    vi.mocked(getAllIncomeCategories).mockResolvedValue(INCOME_CATEGORIES)
    fireEvent.click(screen.getByTestId('query-error-retry'))

    await waitFor(() => {
      expect(getAllIncomeCategories).toHaveBeenCalledTimes(2)
    })
    await screen.findByTestId('add-income-form')
    expect(screen.queryByTestId('query-error')).toBeNull()
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
