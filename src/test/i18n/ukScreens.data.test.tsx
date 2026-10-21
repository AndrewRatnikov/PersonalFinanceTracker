// CONTRACT_GAP: the Ukrainian wording of these screens is the Coder's, so each
// screen is checked for what must not be there (the English words Save, Cancel,
// Add, Delete, Settings, Income, Expenses, in text and in aria-label /
// placeholder / title / alt attributes) and for what must be there (Cyrillic
// text, грн amounts, the plan's key texts where the plan fixes them).
// Fixture user data (category names, descriptions) contains none of the checked
// words. The mock environment follows query-errors.test.tsx: '@/lib/localDb' is
// replaced by a list of vi.fn()s, the router Link by a plain anchor, and the
// route hooks (useSearch / useNavigate) are spied because no router is mounted.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import dayjs from 'dayjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'
import type * as AppSettings from '@/lib/appSettings'
import type * as BackupReminder from '@/lib/backupReminder'
import type * as InstallHint from '@/lib/installHint'
import type * as Rates from '@/lib/rates'
import type * as StoragePersistence from '@/lib/storagePersistence'

import type {
  BudgetEntry,
  Category,
  Expense,
  IncomeEntry,
  RecurringItem,
} from '@/lib/domain'
import type { RateTable } from '@/lib/rates/types'
import { setLang } from '@/i18n/core'
import { formatAmount } from '@/i18n/format'
import { I18nProvider } from '@/i18n/react'
import { getAppSettings, getCurrencySettings } from '@/lib/appSettings'
import { useAccountSession, useAccountsVisible } from '@/lib/accountSession'
import { getBackupReminderStatus, getBackupSettings } from '@/lib/backupReminder'
import { getConversionStatus } from '@/lib/conversion'
import {
  getAllBudgets,
  getAllCategories,
  getAllExpenses,
  getAllIncome,
  getAllIncomeCategories,
  getAllRecurring,
  getExpensesForRange,
} from '@/lib/localDb'
import { rateProvider } from '@/lib/rates'
import { formatBytes, getStorageStatus } from '@/lib/storagePersistence'
import { cancelCreateVault, setVaultPhase } from '@/lib/vaultSession'
import Header from '@/components/Header'
import { Route as AnalyticsRoute } from '@/routes/analytics'
import { Route as IncomeRoute } from '@/routes/income'
import { Route as IndexRoute } from '@/routes/index'
import { Route as RecurringRoute } from '@/routes/recurring'
import { Route as SettingsRoute } from '@/routes/settings'
import { Route as TransactionsRoute } from '@/routes/transactions'

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  useNavigate: () => vi.fn(),
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
  addIncome: vi.fn(),
  deleteIncome: vi.fn(),
  addRepeatingIncome: vi.fn(),
  addRecurring: vi.fn(),
  updateRecurring: vi.fn(),
  setRecurringPaused: vi.fn(),
  deleteRecurring: vi.fn(),
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
}))
vi.mock('@/lib/appSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof AppSettings>()),
  getCurrencySettings: vi.fn(),
  updateCurrencySettings: vi.fn(),
  getAppSettings: vi.fn(),
  updateAppSettings: vi.fn(),
}))
vi.mock('@/lib/conversion', () => {
  class FakeMainCurrencyChangeError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.name = 'MainCurrencyChangeError'
      this.code = code
    }
  }
  return {
    CONVERSION_STATUS_QUERY_KEY: ['conversion-status'],
    MainCurrencyChangeError: FakeMainCurrencyChangeError,
    getConversionStatus: vi.fn(),
    changeMainCurrency: vi.fn(),
    requestConversion: vi.fn(),
  }
})
vi.mock('@/lib/backupReminder', async (importOriginal) => ({
  ...(await importOriginal<typeof BackupReminder>()),
  getBackupReminderStatus: vi.fn(),
  snoozeBackupReminder: vi.fn(),
  getBackupSettings: vi.fn(),
  updateBackupSettings: vi.fn(),
}))
vi.mock('@/lib/installHint', async (importOriginal) => ({
  ...(await importOriginal<typeof InstallHint>()),
  shouldShowInstallHint: () => true,
}))
vi.mock('@/lib/storagePersistence', async (importOriginal) => ({
  ...(await importOriginal<typeof StoragePersistence>()),
  getStorageStatus: vi.fn(),
}))
vi.mock('@/lib/rates', async (importOriginal) => ({
  ...(await importOriginal<typeof Rates>()),
  rateProvider: { id: 'nbu', getRates: vi.fn() },
}))
vi.mock('@/lib/vault', () => ({
  lockVault: vi.fn(),
  changePassword: vi.fn(),
  regenerateRecoveryKey: vi.fn(),
  VaultError: class VaultError extends Error {},
}))
vi.mock('@/lib/backup', () => ({
  downloadBackup: vi.fn(),
  formatRestoreSummary: vi.fn(),
}))
vi.mock('@/lib/localExport', () => ({ exportAllLocalData: vi.fn() }))
vi.mock('@/lib/localImport', () => ({ importLocalDataFile: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({
  reloadToHome: vi.fn(),
  wipeLocalData: vi.fn(),
}))
vi.mock('@/lib/accountSession', () => ({
  ACCOUNT_SESSION_QUERY_KEY: ['account-session'],
  useAccountsVisible: vi.fn(),
  useAccountSession: vi.fn(),
  signOutAccount: vi.fn(),
}))
vi.mock('@/components/RestoreBackupDialog', () => ({
  RestoreBackupDialog: () => null,
}))
vi.mock('@/components/RemoveDataDialog', () => ({
  RemoveDataDialog: () => null,
}))
vi.mock('@/components/settings/DeleteAccountDialog', () => ({
  DeleteAccountDialog: () => null,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const CYRILLIC = /[Ѐ-ӿ]/
const FORBIDDEN = /\b(Save|Cancel|Add|Delete|Settings|Income|Expenses)\b/

// Everything a user can see or hear on the page: text plus the accessible
// attributes.
function visibleStrings(): Array<string> {
  const strings = [document.body.textContent]
  for (const attribute of ['aria-label', 'placeholder', 'title', 'alt']) {
    document.body
      .querySelectorAll(`[${attribute}]`)
      .forEach((el) => strings.push(el.getAttribute(attribute) ?? ''))
  }
  return strings
}

function expectUkrainianOnly() {
  const strings = visibleStrings()

  expect(strings.join('\n')).toMatch(CYRILLIC)
  expect(strings.filter((s) => FORBIDDEN.test(s))).toEqual([])
}

function renderUk(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLang="uk">{ui}</I18nProvider>
    </QueryClientProvider>,
  )
}

function renderRoute(Route: { options: { component?: unknown } }) {
  const Page = Route.options.component as React.ComponentType | undefined
  if (!Page) throw new Error('route has no component')
  return renderUk(<Page />)
}

const NOW = new Date().toISOString()
const YESTERDAY = dayjs().subtract(1, 'day').format('YYYY-MM-DD')

const FOOD: Category = { id: 'c1', name: 'Food', icon: '🍔' }
const COFFEE: Category = { id: 'c2', name: 'Coffee', icon: '☕' }
const SALARY: Category = { id: 'ic1', name: 'Salary', icon: '💼' }

const EXPENSES: Array<Expense> = [
  {
    id: 'e1',
    amount: 1250.5,
    currency: 'UAH',
    categoryId: 'c1',
    description: 'Lunch',
    createdAt: NOW,
    category: FOOD,
  },
  {
    id: 'e2',
    amount: 65,
    currency: 'UAH',
    categoryId: 'c2',
    description: 'Latte',
    createdAt: NOW,
    category: COFFEE,
  },
  {
    id: 'e3',
    amount: 20,
    currency: 'USD',
    categoryId: 'c1',
    description: 'Taxi',
    createdAt: NOW,
    category: FOOD,
  },
]

const INCOME: Array<IncomeEntry> = [
  {
    id: 'i1',
    categoryId: 'ic1',
    category: SALARY,
    amount: 30000,
    currency: 'UAH',
    createdAt: NOW,
  },
]

type StoredBudget = BudgetEntry & {
  categoryName: string
  categoryIcon: string | null
}

const BUDGETS: Array<StoredBudget> = [
  {
    id: 'b1',
    categoryId: 'c1',
    monthlyLimit: 5000,
    currency: 'UAH',
    categoryName: 'Food',
    categoryIcon: '🍔',
  },
]

function recurring(overrides: Partial<RecurringItem> & { id: string }): RecurringItem {
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

const RECURRING: Array<RecurringItem> = [
  recurring({
    id: 'r1',
    description: 'Gym',
    amount: 400,
    mode: 'ask',
    startDate: YESTERDAY,
  }),
  recurring({
    id: 'r2',
    description: 'Weekly beans',
    frequency: { unit: 'week', interval: 2 },
    startDate: '2026-05-01',
    handledThrough: '2026-05-15',
  }),
  recurring({
    id: 'r3',
    kind: 'income',
    categoryId: 'ic1',
    description: 'Paycheck',
    amount: 2000,
    currency: 'EUR',
    startDate: '2026-05-01',
    handledThrough: '2026-05-01',
  }),
]

const APP_SETTINGS = {
  autoLockMinutes: 15,
  installHintDismissed: false,
  persistRequestedAt: null,
  recoveryKeyConfirmed: false,
}

const RATES: RateTable = {
  base: 'UAH',
  effectiveDate: dayjs().format('YYYY-MM-DD'),
  perBase: { UAH: 1, USD: 41.52, EUR: 45.1 },
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  setLang('en', { persist: false })
  cancelCreateVault()
  vi.mocked(getAllCategories).mockResolvedValue([FOOD, COFFEE])
  vi.mocked(getAllIncomeCategories).mockResolvedValue([SALARY])
  vi.mocked(getExpensesForRange).mockResolvedValue(EXPENSES)
  vi.mocked(getAllExpenses).mockResolvedValue(EXPENSES)
  vi.mocked(getAllIncome).mockResolvedValue(INCOME)
  vi.mocked(getAllBudgets).mockResolvedValue(BUDGETS)
  vi.mocked(getAllRecurring).mockResolvedValue(RECURRING)
  vi.mocked(getCurrencySettings).mockResolvedValue({
    mainCurrency: 'UAH',
    fetchExchangeRates: true,
  })
  vi.mocked(getAppSettings).mockResolvedValue(APP_SETTINGS)
  vi.mocked(getBackupReminderStatus).mockResolvedValue({
    show: true,
    daysSinceBackup: 19,
  })
  vi.mocked(getBackupSettings).mockResolvedValue({
    backupReminderDays: 14,
    lastBackupAt: null,
    lastDataChangeAt: null,
    backupReminderSnoozedUntil: null,
  })
  vi.mocked(getConversionStatus).mockResolvedValue({
    mainCurrency: 'UAH',
    fetchExchangeRates: true,
    totalEntries: 3,
    pendingEntries: 1,
    pendingBudgets: 0,
  })
  vi.mocked(getStorageStatus).mockResolvedValue({
    persisted: false,
    usage: 1536,
    quota: 1048576,
  })
  vi.mocked(rateProvider.getRates).mockResolvedValue(RATES)
  vi.mocked(useAccountsVisible).mockReturnValue(false)
  vi.mocked(useAccountSession).mockReturnValue(null)
  vi.spyOn(AnalyticsRoute, 'useSearch').mockReturnValue({})
  vi.spyOn(TransactionsRoute, 'useSearch').mockReturnValue({ add: 'expense' })
  vi.spyOn(TransactionsRoute, 'useNavigate').mockReturnValue(vi.fn() as never)
  vi.spyOn(SettingsRoute, 'useSearch').mockReturnValue({})
})

afterEach(() => {
  cleanup()
  act(() => {
    setVaultPhase('checking')
  })
  setLang('en', { persist: false })
  vi.restoreAllMocks()
})

describe('dashboard in Ukrainian', () => {
  it('has no English UI words, with грн amounts, banners and Quick Add', async () => {
    setVaultPhase('unlocked')

    renderRoute(IndexRoute)

    await screen.findByTestId('dashboard-summary')
    await screen.findByTestId('recovery-key-unconfirmed-banner')
    await screen.findByTestId('backup-reminder-banner')
    await screen.findByTestId('install-hint')
    expect((await screen.findAllByTestId('recent-activity-item')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByTestId('speed-entry-form')).toBeTruthy()
    await screen.findByTestId('recurring-due')
    expect(document.body.textContent).toContain('грн')
    expect(document.body.textContent).toMatch(/1\s250,50 грн/u)
    expectUkrainianOnly()
  })

  it('translates the banners', async () => {
    setVaultPhase('unlocked')

    renderRoute(IndexRoute)

    const recovery = await screen.findByTestId('recovery-key-unconfirmed-text')
    const backup = await screen.findByTestId('backup-reminder-text')
    for (const el of [
      recovery,
      backup,
      screen.getByTestId('backup-reminder-now'),
      screen.getByTestId('backup-reminder-later'),
      screen.getByTestId('recovery-key-unconfirmed-action'),
      screen.getByTestId('install-hint-dismiss'),
    ]) {
      expect(el.textContent).toMatch(CYRILLIC)
    }
    expect(backup.textContent).toContain('19')
    expect(recovery.textContent).not.toContain("You haven't saved a recovery key")
  })

  it('translates the recurring items that are due', async () => {
    setVaultPhase('unlocked')

    renderRoute(IndexRoute)

    const due = await screen.findByTestId('recurring-due')
    expect(due.textContent).toMatch(CYRILLIC)
    expect(due.textContent).toContain('Gym')
    expect(screen.getByTestId('recurring-due-add').textContent).toMatch(CYRILLIC)
    expect(screen.getByTestId('recurring-due-skip').textContent).toMatch(CYRILLIC)
  })
})

describe('Transactions page with the drawer open, in Ukrainian', () => {
  it('has no English UI words in the table, the filter and the drawer', async () => {
    renderRoute(TransactionsRoute)

    await screen.findByTestId('transactions-page')
    await screen.findAllByTestId('transaction-row')
    await screen.findByTestId('expense-drawer')
    expect(screen.getByTestId('expense-drawer-title').textContent).toMatch(CYRILLIC)
    expect(screen.getByTestId('transactions-add-btn').textContent).toMatch(CYRILLIC)
    expect(document.body.textContent).toMatch(/1\s250,50 грн/u)
    expectUkrainianOnly()
  })

  it('has no English UI words with the drawer closed', async () => {
    vi.spyOn(TransactionsRoute, 'useSearch').mockReturnValue({})

    renderRoute(TransactionsRoute)

    await screen.findAllByTestId('transaction-row')
    expect(screen.queryByTestId('expense-drawer')).toBeNull()
    expectUkrainianOnly()
  })
})

describe('Income page in Ukrainian', () => {
  it('has no English UI words in the form and the table', async () => {
    renderRoute(IncomeRoute)

    await screen.findByTestId('income-page')
    await screen.findByTestId('add-income-form')
    await screen.findAllByTestId('income-row')
    expect(screen.getByTestId('income-form-submit').textContent).toMatch(CYRILLIC)
    expect(screen.getByTestId('income-row').textContent).toMatch(/30\s000,00 грн/u)
    expectUkrainianOnly()
  })
})

describe('Recurring page in Ukrainian', () => {
  it('has no English UI words in the summary and the list', async () => {
    renderRoute(RecurringRoute)

    await screen.findAllByTestId('recurring-row')
    await screen.findByTestId('recurring-monthly-main-expense')
    expect(screen.getByTestId('recurring-add-btn').textContent).toMatch(CYRILLIC)
    expect(document.body.textContent).toContain('Кожні 2 тижні')
    expectUkrainianOnly()
  })

  it('has no English UI words in the form', async () => {
    renderRoute(RecurringRoute)
    await screen.findAllByTestId('recurring-row')

    fireEvent.click(screen.getByTestId('recurring-add-btn'))

    await screen.findByTestId('recurring-form')
    expect(screen.getByTestId('recurring-form-submit').textContent).toMatch(CYRILLIC)
    expect(screen.getByTestId('recurring-form-cancel').textContent).toMatch(CYRILLIC)
    expectUkrainianOnly()
  })

  it('has no English UI words in the empty state', async () => {
    vi.mocked(getAllRecurring).mockResolvedValue([])

    renderRoute(RecurringRoute)

    await screen.findByTestId('recurring-empty')
    expect(screen.getByTestId('recurring-empty').textContent).toMatch(CYRILLIC)
    expectUkrainianOnly()
  })
})

describe('Analytics page in Ukrainian', () => {
  it('has no English UI words in the totals, the filters and the charts', async () => {
    renderRoute(AnalyticsRoute)

    await screen.findByTestId('analytics-total-spent')
    await screen.findByTestId('analytics-category-donut')
    expect(screen.getByTestId('analytics-total-spent').textContent).toMatch(/грн/)
    expect(screen.getByTestId('analytics-income-donut').textContent).toMatch(CYRILLIC)
    expectUkrainianOnly()
  })

  it('has no English UI words when there is no data', async () => {
    vi.mocked(getExpensesForRange).mockResolvedValue([])
    vi.mocked(getAllIncome).mockResolvedValue([])
    vi.mocked(getAllBudgets).mockResolvedValue([])

    renderRoute(AnalyticsRoute)

    await screen.findByTestId('analytics-no-data')
    expectUkrainianOnly()
  })
})

describe('every Settings tab in Ukrainian', () => {
  function openTab(tab: string) {
    vi.spyOn(SettingsRoute, 'useSearch').mockReturnValue({ tab } as never)
    return renderRoute(SettingsRoute)
  }

  it('General', async () => {
    openTab('general')

    await screen.findByTestId('general-tab')
    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLSelectElement>('settings-main-currency').value,
      ).toBe('UAH')
    })
    await waitFor(() => {
      expect(screen.getByTestId('settings-conversion-status').textContent.trim()).not.toBe('')
    })
    expect(screen.getByTestId('settings-language')).toBeTruthy()
    expectUkrainianOnly()
  })

  it('Categories', async () => {
    openTab('categories')

    await screen.findByTestId('categories-tab')
    await waitFor(() => {
      expect(screen.getAllByTestId('category-row').length).toBeGreaterThan(0)
    })
    expectUkrainianOnly()
  })

  it('Budget', async () => {
    openTab('budget')

    await screen.findByTestId('budget-tab')
    await waitFor(() => {
      expect(screen.getAllByTestId('budget-row-currency').length).toBeGreaterThan(0)
    })
    expectUkrainianOnly()
  })

  it('Security', async () => {
    openTab('security')

    await screen.findByTestId('security-tab')
    await screen.findByTestId('auto-lock-select')
    expect(screen.getByTestId('change-password-submit').textContent).toMatch(CYRILLIC)
    expect(screen.getByTestId('lock-now-btn').textContent).toMatch(CYRILLIC)
    expectUkrainianOnly()
  })

  it('Data, with the storage status', async () => {
    openTab('data')

    await screen.findByTestId('data-backup-card')
    await screen.findByTestId('storage-status-label')
    expect(screen.getByTestId('danger-zone-card').textContent).toMatch(CYRILLIC)
    expect(screen.getByTestId('storage-status-label').textContent).toMatch(CYRILLIC)
    expect(screen.getByTestId('storage-status-label').textContent).not.toBe('Best-effort')
    expect(screen.getByTestId('storage-status-hint').textContent).toMatch(CYRILLIC)
    expect(screen.getByTestId('storage-status-usage').textContent).toMatch(/КБ/)
    expect(screen.getByTestId('storage-status-usage').textContent).toMatch(/МБ/)
    expectUkrainianOnly()
  })

  it('Account, when accounts are visible', async () => {
    vi.mocked(useAccountsVisible).mockReturnValue(true)

    openTab('account')

    await screen.findByTestId('account-tab')
    expect(screen.getByTestId('settings-tab-account').textContent).toMatch(CYRILLIC)
    expect(screen.getByTestId('account-sign-in-link').textContent).toMatch(CYRILLIC)
    expectUkrainianOnly()
  })

  it('the tab bar and the title are translated', async () => {
    openTab('general')

    await screen.findByTestId('general-tab')
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.textContent, tab.textContent).toMatch(CYRILLIC)
    }
    expect(screen.getByTestId('settings-tab-general').textContent).toMatch(CYRILLIC)
  })
})

