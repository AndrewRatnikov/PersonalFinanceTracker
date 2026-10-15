// No CONTRACT_GAPs: the /recurring route, RecurringRow, RecurringForm testids
// and the localDb dependencies are specified in the Interface Contract
// (route: /recurring), plus recurring-monthly-main-{kind} and
// recurring-rates-unavailable. The real RecurringRow and RecurringForm are
// rendered; only @/lib/localDb, sonner, the vault/wipe modules, the currency
// settings and the rate provider ('@/lib/rates', as the contract requires) are
// mocked. "Today" is pinned with fake Date to local 2026-05-15 so totals and
// next dates are exact.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'

import type { CurrencySettings } from '@/lib/appSettings'
import type { Category, RecurringItem } from '@/lib/domain'
import type { RateTable } from '@/lib/rates/types'
import { getCurrencySettings } from '@/lib/appSettings'
import {
  addRecurring,
  deleteRecurring,
  getAllCategories,
  getAllIncomeCategories,
  getAllRecurring,
  setRecurringPaused,
  updateRecurring,
} from '@/lib/localDb'
import { rateProvider } from '@/lib/rates'
import { formatRecurringAmount } from '@/lib/recurrence'
import { DATA_ROUTES, isDataRoute } from '@/lib/vaultSession'
import { Route } from '@/routes/recurring'

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
  getAllRecurring: vi.fn(),
  getAllCategories: vi.fn(),
  getAllIncomeCategories: vi.fn(),
  addRecurring: vi.fn(),
  updateRecurring: vi.fn(),
  setRecurringPaused: vi.fn(),
  deleteRecurring: vi.fn(),
}))
vi.mock('@/lib/appSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/appSettings')>()),
  getCurrencySettings: vi.fn(),
}))
vi.mock('@/lib/rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rates')>()),
  rateProvider: { id: 'nbu', getRates: vi.fn() },
}))
vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const fmt2 = (n: number) =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

const EXPENSE_CATEGORIES: Array<Category> = [
  { id: 'c1', name: 'Food', icon: '🍔' },
]
const INCOME_CATEGORIES: Array<Category> = [
  { id: 'ic1', name: 'Salary', icon: '💼' },
]

const TODAY = '2026-05-15'
const RATES: RateTable = {
  base: 'UAH',
  effectiveDate: TODAY,
  perBase: { UAH: 1, USD: 41.52, EUR: 45.1 },
}

