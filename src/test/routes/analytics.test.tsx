// No CONTRACT_GAPs: the analytics page testids and approach are fully
// specified in the Interface Contract. Income donut testids come from the
// income categories run (analytics-income-donut, analytics-category-donut,
// analytics-no-data). The main currency and the rates switch come from
// getCurrencySettings (mocked); the router Link used by
// ConversionPendingNote is replaced by a plain anchor.
//
// i18n: the UI language is pinned to English in beforeEach and amounts are
// built with the @/i18n/format helpers. The Ukrainian block asserts amounts
// exactly and the rest of the Ukrainian wording as "Cyrillic and not the
// English text".
//
// Page-width additions: PageContainer root, filters and summary outside a lg
// 2-column chart grid, lg:order pairing and the odd-count span (classes and
// DOM order only; jsdom has no layout).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'
import type * as AppSettings from '@/lib/appSettings'

import type { CurrencySettings } from '@/lib/appSettings'
import type { BudgetEntry, EntryConversion, Expense, IncomeEntry } from '@/lib/domain'
import type { Lang } from '@/i18n/lang'
import { setLang } from '@/i18n/core'
import { formatAmount } from '@/i18n/format'
import { I18nProvider } from '@/i18n/react'
import { Route } from '@/routes/analytics'
import { getCurrencySettings } from '@/lib/appSettings'
import {
  getAllBudgets,
  getAllIncome,
  getExpensesForRange,
} from '@/lib/localDb'
import { pendingLabel } from '@/lib/money'

vi.mock('@/lib/localDb', () => ({
  getExpensesForRange: vi.fn(),
  getAllIncome: vi.fn(),
  getAllBudgets: vi.fn(),
}))

vi.mock('@/lib/appSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof AppSettings>()),
  getCurrencySettings: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
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

const fmt2 = (n: number) => formatAmount(n, 'en')

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

function renderPage(lang: Lang | null = null) {
  const Page = Route.options.component
  if (!Page) throw new Error('analytics route has no component')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      {lang === null ? (
        <Page />
      ) : (
        <I18nProvider initialLang={lang}>
          <Page />
        </I18nProvider>
      )}
    </QueryClientProvider>,
  )
}

afterEach(() => {
  setLang('en', { persist: false })
})

describe('analytics page: totals in the main currency', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setLang('en', { persist: false })
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
    setLang('en', { persist: false })
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

describe('analytics page in Ukrainian', () => {
  const CYRILLIC = /[Ѐ-ӿ]/

  beforeEach(() => {
    vi.resetAllMocks()
    setLang('en', { persist: false })
    vi.spyOn(Route, 'useSearch').mockReturnValue({})
    vi.mocked(getAllBudgets).mockResolvedValue([])
    vi.mocked(getAllIncome).mockResolvedValue([])
    setSettings()
  })

  it('shows the totals with грн and Ukrainian separators', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e1', 1234.5, 'UAH')])
    vi.mocked(getAllIncome).mockResolvedValue([income('i1', 250, 'UAH', SALARY)])

    renderPage('uk')

    const spent = await screen.findByTestId('analytics-total-spent')
    expect(spent.textContent).toMatch(/1\s234,50 грн/u)
    expect(spent.textContent).not.toContain('UAH')
    expect(screen.getByTestId('analytics-total-income').textContent).toContain(
      `${formatAmount(250, 'uk')} грн`,
    )
    expect(screen.getByTestId('dashboard-stats-total').textContent).toContain(
      formatAmount(1234.5, 'uk'),
    )
  })

  it('keeps the code of a foreign main currency', async () => {
    setSettings({ mainCurrency: 'EUR' })
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e1', 50, 'EUR')])

    renderPage('uk')

    const spent = await screen.findByTestId('analytics-total-spent')
    expect(spent.textContent).toContain('50,00 EUR')
    expect(spent.textContent).not.toContain('грн')
  })

  it('translates the pending-entries note with a plural form', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([
      expense('e1', 1000, 'UAH'),
      expense('e2', 100, 'USD'),
      expense('e3', 100, 'USD'),
    ])

    renderPage('uk')

    const note = await screen.findByTestId('conversion-pending-note')
    expect(note.textContent).toBe(pendingLabel(2))
    expect(note.textContent).toMatch(CYRILLIC)
    expect(note.textContent).not.toContain('entries')
  })

  it('translates the donut titles and the empty states and keeps category names as typed', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e1', 100, 'UAH')])
    vi.mocked(getAllIncome).mockResolvedValue([])

    renderPage('uk')

    const incomeDonut = await screen.findByTestId('analytics-income-donut')
    expect(incomeDonut.textContent).toMatch(CYRILLIC)
    expect(incomeDonut.textContent).not.toContain('Where your money comes from')
    expect(incomeDonut.textContent).not.toContain('No income in this period.')
    const spending = screen.getByTestId('analytics-category-donut').textContent
    expect(spending).toContain('Food')
    expect(spending).toMatch(CYRILLIC)
  })

  it('translates the no-data card', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([])

    renderPage('uk')

    const noData = await screen.findByTestId('analytics-no-data')
    expect(noData.textContent).toMatch(CYRILLIC)
    expect(noData.textContent).not.toContain('No data found')
  })
})