describe('navigation in Ukrainian', () => {
  it('the menu of an unlocked app has no English UI words', () => {
    setVaultPhase('unlocked')
    renderUk(<Header />)

    fireEvent.click(screen.getByTestId('header-menu-btn'))

    expect(screen.getByTestId('nav-link-recurring').textContent).toMatch(CYRILLIC)
    expectUkrainianOnly()
  })

  it('the menu shows the Profile link in Ukrainian when accounts are visible', () => {
    vi.mocked(useAccountsVisible).mockReturnValue(true)
    setVaultPhase('unlocked')
    renderUk(<Header />)

    fireEvent.click(screen.getByTestId('header-menu-btn'))

    expect(screen.getByTestId('nav-link-profile').textContent).toMatch(CYRILLIC)
    expectUkrainianOnly()
  })
})

describe('byte sizes in Ukrainian', () => {
  it('uses Ukrainian units and the decimal comma', () => {
    setLang('uk', { persist: false })

    expect(formatBytes(512)).toBe('512 Б')
    expect(formatBytes(1536)).toBe('1,5 КБ')
    expect(formatBytes(1048576)).toBe('1,0 МБ')
    expect(formatBytes(1536)).not.toBe(formatBytes(1048576))
  })

  it('keeps the English units and the decimal point in English', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1048576)).toBe('1.0 MB')
    expect(formatAmount(1.5, 'en')).toBe('1.50')
  })
})
