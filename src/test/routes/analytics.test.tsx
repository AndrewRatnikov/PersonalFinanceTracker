// No CONTRACT_GAPs: the analytics page testids and approach are fully
// specified in the Interface Contract. Income donut testids come from the
// income categories run (analytics-income-donut, analytics-category-donut,
// analytics-no-data). The main currency and the rates switch come from
// getCurrencySettings (mocked); the router Link used by
// ConversionPendingNote is replaced by a plain anchor.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { CurrencySettings } from '@/lib/appSettings'
import type { BudgetEntry, EntryConversion, Expense, IncomeEntry } from '@/lib/domain'
import { Route } from '@/routes/analytics'
import { getCurrencySettings } from '@/lib/appSettings'
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

vi.mock('@/lib/appSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/appSettings')>()),
  getCurrencySettings: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({
    to,
    search,
    children,
    ...rest
  }: {
    to: string
    search?: unknown
    children?: ReactNode
  } & Record<string, unknown>) => {
    void search
    return (
      <a href={to} {...rest}>
        {children}
      </a>
    )
  },
}))

const fmt2 = (n: number) =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

function conv(
  main: EntryConversion['mainCurrency'],
  mainAmount: number,
): EntryConversion {
  return {
    mainCurrency: main,
    rate: 1,
    mainAmount,
    rateDate: '2026-10-14',
    source: 'nbu',
  }
}

function expense(
  id: string,
  amount: number,
  currency: Expense['currency'],
  conversion?: EntryConversion,
): Expense {
  return {
    id,
    amount,
    currency,
    categoryId: 'c1',
    createdAt: new Date().toISOString(),
    category: { id: 'c1', name: 'Food' },
    ...(conversion ? { conversion } : {}),
  }
}

function income(
  id: string,
  amount: number,
  currency: IncomeEntry['currency'],
  category: { id: string; name: string; icon: string | null },
  conversion?: EntryConversion,
): IncomeEntry {
  return {
    id,
    categoryId: category.id,
    category,
    amount,
    currency,
    createdAt: new Date().toISOString(),
    ...(conversion ? { conversion } : {}),
  }
}

const SALARY = { id: 'ic1', name: 'Salary', icon: '💼' }
const GIFTS = { id: 'ic2', name: 'Gifts', icon: '🎁' }

