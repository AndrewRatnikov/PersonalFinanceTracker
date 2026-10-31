// CONTRACT_GAP: the Save button and limit input of a budget row have no testid
//   (as in BudgetTab.test.tsx); they are found by the "Limit" placeholder and
//   the "Save" button name.
// CONTRACT_GAP: how the main currency update of a Family is passed to
//   updateCurrencySettings is not fixed; only the read side
//   (getCurrencySettings called with { spaceId }) is asserted.
// CONTRACT_GAP: GeneralTab's language and auto-lock being global is asserted by
//   the language card (settings-language) staying outside and above the space
//   header, and by auto-lock-select living in SecurityTab (rendered without any
//   space change).
//
// Settings in a Family: "Settings for <space>" headers, Open the app in,
// Copy categories from Personal, the by-member budget breakdown, per-space
// currency, CSV export/import in the active space, and read-only controls.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'
import type * as AppSettings from '@/lib/appSettings'

import type { BudgetEntry, Category, Expense } from '@/lib/domain'
import type { ActiveSpaceState } from '@/lib/spaces/switcher'
import { formatMoney } from '@/i18n/format'
import { plural, setLang, translate } from '@/i18n/core'
import {
  OPEN_APP_IN_QUERY_KEY,
  getCurrencySettings,
  getOpenAppIn,
  setOpenAppIn,
} from '@/lib/appSettings'
import { getConversionStatus } from '@/lib/conversion'
import { exportAllLocalData } from '@/lib/localExport'
import { buildMemberDirectory } from '@/lib/memberStats'
import { copyCategoriesFromSpace } from '@/lib/localDb'
import { SpaceSwitchProvider } from '@/lib/spaces/switcher'
import { BudgetTab } from '@/components/settings/BudgetTab'
import { CategoriesTab } from '@/components/settings/CategoriesTab'
import { DataToolsTab } from '@/components/settings/DataToolsTab'
import { GeneralTab } from '@/components/settings/GeneralTab'

const fam = vi.hoisted(() => ({
  getAllCategories: vi.fn(),
  getAllIncomeCategories: vi.fn(),
  addCategory: vi.fn(),
  addIncomeCategory: vi.fn(),
  updateCategory: vi.fn(),
  updateIncomeCategory: vi.fn(),
  deleteCategory: vi.fn(),
  deleteIncomeCategory: vi.fn(),
  getAllBudgets: vi.fn(),
  upsertBudget: vi.fn(),
  deleteBudget: vi.fn(),
  getExpensesForRange: vi.fn(),
}))

vi.mock('@/lib/localDb', () => ({
  getAllCategories: vi.fn(),
  getAllIncomeCategories: vi.fn(),
  addCategory: vi.fn(),
  addIncomeCategory: vi.fn(),
  updateCategory: vi.fn(),
  updateIncomeCategory: vi.fn(),
  deleteCategory: vi.fn(),
  deleteIncomeCategory: vi.fn(),
  getAllBudgets: vi.fn(),
  upsertBudget: vi.fn(),
  deleteBudget: vi.fn(),
  getExpensesForRange: vi.fn(),
  copyCategoriesFromSpace: vi.fn(),
  spaceDb: vi.fn(() => fam),
}))
vi.mock('@/lib/appSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof AppSettings>()),
  getCurrencySettings: vi.fn(),
  updateCurrencySettings: vi.fn(),
  getOpenAppIn: vi.fn(),
  setOpenAppIn: vi.fn(),
}))
vi.mock('@/lib/conversion', () => ({
  CONVERSION_STATUS_QUERY_KEY: ['conversion-status'],
  MainCurrencyChangeError: class extends Error {},
  getConversionStatus: vi.fn(),
  changeMainCurrency: vi.fn(),
  requestConversion: vi.fn(),
}))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode; [key: string]: unknown }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}))
vi.mock('@/lib/backup', () => ({ downloadBackup: vi.fn() }))
vi.mock('@/lib/backupReminder', () => ({
  BACKUP_REMINDER_QUERY_KEY: ['backup-reminder'],
  BACKUP_SETTINGS_QUERY_KEY: ['backup-settings'],
  BACKUP_REMINDER_OPTIONS: [7, 14, 30, 0],
  DEFAULT_BACKUP_REMINDER_DAYS: 14,
  getBackupSettings: vi.fn(() =>
    Promise.resolve({ backupReminderDays: 14, lastBackupAt: null, lastDataChangeAt: null, backupReminderSnoozedUntil: null }),
  ),
  updateBackupSettings: vi.fn(),
}))
vi.mock('@/lib/localExport', () => ({ exportAllLocalData: vi.fn() }))
vi.mock('@/lib/localImport', () => ({ importLocalDataFile: vi.fn() }))
vi.mock('@/components/settings/StorageStatusCard', () => ({ StorageStatusCard: () => null }))
vi.mock('@/components/RemoveDataDialog', () => ({ RemoveDataDialog: () => null }))
vi.mock('@/components/RestoreBackupDialog', () => ({ RestoreBackupDialog: () => null }))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