function make(overrides: Partial<RecurringItem> & { id: string }): RecurringItem {
  return {
    kind: 'expense',
    amount: 100,
    currency: 'UAH',
    categoryId: 'c1',
    description: null,
    frequency: { unit: 'month', interval: 1 },
    startDate: '2026-01-15',
    end: { type: 'never' },
    mode: 'auto',
    paused: false,
    handledThrough: null,
    handledAhead: [],
    occurrenceCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

// Next unhandled dates: p1 2026-05-20, e2 2026-05-22, i1 2026-06-01,
// e1 2026-06-15, e3 2027-03-01, old none (ended).
const ITEMS: Array<RecurringItem> = [
  make({
    id: 'e1',
    description: 'Gym',
    amount: 100,
    startDate: '2026-01-15',
    handledThrough: '2026-05-15',
  }),
  make({
    id: 'e2',
    description: 'Weekly beans',
    amount: 100,
    frequency: { unit: 'week', interval: 1 },
    startDate: '2026-05-01',
    handledThrough: '2026-05-15',
  }),
  make({
    id: 'e3',
    description: 'Domain',
    amount: 1200,
    currency: 'USD',
    frequency: { unit: 'year', interval: 1 },
    startDate: '2026-03-01',
    handledThrough: '2026-03-01',
  }),
  make({
    id: 'i1',
    kind: 'income',
    categoryId: 'ic1',
    description: 'Paycheck',
    amount: 2000,
    currency: 'EUR',
    mode: 'ask',
    startDate: '2026-05-01',
    handledThrough: '2026-05-01',
  }),
  make({
    id: 'p1',
    description: 'Paused sub',
    amount: 500,
    currency: 'USD',
    paused: true,
    startDate: '2026-04-20',
    handledThrough: '2026-04-20',
  }),
  make({
    id: 'old',
    description: 'Old plan',
    amount: 5,
    end: { type: 'afterCount', count: 1 },
    startDate: '2026-01-01',
    handledThrough: '2026-01-01',
    occurrenceCount: 1,
  }),
]

function setSettings(settings: Partial<CurrencySettings> = {}) {
  vi.mocked(getCurrencySettings).mockResolvedValue({
    mainCurrency: 'UAH',
    fetchExchangeRates: true,
    ...settings,
  })
}

function renderPage() {
  const Page = Route.options.component as React.ComponentType | undefined
  if (!Page) throw new Error('recurring route has no component')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  )
}

function rowNames() {
  return screen
    .getAllByTestId('recurring-row')
    .map((r) => within(r).getByTestId('recurring-row-name').textContent)
}

function rowFor(name: string) {
  const row = screen
    .getAllByTestId('recurring-row')
    .find((r) => within(r).getByTestId('recurring-row-name').textContent === name)
  if (!row) throw new Error(`no row named ${name}`)
  return row
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 4, 15, 10, 0, 0))
  vi.mocked(getAllRecurring).mockResolvedValue(ITEMS)
  vi.mocked(getAllCategories).mockResolvedValue(EXPENSE_CATEGORIES)
  vi.mocked(getAllIncomeCategories).mockResolvedValue(INCOME_CATEGORIES)
  vi.mocked(addRecurring).mockResolvedValue(make({ id: 'new' }))
  vi.mocked(updateRecurring).mockResolvedValue(make({ id: 'e1' }))
  vi.mocked(setRecurringPaused).mockResolvedValue(make({ id: 'e1' }))
  vi.mocked(deleteRecurring).mockResolvedValue(undefined)
  setSettings()
  // The rates never arrive unless a test says so, so the per-currency
  // fallback list is what the older tests below see.
  vi.mocked(rateProvider.getRates).mockReturnValue(
    new Promise<RateTable>(() => {}),
  )
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('recurring route is a data route', () => {
  it('/recurring is listed in DATA_ROUTES and isDataRoute is true for it and its children', () => {
    expect(DATA_ROUTES).toContain('/recurring')
    expect(isDataRoute('/recurring')).toBe(true)
    expect(isDataRoute('/recurring/abc')).toBe(true)
    expect(isDataRoute('/recurringx')).toBe(false)
  })
})