function setSettings(settings: Partial<CurrencySettings> = {}) {
  vi.mocked(getCurrencySettings).mockResolvedValue({
    mainCurrency: 'UAH',
    fetchExchangeRates: true,
    ...settings,
  })
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

describe('analytics page: totals in the main currency', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.spyOn(Route, 'useSearch').mockReturnValue({})
    vi.mocked(getAllIncome).mockResolvedValue([])
    vi.mocked(getAllBudgets).mockResolvedValue([])
    setSettings()
  })

  it('totals the main-currency spend, counts the pending USD expense and has no currency select, excluded line or "Not included"', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([
      expense('e1', 1000, 'UAH'),
      expense('e2', 100, 'USD'),
    ])

    renderPage()

    const total = await screen.findByTestId('analytics-total-spent')
    expect(total.textContent).toContain(`${fmt2(1000)} UAH`)
    expect(screen.getByTestId('conversion-pending-note').textContent).toBe(
      '1 entry waiting for exchange rates',
    )
    expect(screen.queryByTestId('analytics-currency-select')).toBeNull()
    expect(screen.queryByTestId('analytics-excluded')).toBeNull()
    expect(document.body.textContent).not.toContain('Not included')
    const statsTotal = screen.getByTestId('dashboard-stats-total').textContent
    expect(statsTotal).toContain(fmt2(1000))
    expect(statsTotal).toContain('UAH')
  })

  it('adds a converted USD expense at its stored main amount and shows no pending note', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([
      expense('e1', 1000, 'UAH'),
      expense('e2', 100, 'USD', conv('UAH', 4152)),
    ])

    renderPage()

    const total = await screen.findByTestId('analytics-total-spent')
    expect(total.textContent).toContain(`${fmt2(5152)} UAH`)
    expect(screen.queryByTestId('conversion-pending-note')).toBeNull()
    expect(screen.getByTestId('dashboard-stats-total').textContent).toContain(
      fmt2(5152),
    )
  })

  it('shows the stat cards with two decimals and the currency code, not a symbol', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e1', 5, 'UAH')])
    vi.mocked(getAllIncome).mockResolvedValue([income('i1', 250, 'UAH', SALARY)])

    renderPage()

    expect((await screen.findByTestId('analytics-total-income')).textContent).toContain(
      `${fmt2(250)} UAH`,
    )
    expect(screen.getByTestId('analytics-total-spent').textContent).not.toContain(
      '₴',
    )
  })

  it('follows the main currency from the settings (EUR): other currencies are pending, not summed', async () => {
    setSettings({ mainCurrency: 'EUR' })
    vi.mocked(getExpensesForRange).mockResolvedValue([
      expense('e1', 50, 'EUR'),
      expense('e2', 1000, 'UAH'),
    ])
    vi.mocked(getAllIncome).mockResolvedValue([
      income('i1', 250, 'EUR', SALARY),
      income('i2', 9000, 'UAH', GIFTS),
    ])

    renderPage()

    const total = await screen.findByTestId('analytics-total-spent')
    expect(total.textContent).toContain(`${fmt2(50)} EUR`)
    expect(total.textContent).not.toContain('UAH')
    expect(screen.getByTestId('analytics-total-income').textContent).toContain(
      `${fmt2(250)} EUR`,
    )
    expect(screen.getByTestId('conversion-pending-note').textContent).toBe(
      '2 entries waiting for exchange rates',
    )
    const statsTotal = screen.getByTestId('dashboard-stats-total').textContent
    expect(statsTotal).toContain(fmt2(50))
    expect(statsTotal).toContain('EUR')
  })

  it('does not link to Settings while exchange rates are on', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e2', 100, 'USD')])

    renderPage()

    await screen.findByTestId('conversion-pending-note')
    expect(screen.queryByTestId('conversion-pending-settings-link')).toBeNull()
  })

  it('links to Settings → General while exchange rates are off', async () => {
    setSettings({ fetchExchangeRates: false })
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e2', 100, 'USD')])

    renderPage()

    const link = await screen.findByTestId('conversion-pending-settings-link')
    expect(link.getAttribute('href')).toBe('/settings')
  })

  it('notes budgets in another currency that are not compared', async () => {
    const budget: BudgetEntry & { categoryName: string; categoryIcon: null } = {
      id: 'b1',
      categoryId: 'c1',
      monthlyLimit: 200,
      currency: 'USD',
      categoryName: 'Food',
      categoryIcon: null,
    }
    vi.mocked(getAllBudgets).mockResolvedValue([budget])
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e1', 1000, 'UAH')])

    renderPage()

    expect(await screen.findByTestId('budget-conversion-pending-note')).toBeTruthy()
  })

  it('shows no note when nothing is pending', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e1', 1000, 'UAH')])

    renderPage()

    await screen.findByTestId('analytics-total-spent')
    expect(screen.queryByTestId('conversion-pending-note')).toBeNull()
    expect(screen.queryByTestId('budget-conversion-pending-note')).toBeNull()
  })
})

describe('analytics page: Where your money comes from', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.spyOn(Route, 'useSearch').mockReturnValue({})
    vi.mocked(getAllBudgets).mockResolvedValue([])
    setSettings()
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

  it('pending income in another currency is not charted and is counted in the note', async () => {
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
    expect(screen.getByTestId('conversion-pending-note').textContent).toBe(
      '1 entry waiting for exchange rates',
    )
    expect(screen.queryByTestId('analytics-excluded')).toBeNull()
  })

  it('charts converted income of another currency under its category', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([
      expense('e1', 100, 'UAH'),
    ])
    vi.mocked(getAllIncome).mockResolvedValue([
      income('i1', 3000, 'UAH', SALARY),
      income('i2', 50, 'USD', GIFTS, conv('UAH', 2076)),
    ])

    renderPage()

    const incomeDonut = await screen.findByTestId('analytics-income-donut')
    expect(incomeDonut.textContent).toContain('Gifts')
    expect(screen.queryByTestId('conversion-pending-note')).toBeNull()
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

  it('groups the income donut by the main currency from the settings', async () => {
    setSettings({ mainCurrency: 'USD' })
    vi.mocked(getExpensesForRange).mockResolvedValue([
      expense('e1', 100, 'UAH'),
    ])
    vi.mocked(getAllIncome).mockResolvedValue([
      income('i1', 3000, 'UAH', SALARY),
      income('i2', 50, 'USD', GIFTS),
    ])

    renderPage()

    await waitFor(() => {
      expect(screen.getByTestId('analytics-income-donut').textContent).toContain(
        'Gifts',
      )
    })
    expect(screen.getByTestId('analytics-income-donut').textContent).not.toContain(
      'Salary',
    )
  })
})