const FAMILY = { id: 'fam-1', name: 'Our home', role: 'owner' as const, readOnly: false }
const DIR = buildMemberDirectory(
  [
    { id: 'u-me', displayName: 'Andrii', color: 'var(--chart-1)' },
    { id: 'u-olena', displayName: 'Olena', color: 'var(--chart-2)' },
  ],
  ['u-me', 'u-olena'],
  'u-me',
)
const FOOD: Category = { id: 'cat-food', name: 'Food', icon: '🍔' }
const HOME: Category = { id: 'cat-home', name: 'Home', icon: '🏠' }
const switchTo = vi.fn()

function familyValue(extra: Partial<ActiveSpaceState> = {}): Partial<ActiveSpaceState> {
  return { spaceId: 'fam-1', family: FAMILY, directory: DIR, memberId: 'u-me', switchTo, ...extra }
}

function renderTab(ui: ReactNode, value: Partial<ActiveSpaceState>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const view = render(
    <QueryClientProvider client={client}>
      <SpaceSwitchProvider value={{ switchTo, ...value }}>{ui}</SpaceSwitchProvider>
    </QueryClientProvider>,
  )
  return { ...view, client, invalidate }
}

function exp(id: string, amount: number, categoryId: string, paidBy?: string): Expense {
  return {
    id,
    amount,
    currency: 'UAH',
    categoryId,
    createdAt: new Date().toISOString(),
    ...(paidBy === undefined ? {} : { paidBy }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  setLang('en', { persist: false })
  vi.mocked(getCurrencySettings).mockResolvedValue({ mainCurrency: 'UAH', fetchExchangeRates: true })
  vi.mocked(getOpenAppIn).mockResolvedValue('last')
  vi.mocked(setOpenAppIn).mockResolvedValue(undefined)
  vi.mocked(getConversionStatus).mockResolvedValue({
    mainCurrency: 'UAH',
    fetchExchangeRates: true,
    totalEntries: 0,
    pendingEntries: 0,
    pendingBudgets: 0,
  })
  fam.getAllCategories.mockResolvedValue([FOOD])
  fam.getAllIncomeCategories.mockResolvedValue([])
  fam.getAllBudgets.mockResolvedValue([
    { id: 'b1', categoryId: 'cat-food', monthlyLimit: 500, currency: 'UAH', categoryName: 'Food', categoryIcon: '🍔' } as BudgetEntry & {
      categoryName: string
      categoryIcon: string | null
    },
  ])
  fam.getExpensesForRange.mockResolvedValue([
    exp('e1', 100, 'cat-food', 'u-me'),
    exp('e2', 250.5, 'cat-food', 'u-olena'),
    exp('e3', 30, 'cat-home', 'u-me'),
    exp('e4', 7, 'cat-food'),
  ])
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('Settings for <space> header', () => {
  it('names the Family while it is active', async () => {
    renderTab(<CategoriesTab />, familyValue())

    await screen.findByTestId('categories-tab')
    expect(screen.getByTestId('space-settings-header').textContent).toBe(
      translate('en', 'space.settingsFor', { name: 'Our home' }),
    )
  })

  it('names Personal when a Family is held but Personal is active', async () => {
    renderTab(<CategoriesTab />, { spaceId: 'personal', family: FAMILY })

    await screen.findByTestId('categories-tab')
    expect(screen.getByTestId('space-settings-header').textContent).toBe(
      translate('en', 'space.settingsFor', { name: translate('en', 'space.personal') }),
    )
  })

  it('is absent without a Family', async () => {
    renderTab(<CategoriesTab />, { spaceId: 'personal', family: null })

    await screen.findByTestId('categories-tab')
    expect(screen.queryByTestId('space-settings-header')).toBeNull()
  })

  it('sits above the main currency in General, below the global language card', async () => {
    renderTab(<GeneralTab />, familyValue())

    await screen.findByTestId('settings-main-currency')
    const header = screen.getByTestId('space-settings-header')
    const currency = screen.getByTestId('settings-main-currency')
    const language = screen.getByTestId('settings-language')
    expect(header.compareDocumentPosition(currency) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(language.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('the Budget tab has it too', async () => {
    renderTab(<BudgetTab categories={[FOOD, HOME]} />, familyValue())

    await screen.findByTestId('budget-tab')
    expect(screen.getByTestId('space-settings-header').textContent).toContain('Our home')
  })
})

describe('General: per-space currency and Open the app in', () => {
  it('reads the currency settings of the active space only', async () => {
    renderTab(<GeneralTab />, familyValue())
    await waitFor(() => expect(getCurrencySettings).toHaveBeenCalled())
    expect(vi.mocked(getCurrencySettings).mock.calls[0]).toEqual([{ spaceId: 'fam-1' }])
    cleanup()
    vi.mocked(getCurrencySettings).mockClear()

    renderTab(<GeneralTab />, { spaceId: 'personal', family: FAMILY })
    await waitFor(() => expect(getCurrencySettings).toHaveBeenCalled())
    expect(vi.mocked(getCurrencySettings).mock.calls[0]).toEqual([])
  })

  it('the select lists Last used, Personal and the Family name, and shows the stored value', async () => {
    vi.mocked(getOpenAppIn).mockResolvedValue('family')
    renderTab(<GeneralTab />, familyValue())

    const select = await screen.findByTestId<HTMLSelectElement>('settings-open-app-in')
    await waitFor(() => expect(select.value).toBe('family'))
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ['last', translate('en', 'space.openAppInLast')],
      ['personal', translate('en', 'space.personal')],
      ['family', 'Our home'],
    ])
    expect(screen.getByLabelText(translate('en', 'space.openAppIn'))).toBe(select)
  })

  it('choosing a value stores it and refreshes the query', async () => {
    const { invalidate } = renderTab(<GeneralTab />, familyValue())
    const select = await screen.findByTestId('settings-open-app-in')

    fireEvent.change(select, { target: { value: 'personal' } })

    await waitFor(() => expect(setOpenAppIn).toHaveBeenCalledWith('personal'))
    await waitFor(() =>
      expect(invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))).toContain(
        JSON.stringify([...OPEN_APP_IN_QUERY_KEY]),
      ),
    )
  })

  it('is hidden without a Family and from Personal-only devices', async () => {
    renderTab(<GeneralTab />, { spaceId: 'personal', family: null })

    await screen.findByTestId('settings-main-currency')
    expect(screen.queryByTestId('settings-open-app-in')).toBeNull()
    expect(getOpenAppIn).not.toHaveBeenCalled()
  })

  it('read-only disables the main currency and the rates switch, but not the global select', async () => {
    renderTab(<GeneralTab />, familyValue({ readOnly: true }))

    const currency = await screen.findByTestId<HTMLSelectElement>('settings-main-currency')
    expect(currency.disabled).toBe(true)
    expect(screen.getByTestId<HTMLInputElement>('settings-fetch-rates').disabled).toBe(true)
    expect(screen.getByTestId<HTMLSelectElement>('settings-open-app-in').disabled).toBe(false)
  })

  it('a healthy Family leaves the currency controls enabled', async () => {
    renderTab(<GeneralTab />, familyValue())

    const currency = await screen.findByTestId<HTMLSelectElement>('settings-main-currency')
    await waitFor(() => expect(currency.disabled).toBe(false))
  })
})

describe('Categories: Copy categories from Personal', () => {
  it('is offered in the Family and copies from Personal into it', async () => {
    vi.mocked(copyCategoriesFromSpace).mockResolvedValue({ categories: 2, incomeCategories: 1 })
    const { invalidate } = renderTab(<CategoriesTab />, familyValue())
    const button = await screen.findByTestId('categories-copy-from-personal')
    expect(button.textContent).toContain(translate('en', 'move.copyCategories'))

    fireEvent.click(button)

    await waitFor(() => expect(copyCategoriesFromSpace).toHaveBeenCalledWith({ from: 'personal', to: 'fam-1' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(plural('move.copyCategoriesDone', 3)))
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))
    expect(keys).toContain(JSON.stringify(['categories']))
    expect(keys).toContain(JSON.stringify(['incomeCategories']))
  })

  it('tells when nothing was missing', async () => {
    vi.mocked(copyCategoriesFromSpace).mockResolvedValue({ categories: 0, incomeCategories: 0 })
    renderTab(<CategoriesTab />, familyValue())

    fireEvent.click(await screen.findByTestId('categories-copy-from-personal'))

    await waitFor(() => expect(toast).toHaveBeenCalledWith(translate('en', 'move.copyCategoriesNone')))
  })

  it('is not offered in Personal or without a Family', async () => {
    renderTab(<CategoriesTab />, { spaceId: 'personal', family: FAMILY })
    await screen.findByTestId('categories-tab')
    expect(screen.queryByTestId('categories-copy-from-personal')).toBeNull()
    cleanup()

    renderTab(<CategoriesTab />, { spaceId: 'personal', family: null })
    await screen.findByTestId('categories-tab')
    expect(screen.queryByTestId('categories-copy-from-personal')).toBeNull()
  })

  it('read-only disables the copy button, the add buttons and the row actions', async () => {
    fam.getAllIncomeCategories.mockResolvedValue([{ id: 'ic1', name: 'Salary', icon: '💼' }])
    renderTab(<CategoriesTab />, familyValue({ readOnly: true }))

    expect((await screen.findByTestId<HTMLButtonElement>('categories-copy-from-personal')).disabled).toBe(true)
    expect(screen.getByTestId<HTMLButtonElement>('category-add-btn').disabled).toBe(true)
    expect(screen.getByTestId<HTMLButtonElement>('income-category-add-btn').disabled).toBe(true)
    await waitFor(() => expect(screen.getAllByTestId('category-row').length).toBeGreaterThan(0))
    for (const id of ['category-rename-btn', 'category-delete-btn']) {
      for (const el of screen.getAllByTestId<HTMLButtonElement>(id)) expect(el.disabled, id).toBe(true)
    }
  })

  it('a healthy Family keeps the add buttons enabled and the old id on the expense add button', async () => {
    renderTab(<CategoriesTab />, familyValue())

    const add = await screen.findByTestId<HTMLButtonElement>('category-add-btn')
    expect(add.disabled).toBe(false)
    expect(add.id).toBe('add-category-btn')
  })
})

describe('Budget: shared limits and the by-member breakdown (hand-computed)', () => {
  it('lists what each payer spent this month in that category only', async () => {
    renderTab(<BudgetTab categories={[FOOD, HOME]} />, familyValue())

    const food = await screen.findByTestId('budget-row-members-cat-food')
    expect(food.tagName).toBe('DETAILS')
    expect(within(food).getByText(translate('en', 'members.byMember'))).toBeTruthy()
    expect(screen.getByTestId('budget-member-cat-food-u-me').textContent).toBe(`Andrii ${formatMoney(100, 'UAH')}`)
    expect(screen.getByTestId('budget-member-cat-food-u-olena').textContent).toBe(`Olena ${formatMoney(250.5, 'UAH')}`)
    expect(screen.getByTestId('budget-member-cat-food-unknown').textContent).toContain(formatMoney(7, 'UAH'))
    expect(screen.getByTestId('budget-member-cat-home-u-me').textContent).toBe(`Andrii ${formatMoney(30, 'UAH')}`)
    expect(screen.queryByTestId('budget-member-cat-home-u-olena')).toBeNull()
  })

  it('shows the single shared limit of the Family', async () => {
    renderTab(<BudgetTab categories={[FOOD, HOME]} />, familyValue())

    await screen.findByTestId('budget-row-members-cat-food')
    expect(screen.getAllByPlaceholderText<HTMLInputElement>('Limit')[0].value).toBe('500')
  })

  it('has no breakdown in Personal or without a Family', async () => {
    renderTab(<BudgetTab categories={[FOOD, HOME]} />, { spaceId: 'personal', family: FAMILY })
    await screen.findByTestId('budget-tab')
    expect(screen.queryByTestId('budget-row-members-cat-food')).toBeNull()
    expect(fam.getExpensesForRange).not.toHaveBeenCalled()
  })

  it('read-only disables the limit input and Save', async () => {
    renderTab(<BudgetTab categories={[FOOD, HOME]} />, familyValue({ readOnly: true }))

    await screen.findByTestId('budget-row-members-cat-food')
    for (const input of screen.getAllByPlaceholderText<HTMLInputElement>('Limit')) expect(input.disabled).toBe(true)
    for (const button of screen.getAllByRole<HTMLButtonElement>('button', { name: 'Save' })) expect(button.disabled).toBe(true)
  })
})

describe('CSV in the active space', () => {
  async function exportFrom(value: Partial<ActiveSpaceState>) {
    vi.mocked(exportAllLocalData).mockResolvedValue(undefined as never)
    renderTab(<DataToolsTab />, value)
    fireEvent.click(await screen.findByTestId('csv-export-btn'))
    await waitFor(() => expect(exportAllLocalData).toHaveBeenCalledTimes(1))
    return vi.mocked(exportAllLocalData).mock.calls[0]
  }

  it('exports the Family only while it is active', async () => {
    expect(await exportFrom(familyValue())).toEqual([{ spaceId: 'fam-1' }])
  })

  it('exports Personal with today’s arguments', async () => {
    expect(await exportFrom({ spaceId: 'personal', family: FAMILY })).toEqual([])
  })

  it('read-only disables the import input but not the export', async () => {
    renderTab(<DataToolsTab />, familyValue({ readOnly: true }))

    expect((await screen.findByTestId<HTMLInputElement>('csv-import-input')).disabled).toBe(true)
    expect(screen.getByTestId<HTMLButtonElement>('csv-export-btn').disabled).toBe(false)
  })

  it('a healthy Family allows the import', async () => {
    renderTab(<DataToolsTab />, familyValue())

    expect((await screen.findByTestId<HTMLInputElement>('csv-import-input')).disabled).toBe(false)
  })
})