describe('recurring page: summary while there are no rates (per-currency fallback)', () => {
  it('shows "Committed per month" and one line per kind and currency, never mixed', async () => {
    renderPage()

    await screen.findByTestId('recurring-monthly-total')
    const card = screen.getByTestId('recurring-monthly-total')
    await waitFor(() => {
      expect(
        screen.getByTestId('recurring-monthly-total-expense-UAH'),
      ).toBeTruthy()
    })
    expect(card.textContent).toContain('Committed per month')
    const expenseUah = screen.getByTestId('recurring-monthly-total-expense-UAH')
    expect(expenseUah.textContent).toContain('Expenses')
    // 100 monthly + 100 weekly (433.33) = 533.33
    expect(expenseUah.textContent).toContain(formatRecurringAmount(533.33, 'UAH'))
    const expenseUsd = screen.getByTestId('recurring-monthly-total-expense-USD')
    expect(expenseUsd.textContent).toContain(formatRecurringAmount(100, 'USD'))
    const incomeEur = screen.getByTestId('recurring-monthly-total-income-EUR')
    expect(incomeEur.textContent).toContain('Income')
    expect(incomeEur.textContent).toContain(formatRecurringAmount(2000, 'EUR'))
  })

  it('has no line for a kind and currency without items, and ignores paused and ended items', async () => {
    renderPage()

    await screen.findByTestId('recurring-monthly-total-expense-UAH')
    expect(screen.queryByTestId('recurring-monthly-total-income-UAH')).toBeNull()
    expect(screen.queryByTestId('recurring-monthly-total-income-USD')).toBeNull()
    expect(screen.queryByTestId('recurring-monthly-total-expense-EUR')).toBeNull()
    // The paused 500 USD item is not part of the USD total.
    expect(
      screen.getByTestId('recurring-monthly-total-expense-USD').textContent,
    ).not.toContain(formatRecurringAmount(600, 'USD'))
    expect(
      screen.getByTestId('recurring-monthly-total-expense-USD').textContent,
    ).not.toContain(formatRecurringAmount(500, 'USD'))
    // The ended 5 UAH item is not part of the UAH total.
    expect(
      screen.getByTestId('recurring-monthly-total-expense-UAH').textContent,
    ).not.toContain(formatRecurringAmount(538.33, 'UAH'))
  })

  it('the totals follow the data: different items give different totals', async () => {
    vi.mocked(getAllRecurring).mockResolvedValue([
      make({
        id: 'x',
        amount: 300,
        frequency: { unit: 'month', interval: 2 },
        startDate: '2026-05-01',
        handledThrough: '2026-05-01',
      }),
    ])
    renderPage()

    const line = await screen.findByTestId('recurring-monthly-main-expense')

    expect(line.textContent).toContain(formatRecurringAmount(150, 'UAH'))
    expect(line.textContent).not.toContain(formatRecurringAmount(300, 'UAH'))
    expect(screen.queryByTestId('recurring-monthly-total-expense-UAH')).toBeNull()
    expect(screen.queryByTestId('recurring-monthly-total-expense-USD')).toBeNull()
  })

  it('says "Nothing committed yet" and shows the empty state when there are no items', async () => {
    vi.mocked(getAllRecurring).mockResolvedValue([])
    renderPage()

    const empty = await screen.findByTestId('recurring-empty')

    expect(empty.textContent).toContain('No recurring items yet')
    expect(screen.getByTestId('recurring-monthly-total').textContent).toContain(
      'Nothing committed yet',
    )
    expect(screen.queryByTestId('recurring-row')).toBeNull()
    expect(screen.getByTestId('recurring-page')).toBeTruthy()
    expect(screen.getByTestId('recurring-add-btn')).toBeTruthy()
  })

  it('shows the per-currency lines without any note while the rates are still loading', async () => {
    renderPage()

    await screen.findByTestId('recurring-monthly-total-expense-UAH')
    expect(screen.queryByTestId('recurring-rates-unavailable')).toBeNull()
    expect(screen.queryByTestId('recurring-monthly-main-expense')).toBeNull()
  })
})