describe('analytics page: page container and chart grid', () => {
  const classesOf = (el: Element) => el.className.split(/\s+/)

  const CELL_BASE = ['flex', 'min-w-0', 'flex-col', 'lg:[&>[data-slot=card]]:flex-1']

  const chartGrid = () => screen.getByTestId('analytics-chart-grid')
  const cellIds = () => Array.from(chartGrid().children).map((c) => c.getAttribute('data-testid'))
  const cell = (id: string) => screen.getByTestId(id)
  const lgOrder = (id: string) =>
    classesOf(cell(id)).find((c) => /^lg:order-\d+$/.test(c))

  beforeEach(() => {
    vi.resetAllMocks()
    setLang('en', { persist: false })
    vi.spyOn(Route, 'useSearch').mockReturnValue({})
    vi.mocked(getAllBudgets).mockResolvedValue([])
    vi.mocked(getAllIncome).mockResolvedValue([])
    setSettings()
  })

  it('the loading state is a PageContainer too', () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e1', 100, 'UAH')])

    renderPage()

    const loading = screen.getByTestId('analytics-loading')
    expect(loading.getAttribute('data-page-container')).toBe('full')
    expect(classesOf(loading)).toContain('min-h-[60vh]')
  })

  it('renders inside a full-width PageContainer that keeps the column layout', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e1', 100, 'UAH')])

    renderPage()

    await screen.findByTestId('analytics-chart-grid')
    const page = screen.getByTestId('analytics-page')
    expect(page.getAttribute('data-page-container')).toBe('full')
    const classes = classesOf(page)
    for (const token of ['max-w-6xl', 'mx-auto', 'px-4', 'md:px-8', 'flex', 'flex-col', 'gap-8']) {
      expect(classes, token).toContain(token)
    }
    expect(classes).not.toContain('max-w-xl')
    expect(screen.queryByTestId('analytics-loading')).toBeNull()
  })

  it('the chart grid is one column and two columns from lg', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e1', 100, 'UAH')])

    renderPage()

    await screen.findByTestId('analytics-chart-grid')
    const classes = classesOf(chartGrid())
    for (const token of ['flex', 'flex-col', 'gap-8', 'lg:grid', 'lg:grid-cols-2']) {
      expect(classes, token).toContain(token)
    }
  })

  it('filters, summary numbers and the pending note are outside the grid, in the page', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([
      expense('e1', 100, 'UAH'),
      expense('e2', 100, 'USD'),
    ])

    renderPage()

    await screen.findByTestId('analytics-chart-grid')
    const page = screen.getByTestId('analytics-page')
    const grid = chartGrid()
    for (const id of ['analytics-filters', 'analytics-summary', 'conversion-pending-note']) {
      const el = screen.getByTestId(id)
      expect(page.contains(el), id).toBe(true)
      expect(grid.contains(el), id).toBe(false)
      expect(el.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING, id).toBeTruthy()
    }
    const summary = screen.getByTestId('analytics-summary')
    expect(summary.contains(screen.getByTestId('analytics-total-spent'))).toBe(true)
    expect(summary.contains(screen.getByTestId('analytics-total-income'))).toBe(true)
  })

  it('personal with data and no budgets: four cells in today\'s DOM order with their lg order', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e1', 100, 'UAH')])

    renderPage()

    await screen.findByTestId('analytics-chart-grid')
    expect(cellIds()).toEqual([
      'analytics-category-donut',
      'analytics-income-donut',
      'analytics-timeline',
      'analytics-monthly',
    ])
    expect(lgOrder('analytics-category-donut')).toBe('lg:order-1')
    expect(lgOrder('analytics-monthly')).toBe('lg:order-2')
    expect(lgOrder('analytics-income-donut')).toBe('lg:order-4')
    expect(lgOrder('analytics-timeline')).toBe('lg:order-6')
    expect(screen.queryByTestId('analytics-members')).toBeNull()
    expect(screen.queryByTestId('analytics-budget-variance')).toBeNull()
  })

  it('every cell is a flex column that can shrink and lets its card fill the row', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e1', 100, 'UAH')])

    renderPage()

    await screen.findByTestId('analytics-chart-grid')
    for (const id of cellIds()) {
      const classes = classesOf(cell(String(id)))
      for (const token of CELL_BASE) expect(classes, `${id} ${token}`).toContain(token)
    }
  })

  it('an even number of cells has no lg:col-span-2', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e1', 100, 'UAH')])

    renderPage()

    await screen.findByTestId('analytics-chart-grid')
    expect(cellIds()).toHaveLength(4)
    for (const id of cellIds()) {
      expect(classesOf(cell(String(id))), String(id)).not.toContain('lg:col-span-2')
    }
  })

  it('with budget data there are five cells, budget-vs-actual pairs with the income donut, and the last cell spans both columns', async () => {
    const budget: BudgetEntry & { categoryName: string; categoryIcon: null } = {
      id: 'b1',
      categoryId: 'c1',
      monthlyLimit: 200,
      currency: 'UAH',
      categoryName: 'Food',
      categoryIcon: null,
    }
    vi.mocked(getAllBudgets).mockResolvedValue([budget])
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e1', 100, 'UAH')])

    renderPage()

    await screen.findByTestId('analytics-budget-variance')
    expect(cellIds()).toEqual([
      'analytics-category-donut',
      'analytics-income-donut',
      'analytics-timeline',
      'analytics-budget-variance',
      'analytics-monthly',
    ])
    expect(lgOrder('analytics-budget-variance')).toBe('lg:order-3')
    expect(lgOrder('analytics-monthly')).toBe('lg:order-2')
    // Odd count: only the cell with the highest lg order (Over time) spans both.
    expect(classesOf(cell('analytics-timeline'))).toContain('lg:col-span-2')
    for (const id of cellIds().filter((c) => c !== 'analytics-timeline')) {
      expect(classesOf(cell(String(id))), String(id)).not.toContain('lg:col-span-2')
    }
  })

  it('no data: the no-data card sits first in lg order next to the 12-month chart, and nothing spans', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([])

    renderPage()

    await screen.findByTestId('analytics-no-data')
    expect(cellIds()).toEqual(['analytics-no-data', 'analytics-monthly'])
    expect(lgOrder('analytics-no-data')).toBe('lg:order-1')
    expect(lgOrder('analytics-monthly')).toBe('lg:order-2')
    expect(classesOf(cell('analytics-no-data'))).toContain('mt-4')
    for (const id of cellIds()) {
      expect(classesOf(cell(String(id))), String(id)).not.toContain('lg:col-span-2')
    }
  })

  it('the 12-month chart is always in the grid; the lg orders differ per cell', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([expense('e1', 100, 'UAH')])

    renderPage()

    await screen.findByTestId('analytics-chart-grid')
    const orders = cellIds().map((id) => lgOrder(String(id)))
    expect(new Set(orders).size).toBe(orders.length)
    expect(chartGrid().contains(screen.getByTestId('dashboard-stats-total'))).toBe(true)
    expect(cell('analytics-monthly').contains(screen.getByTestId('dashboard-stats-total'))).toBe(true)
  })
})