describe('recurring page: one ≈ total per kind in the main currency', () => {
  it("converts every active item at today's rate and shows one line per kind", async () => {
    vi.mocked(rateProvider.getRates).mockResolvedValue(RATES)
    renderPage()

    const expense = await screen.findByTestId('recurring-monthly-main-expense')
    // 100 + 433.33 (weekly) UAH + 100 USD * 41.52
    expect(expense.textContent).toContain('Expenses')
    expect(expense.textContent).toContain(`≈ ${fmt2(100 + 433.33 + 100 * 41.52)} UAH`)
    const income = screen.getByTestId('recurring-monthly-main-income')
    expect(income.textContent).toContain('Income')
    expect(income.textContent).toContain(`≈ ${fmt2(2000 * 45.1)} UAH`)
    expect(rateProvider.getRates).toHaveBeenCalledWith(TODAY)
  })

  it('replaces the per-currency lines', async () => {
    vi.mocked(rateProvider.getRates).mockResolvedValue(RATES)
    renderPage()

    await screen.findByTestId('recurring-monthly-main-expense')
    expect(screen.queryByTestId('recurring-monthly-total-expense-UAH')).toBeNull()
    expect(screen.queryByTestId('recurring-monthly-total-expense-USD')).toBeNull()
    expect(screen.queryByTestId('recurring-monthly-total-income-EUR')).toBeNull()
    expect(screen.queryByTestId('recurring-rates-unavailable')).toBeNull()
  })

  it('a different rate gives a different total', async () => {
    vi.mocked(rateProvider.getRates).mockResolvedValue({
      ...RATES,
      perBase: { UAH: 1, USD: 40, EUR: 45.1 },
    })
    renderPage()

    const expense = await screen.findByTestId('recurring-monthly-main-expense')

    expect(expense.textContent).toContain(`≈ ${fmt2(100 + 433.33 + 100 * 40)} UAH`)
  })

  it('shows a kind that is entirely in the main currency exactly, without ≈', async () => {
    vi.mocked(rateProvider.getRates).mockResolvedValue(RATES)
    vi.mocked(getAllRecurring).mockResolvedValue([
      ITEMS[0],
      ITEMS[1],
      ITEMS[3],
    ])
    renderPage()

    const expense = await screen.findByTestId('recurring-monthly-main-expense')
    expect(expense.textContent).toContain(`${fmt2(533.33)} UAH`)
    expect(expense.textContent).not.toContain('≈')
    await screen.findByTestId('recurring-monthly-main-income')
    expect(
      screen.getByTestId('recurring-monthly-main-income').textContent,
    ).toContain('≈')
  })

  it('does not ask for rates when every active item is in the main currency', async () => {
    vi.mocked(getAllRecurring).mockResolvedValue([ITEMS[0], ITEMS[1]])
    renderPage()

    const expense = await screen.findByTestId('recurring-monthly-main-expense')

    expect(expense.textContent).toContain(`${fmt2(533.33)} UAH`)
    expect(expense.textContent).not.toContain('≈')
    expect(rateProvider.getRates).not.toHaveBeenCalled()
    expect(screen.queryByTestId('recurring-rates-unavailable')).toBeNull()
  })

  it('totals in the main currency from the settings (EUR)', async () => {
    setSettings({ mainCurrency: 'EUR' })
    vi.mocked(rateProvider.getRates).mockResolvedValue(RATES)
    renderPage()

    const income = await screen.findByTestId('recurring-monthly-main-income')

    // The only income item is already in EUR.
    expect(income.textContent).toContain(`${fmt2(2000)} EUR`)
    const expense = screen.getByTestId('recurring-monthly-main-expense')
    expect(expense.textContent).toContain('EUR')
    expect(expense.textContent).toContain(
      `≈ ${fmt2((100 + 433.33) / 45.1 + (100 * 41.52) / 45.1)} EUR`,
    )
  })
})

describe('recurring page: rates unavailable', () => {
  it('falls back to the per-currency lines and says so when the rates fail', async () => {
    vi.mocked(rateProvider.getRates).mockRejectedValue(new Error('NBU down'))
    renderPage()

    const note = await screen.findByTestId('recurring-rates-unavailable')
    expect(note.textContent).toContain('Exchange rates unavailable')
    expect(
      screen.getByTestId('recurring-monthly-total-expense-UAH').textContent,
    ).toContain(formatRecurringAmount(533.33, 'UAH'))
    expect(
      screen.getByTestId('recurring-monthly-total-expense-USD').textContent,
    ).toContain(formatRecurringAmount(100, 'USD'))
    expect(
      screen.getByTestId('recurring-monthly-total-income-EUR').textContent,
    ).toContain(formatRecurringAmount(2000, 'EUR'))
    expect(screen.queryByTestId('recurring-monthly-main-expense')).toBeNull()
    expect(screen.queryByTestId('recurring-monthly-main-income')).toBeNull()
  })

  it('does not fetch rates when exchange rates are off, and says rates are unavailable', async () => {
    setSettings({ fetchExchangeRates: false })
    renderPage()

    const note = await screen.findByTestId('recurring-rates-unavailable')

    expect(note.textContent).toContain('Exchange rates unavailable')
    expect(rateProvider.getRates).not.toHaveBeenCalled()
    expect(
      screen.getByTestId('recurring-monthly-total-expense-UAH'),
    ).toBeTruthy()
  })

  it('with rates off but only main-currency items, still shows the exact main total and no note', async () => {
    setSettings({ fetchExchangeRates: false })
    vi.mocked(getAllRecurring).mockResolvedValue([ITEMS[0], ITEMS[1]])
    renderPage()

    const expense = await screen.findByTestId('recurring-monthly-main-expense')

    expect(expense.textContent).toContain(`${fmt2(533.33)} UAH`)
    expect(screen.queryByTestId('recurring-rates-unavailable')).toBeNull()
    expect(rateProvider.getRates).not.toHaveBeenCalled()
  })
})

describe('recurring page: list', () => {
  it('renders one row per item, ordered by next occurrence with ended items last', async () => {
    renderPage()

    await screen.findAllByTestId('recurring-row')

    expect(rowNames()).toEqual([
      'Paused sub',
      'Weekly beans',
      'Paycheck',
      'Gym',
      'Domain',
      'Old plan',
    ])
    expect(screen.queryByTestId('recurring-empty')).toBeNull()
  })

  it('each row shows amount, frequency, next date and mode', async () => {
    renderPage()
    await screen.findAllByTestId('recurring-row')

    const gym = within(rowFor('Gym'))
    expect(gym.getByTestId('recurring-row-amount').textContent).toContain(
      formatRecurringAmount(100, 'UAH'),
    )
    expect(gym.getByTestId('recurring-row-frequency').textContent).toBe(
      'Every month on the 15th',
    )
    expect(gym.getByTestId('recurring-row-next').textContent).toContain(
      'Jun 15, 2026',
    )
    expect(gym.getByTestId('recurring-row-mode').textContent).toContain('Auto')

    const paycheck = within(rowFor('Paycheck'))
    expect(paycheck.getByTestId('recurring-row-amount').textContent).toContain(
      formatRecurringAmount(2000, 'EUR'),
    )
    expect(paycheck.getByTestId('recurring-row-mode').textContent).toContain('Ask')
    expect(paycheck.getByTestId('recurring-row-next').textContent).toContain(
      'Jun 1, 2026',
    )
  })

  it('shows Paused only on the paused row and "Ended" for an ended item', async () => {
    renderPage()
    await screen.findAllByTestId('recurring-row')

    expect(within(rowFor('Paused sub')).getByTestId('recurring-row-paused').textContent).toContain('Paused')
    expect(within(rowFor('Gym')).queryByTestId('recurring-row-paused')).toBeNull()
    expect(within(rowFor('Old plan')).getByTestId('recurring-row-next').textContent).toContain('Ended')
    expect(within(rowFor('Paused sub')).getByTestId('recurring-pause-btn').textContent).toContain('Resume')
    expect(within(rowFor('Gym')).getByTestId('recurring-pause-btn').textContent).toContain('Pause')
  })

  it('falls back to the category name, then to "Unknown category", and flags a missing category', async () => {
    vi.mocked(getAllRecurring).mockResolvedValue([
      make({ id: 'a', description: null, categoryId: 'c1', handledThrough: '2026-05-15' }),
      make({ id: 'b', description: null, categoryId: 'gone', handledThrough: '2026-05-15' }),
    ])
    renderPage()

    await screen.findAllByTestId('recurring-row')

    const names = rowNames()
    expect(names).toContain('Food')
    expect(names).toContain('Unknown category')
    const orphan = within(rowFor('Unknown category'))
    expect(orphan.getByTestId('recurring-row-category-missing').textContent).toContain(
      'Category missing',
    )
    expect(within(rowFor('Food')).queryByTestId('recurring-row-category-missing')).toBeNull()
  })
})

describe('recurring page: row actions', () => {
  it('Pause calls setRecurringPaused(id, true) and refetches the list', async () => {
    renderPage()
    await screen.findAllByTestId('recurring-row')
    const callsBefore = vi.mocked(getAllRecurring).mock.calls.length

    fireEvent.click(within(rowFor('Gym')).getByTestId('recurring-pause-btn'))

    await waitFor(() => expect(setRecurringPaused).toHaveBeenCalledTimes(1))
    expect(vi.mocked(setRecurringPaused).mock.calls[0].slice(0, 2)).toEqual(['e1', true])
    await waitFor(() => {
      expect(vi.mocked(getAllRecurring).mock.calls.length).toBeGreaterThan(callsBefore)
    })
  })

  it('Resume calls setRecurringPaused(id, false)', async () => {
    renderPage()
    await screen.findAllByTestId('recurring-row')

    fireEvent.click(within(rowFor('Paused sub')).getByTestId('recurring-pause-btn'))

    await waitFor(() => expect(setRecurringPaused).toHaveBeenCalledTimes(1))
    expect(vi.mocked(setRecurringPaused).mock.calls[0].slice(0, 2)).toEqual(['p1', false])
  })

  it('Delete asks first ("Past transactions are kept."), then deletes on confirm', async () => {
    renderPage()
    await screen.findAllByTestId('recurring-row')

    fireEvent.click(within(rowFor('Gym')).getByTestId('recurring-delete-btn'))

    const description = await screen.findByTestId('recurring-delete-description')
    expect(description.textContent).toContain('Past transactions are kept.')
    expect(deleteRecurring).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('recurring-delete-confirm'))
    await waitFor(() => expect(deleteRecurring).toHaveBeenCalledTimes(1))
    expect(vi.mocked(deleteRecurring).mock.calls[0][0]).toBe('e1')
  })

  it('Edit opens the form prefilled with that item', async () => {
    renderPage()
    await screen.findAllByTestId('recurring-row')

    fireEvent.click(within(rowFor('Weekly beans')).getByTestId('recurring-edit-btn'))

    const form = await screen.findByTestId('recurring-form')
    expect(within(form).getByTestId<HTMLInputElement>('recurring-form-amount').value).toBe('100')
    expect(
      within(form).getByTestId<HTMLInputElement>('recurring-form-description').value,
    ).toBe('Weekly beans')
    expect(within(form).getByTestId<HTMLSelectElement>('recurring-form-unit').value).toBe('week')
    expect(within(form).queryByTestId('recurring-form-backfill')).toBeNull()
  })

  it('saving an edit calls updateRecurring(id, input), toasts and closes the form', async () => {
    renderPage()
    await screen.findAllByTestId('recurring-row')
    fireEvent.click(within(rowFor('Gym')).getByTestId('recurring-edit-btn'))
    const form = await screen.findByTestId('recurring-form')
    fireEvent.change(within(form).getByTestId('recurring-form-amount'), {
      target: { value: '150' },
    })

    fireEvent.submit(form)

    await waitFor(() => expect(updateRecurring).toHaveBeenCalledTimes(1))
    const [id, patch] = vi.mocked(updateRecurring).mock.calls[0]
    expect(id).toBe('e1')
    expect(patch).toMatchObject({ amount: 150, description: 'Gym', kind: 'expense' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Recurring item saved'))
    await waitFor(() => expect(screen.queryByTestId('recurring-form')).toBeNull())
    expect(addRecurring).not.toHaveBeenCalled()
  })
})

describe('recurring page: add', () => {
  it('shows no form until Add is clicked, and Cancel closes it', async () => {
    renderPage()
    await screen.findAllByTestId('recurring-row')
    expect(screen.queryByTestId('recurring-form')).toBeNull()

    fireEvent.click(screen.getByTestId('recurring-add-btn'))
    expect(await screen.findByTestId('recurring-form')).toBeTruthy()
    fireEvent.click(screen.getByTestId('recurring-form-cancel'))

    await waitFor(() => expect(screen.queryByTestId('recurring-form')).toBeNull())
  })

  it('submitting calls addRecurring with the form values and createThroughToday, toasts, closes and refetches', async () => {
    renderPage()
    await screen.findAllByTestId('recurring-row')
    const callsBefore = vi.mocked(getAllRecurring).mock.calls.length
    fireEvent.click(screen.getByTestId('recurring-add-btn'))
    const form = await screen.findByTestId('recurring-form')
    fireEvent.change(within(form).getByTestId('recurring-form-amount'), {
      target: { value: '40' },
    })
    fireEvent.change(within(form).getByTestId('recurring-form-description'), {
      target: { value: 'Newspaper' },
    })

    fireEvent.submit(form)

    await waitFor(() => expect(addRecurring).toHaveBeenCalledTimes(1))
    const [input, options] = vi.mocked(addRecurring).mock.calls[0]
    expect(input).toMatchObject({
      kind: 'expense',
      amount: 40,
      currency: 'UAH',
      categoryId: 'c1',
      description: 'Newspaper',
      startDate: '2026-05-15',
      mode: 'auto',
    })
    expect(options.createThroughToday).toBe(true)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Recurring item saved'))
    await waitFor(() => expect(screen.queryByTestId('recurring-form')).toBeNull())
    await waitFor(() => {
      expect(vi.mocked(getAllRecurring).mock.calls.length).toBeGreaterThan(callsBefore)
    })
    expect(updateRecurring).not.toHaveBeenCalled()
  })

  it('a new item defaults to the main currency from the settings', async () => {
    setSettings({ mainCurrency: 'EUR' })
    renderPage()
    await screen.findAllByTestId('recurring-row')
    fireEvent.click(screen.getByTestId('recurring-add-btn'))
    const form = await screen.findByTestId('recurring-form')
    fireEvent.change(within(form).getByTestId('recurring-form-amount'), {
      target: { value: '40' },
    })

    fireEvent.submit(form)

    await waitFor(() => expect(addRecurring).toHaveBeenCalledTimes(1))
    expect(vi.mocked(addRecurring).mock.calls[0][0]).toMatchObject({
      currency: 'EUR',
    })
  })

  it('a failed save toasts the error message and keeps the form open', async () => {
    vi.mocked(addRecurring).mockRejectedValue(new Error('Category not found'))
    renderPage()
    await screen.findAllByTestId('recurring-row')
    fireEvent.click(screen.getByTestId('recurring-add-btn'))
    const form = await screen.findByTestId('recurring-form')
    fireEvent.change(within(form).getByTestId('recurring-form-amount'), {
      target: { value: '40' },
    })

    fireEvent.submit(form)

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain('Category not found')
    expect(screen.getByTestId('recurring-form')).toBeTruthy()
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('recurring page: query errors', () => {
  it.each([
    ['recurring items', () => vi.mocked(getAllRecurring).mockRejectedValue(new Error('boom'))],
    ['expense categories', () => vi.mocked(getAllCategories).mockRejectedValue(new Error('boom'))],
    ['income categories', () => vi.mocked(getAllIncomeCategories).mockRejectedValue(new Error('boom'))],
  ])('shows query-error instead of content when the %s fail to load', async (_name, fail) => {
    fail()
    renderPage()

    await screen.findByTestId('query-error')

    expect(screen.queryByTestId('recurring-row')).toBeNull()
    expect(screen.queryByTestId('recurring-monthly-total')).toBeNull()
  })

  it('Retry refetches the failed query and then shows the rows', async () => {
    vi.mocked(getAllRecurring)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(ITEMS)
    renderPage()
    await screen.findByTestId('query-error')
    expect(getAllRecurring).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('query-error-retry'))

    await waitFor(() => expect(getAllRecurring).toHaveBeenCalledTimes(2))
    await screen.findAllByTestId('recurring-row')
    expect(screen.queryByTestId('query-error')).toBeNull()
  })
})
