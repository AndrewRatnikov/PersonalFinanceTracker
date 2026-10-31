// CONTRACT_GAP: the dashboard's amount cards are compared between spaces by
//   their text changing and coming back (the money format is existing code).
// CONTRACT_GAP: family-empty-invite / family-empty-move navigate through
//   useNavigate from @tanstack/react-router (plan section 5); the mock asserts
//   the target path only (/settings, /transactions).
// CONTRACT_GAP: the Quick Add form is driven through speed-entry-amount and
//   speed-entry-form; its description testid is not in the contract.
//
// Dashboard in a Family: cues, month-by-member card, empty state, Paid by in
// Quick Add, read-only and paused, and the data following the switch.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType, ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'

import type { Expense } from '@/lib/domain'
import type { ActiveSpaceState } from '@/lib/spaces/switcher'
import { setLang, translate } from '@/i18n/core'
import { buildMemberDirectory } from '@/lib/memberStats'
import { SpaceSwitchProvider } from '@/lib/spaces/switcher'
import {
  addExpense,
  getAllBudgets,
  getAllCategories,
  getAllIncome,
  getAllIncomeCategories,
  getAllRecurring,
  getExpensesForRange,
} from '@/lib/localDb'
import { cancelCreateVault, setVaultPhase } from '@/lib/vaultSession'
import SpeedEntryForm from '@/components/index/SpeedEntryForm'
import { Route } from '@/routes/index'

const h = vi.hoisted(() => ({
  personal: [] as Array<unknown>,
  family: [] as Array<unknown>,
  familyIncome: [] as Array<unknown>,
}))
const fam = vi.hoisted(() => ({
  getAllCategories: vi.fn(),
  getExpensesForRange: vi.fn(),
  getAllIncome: vi.fn(),
  getAllBudgets: vi.fn(),
  addExpense: vi.fn(),
  deleteExpense: vi.fn(),
  updateExpense: vi.fn(),
  getAllRecurring: vi.fn(),
  getAllIncomeCategories: vi.fn(),
  addRepeatingExpense: vi.fn(),
  confirmRecurringOccurrence: vi.fn(),
  skipRecurringOccurrence: vi.fn(),
}))
const navigate = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactRouter>()
  return {
    ...actual,
    useNavigate: () => navigate,
    Link: ({ to, children, ...rest }: { to: string; children?: ReactNode; [key: string]: unknown }) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  }
})
vi.mock('@/lib/localDb', () => ({
  getAllCategories: vi.fn(),
  getExpensesForRange: vi.fn(),
  getAllIncome: vi.fn(),
  getAllBudgets: vi.fn(),
  addExpense: vi.fn(),
  deleteExpense: vi.fn(),
  updateExpense: vi.fn(),
  getAllRecurring: vi.fn(),
  getAllIncomeCategories: vi.fn(),
  addRepeatingExpense: vi.fn(),
  confirmRecurringOccurrence: vi.fn(),
  skipRecurringOccurrence: vi.fn(),
  spaceDb: vi.fn(() => fam),
}))
vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))
vi.mock('@/lib/backup', () => ({ formatRestoreSummary: vi.fn() }))
vi.mock('@/components/InstallHintCard', () => ({ InstallHintCard: () => null }))
vi.mock('@/components/index/BackupReminderBanner', () => ({ BackupReminderBanner: () => null }))
vi.mock('@/components/index/RecoveryKeyBanner', () => ({ RecoveryKeyBanner: () => null }))
vi.mock('@/components/RestoreBackupDialog', () => ({ RestoreBackupDialog: () => null }))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

const FAMILY = { id: 'fam-1', name: 'Our home', role: 'owner' as const, readOnly: false }
const DIR = buildMemberDirectory(
  [
    { id: 'u-me', displayName: 'Andrii', color: 'var(--chart-1)' },
    { id: 'u-olena', displayName: 'Olena', color: 'var(--chart-2)' },
    { id: 'u-taras', displayName: 'Taras', color: 'var(--chart-3)' },
    { id: 'u-ivan', displayName: 'Ivan', color: 'var(--chart-4)' },
  ],
  ['u-me', 'u-olena', 'u-taras', 'u-ivan'],
  'u-me',
)
const FOOD = { id: 'c1', name: 'Food', icon: '🍔' }
const switchTo = vi.fn()

function exp(id: string, amount: number, paidBy?: string): Expense {
  return {
    id,
    amount,
    currency: 'UAH',
    categoryId: 'c1',
    category: FOOD,
    createdAt: new Date().toISOString(),
    ...(paidBy === undefined ? {} : { paidBy }),
  }
}

function familyValue(extra: Partial<ActiveSpaceState> = {}): Partial<ActiveSpaceState> {
  return { spaceId: 'fam-1', family: FAMILY, directory: DIR, memberId: 'u-me', switchTo, ...extra }
}

function tree(value: Partial<ActiveSpaceState>, client: QueryClient) {
  const Page = Route.options.component as ComponentType | undefined
  if (!Page) throw new Error('no component')
  return (
    <QueryClientProvider client={client}>
      <SpaceSwitchProvider value={{ switchTo, ...value }}>
        <Page />
      </SpaceSwitchProvider>
    </QueryClientProvider>
  )
}

function renderPage(value: Partial<ActiveSpaceState>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(tree(value, client))
  return { ...view, rerenderWith: (next: Partial<ActiveSpaceState>) => view.rerender(tree(next, client)) }
}

beforeEach(() => {
  vi.clearAllMocks()
  setLang('en', { persist: false })
  cancelCreateVault()
  setVaultPhase('unlocked')
  h.personal = [exp('p1', 40)]
  h.family = [exp('f1', 12400, 'u-me'), exp('f2', 9800, 'u-olena'), exp('f3', 500, 'u-taras'), exp('f4', 300, 'u-ivan')]
  h.familyIncome = []

  vi.mocked(getAllCategories).mockResolvedValue([FOOD])
  vi.mocked(getExpensesForRange).mockImplementation(() => Promise.resolve([...(h.personal as Array<Expense>)]))
  vi.mocked(getAllIncome).mockResolvedValue([])
  vi.mocked(getAllBudgets).mockResolvedValue([])
  vi.mocked(getAllRecurring).mockResolvedValue([])
  vi.mocked(getAllIncomeCategories).mockResolvedValue([])
  vi.mocked(addExpense).mockResolvedValue(exp('new', 1))

  fam.getAllCategories.mockResolvedValue([FOOD])
  fam.getExpensesForRange.mockImplementation(() => Promise.resolve([...h.family]))
  fam.getAllIncome.mockImplementation(() => Promise.resolve([...h.familyIncome]))
  fam.getAllBudgets.mockResolvedValue([])
  fam.getAllRecurring.mockResolvedValue([])
  fam.getAllIncomeCategories.mockResolvedValue([])
  fam.addExpense.mockResolvedValue(exp('new', 1, 'u-me'))
})

afterEach(() => {
  cleanup()
  act(() => {
    setVaultPhase('checking')
  })
  setLang('en', { persist: false })
})

describe('Family dashboard cues', () => {
  it('shows the title cue, "Adding to <name>" in Quick Add and the month card', async () => {
    renderPage(familyValue())

    await screen.findByTestId('dashboard-summary')
    expect(screen.getByTestId('space-title-cue').textContent).toContain('Our home')
    expect(screen.getByTestId('quick-add-space-cue').textContent).toBe(
      translate('en', 'space.adding', { name: 'Our home' }),
    )
    await screen.findByTestId('family-month-card')
  })

  it('the month card shows the top 3 members and +N for the rest', async () => {
    renderPage(familyValue())

    await screen.findByTestId('family-month-card')
    expect(screen.getByTestId('family-month-member-u-me').textContent).toContain('Andrii')
    expect(screen.getByTestId('family-month-member-u-olena').textContent).toContain('Olena')
    expect(screen.getByTestId('family-month-member-u-taras').textContent).toContain('Taras')
    expect(screen.queryByTestId('family-month-member-u-ivan')).toBeNull()
    expect(screen.getByTestId('family-month-more').textContent).toBe(translate('en', 'members.more', { count: 1 }))
  })

  it('shows none of this in Personal, even with a Family held', async () => {
    renderPage({ spaceId: 'personal', family: FAMILY })

    await screen.findByTestId('dashboard-summary')
    for (const id of ['space-title-cue', 'quick-add-space-cue', 'family-month-card', 'family-empty-state']) {
      expect(screen.queryByTestId(id), id).toBeNull()
    }
  })
})

describe('the data follows the active space', () => {
  it('Family numbers differ from Personal numbers and come back after switching back', async () => {
    const view = renderPage(familyValue())
    await screen.findByTestId('family-month-card')
    const familyTotal = screen.getByTestId('dashboard-month-expenses').textContent

    view.rerenderWith({ spaceId: 'personal', family: FAMILY })
    await waitFor(() => expect(screen.queryByTestId('family-month-card')).toBeNull())
    await waitFor(() => expect(screen.getByTestId('dashboard-month-expenses').textContent).not.toBe(familyTotal))
    const personalTotal = screen.getByTestId('dashboard-month-expenses').textContent

    view.rerenderWith(familyValue())
    await waitFor(() => expect(screen.getByTestId('dashboard-month-expenses').textContent).toBe(familyTotal))
    expect(personalTotal).not.toBe(familyTotal)
  })

  it('Left to spend follows the active space budgets and returns after switching back', async () => {
    const budget = (id: string, monthlyLimit: number) => ({
      id,
      categoryId: 'c1',
      monthlyLimit,
      currency: 'UAH',
    })
    fam.getAllBudgets.mockResolvedValue([budget('bf', 50000)])
    vi.mocked(getAllBudgets).mockResolvedValue([budget('bp', 1000)] as never)
    const view = renderPage(familyValue())
    await screen.findByTestId('family-month-card')
    const familyLeft = (await screen.findByTestId('dashboard-left-to-spend')).textContent

    view.rerenderWith({ spaceId: 'personal', family: FAMILY })
    await waitFor(() => expect(screen.queryByTestId('family-month-card')).toBeNull())
    await waitFor(() => expect(screen.getByTestId('dashboard-left-to-spend').textContent).not.toBe(familyLeft))
    const personalLeft = screen.getByTestId('dashboard-left-to-spend').textContent

    view.rerenderWith(familyValue())
    await waitFor(() => expect(screen.getByTestId('dashboard-left-to-spend').textContent).toBe(familyLeft))
    expect(personalLeft).not.toBe(familyLeft)
  })

  it('an expense added in Quick Add while in the Family is stored in the Family only, with Paid by', async () => {
    renderPage(familyValue())
    await screen.findByTestId('family-month-card')

    const form = screen.getByTestId('speed-entry-form')
    const paidBy = within(form).getByTestId<HTMLSelectElement>('paid-by-select')
    expect(paidBy.value).toBe('u-me')
    fireEvent.change(within(form).getByTestId('speed-entry-amount'), { target: { value: '42' } })
    fireEvent.change(paidBy, { target: { value: 'u-olena' } })
    fireEvent.submit(form)

    await waitFor(() => expect(fam.addExpense).toHaveBeenCalledTimes(1))
    expect(fam.addExpense.mock.calls[0][0]).toMatchObject({ amount: 42, paidBy: 'u-olena' })
    expect(addExpense).not.toHaveBeenCalled()
  })

  it('an expense added in Personal goes to Personal with no paidBy key', async () => {
    renderPage({ spaceId: 'personal', family: FAMILY })
    await screen.findByTestId('dashboard-summary')

    const form = screen.getByTestId('speed-entry-form')
    expect(within(form).queryByTestId('paid-by-select')).toBeNull()
    fireEvent.change(within(form).getByTestId('speed-entry-amount'), { target: { value: '42' } })
    fireEvent.submit(form)

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect('paidBy' in vi.mocked(addExpense).mock.calls[0][0]).toBe(false)
    expect(fam.addExpense).not.toHaveBeenCalled()
  })
})

describe('empty Family', () => {
  beforeEach(() => {
    h.family = []
    h.familyIncome = []
  })

  it('offers Invite (owner), Move entries from Personal and Add the first expense', async () => {
    renderPage(familyValue())

    await screen.findByTestId('family-empty-state')
    expect(screen.getByTestId('family-empty-invite').textContent).toContain(translate('en', 'space.emptyInvite'))
    expect(screen.getByTestId('family-empty-move').textContent).toContain(translate('en', 'space.emptyMove'))
    expect(screen.getByTestId('family-empty-add').textContent).toContain(translate('en', 'space.emptyAdd'))
    expect(screen.queryByTestId('family-month-card')).toBeNull()
  })

  it('hides Invite for a member who is not the owner', async () => {
    renderPage(familyValue({ family: { ...FAMILY, role: 'member' } }))

    await screen.findByTestId('family-empty-state')
    expect(screen.queryByTestId('family-empty-invite')).toBeNull()
    expect(screen.getByTestId('family-empty-move')).toBeTruthy()
  })

  it('Invite goes to Settings → Family', async () => {
    renderPage(familyValue())
    await screen.findByTestId('family-empty-state')

    fireEvent.click(screen.getByTestId('family-empty-invite'))

    expect(JSON.stringify(navigate.mock.calls[0][0])).toContain('/settings')
    expect(JSON.stringify(navigate.mock.calls[0][0])).toContain('family')
  })

  it('Move entries switches to Personal and goes to the transactions page', async () => {
    renderPage(familyValue())
    await screen.findByTestId('family-empty-state')

    fireEvent.click(screen.getByTestId('family-empty-move'))

    expect(switchTo).toHaveBeenCalledWith('personal')
    expect(JSON.stringify(navigate.mock.calls.at(-1)?.[0])).toContain('/transactions')
  })

  it('Add the first expense opens the drawer in the Family', async () => {
    renderPage(familyValue())
    await screen.findByTestId('family-empty-state')

    fireEvent.click(screen.getByTestId('family-empty-add'))

    const drawer = await screen.findByTestId('expense-drawer')
    expect(within(drawer).getByTestId('drawer-space-cue').textContent).toBe(
      translate('en', 'space.adding', { name: 'Our home' }),
    )
  })

  it('is not shown when Personal is empty or when the Family has entries', async () => {
    h.personal = []
    const view = renderPage({ spaceId: 'personal', family: FAMILY })
    await screen.findByTestId('dashboard-summary')
    expect(screen.queryByTestId('family-empty-state')).toBeNull()
    view.unmount()

    h.family = [exp('f1', 10, 'u-me')]
    renderPage(familyValue())
    await screen.findByTestId('family-month-card')
    expect(screen.queryByTestId('family-empty-state')).toBeNull()
  })
})

describe('read-only and paused', () => {
  it('read-only: banner with link, Quick Add disabled', async () => {
    renderPage(familyValue({ readOnly: true }))

    await screen.findByTestId('space-readonly-banner')
    expect(screen.getByTestId('space-readonly-settings-link')).toBeTruthy()
    expect(screen.getByTestId<HTMLButtonElement>('speed-entry-submit').disabled).toBe(true)
  })

  it('paused: small banner and editing still works', async () => {
    renderPage(familyValue({ paused: true }))

    await screen.findByTestId('space-paused-banner')
    expect(screen.getByTestId<HTMLButtonElement>('speed-entry-submit').disabled).toBe(false)
  })
})

describe('SpeedEntryForm', () => {
  const categories = [{ id: 'c1', name: 'Food' }]

  function renderForm(value: Partial<ActiveSpaceState>, onSubmit = vi.fn().mockResolvedValue(undefined)) {
    render(
      <SpaceSwitchProvider value={{ switchTo, ...value }}>
        <SpeedEntryForm categories={categories} onSubmit={onSubmit} />
      </SpaceSwitchProvider>,
    )
    return onSubmit
  }

  it('passes paidBy (default me, or the chosen member) to onSubmit in a Family', async () => {
    const onSubmit = renderForm(familyValue())
    fireEvent.change(screen.getByTestId('speed-entry-amount'), { target: { value: '5' } })

    fireEvent.submit(screen.getByTestId('speed-entry-form'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].paidBy).toBe('u-me')

    fireEvent.change(screen.getByTestId('speed-entry-amount'), { target: { value: '6' } })
    fireEvent.change(screen.getByTestId('paid-by-select'), { target: { value: 'u-taras' } })
    fireEvent.submit(screen.getByTestId('speed-entry-form'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(onSubmit.mock.calls[1][0].paidBy).toBe('u-taras')
  })

  it('without a Family there is no select and no paidBy key', async () => {
    const onSubmit = renderForm({ spaceId: 'personal', family: null })
    expect(screen.queryByTestId('paid-by-select')).toBeNull()
    fireEvent.change(screen.getByTestId('speed-entry-amount'), { target: { value: '5' } })

    fireEvent.submit(screen.getByTestId('speed-entry-form'))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect('paidBy' in onSubmit.mock.calls[0][0]).toBe(false)
  })

  it('has a submit button that read-only disables', () => {
    renderForm(familyValue({ readOnly: true }))

    expect(screen.getByTestId<HTMLButtonElement>('speed-entry-submit').disabled).toBe(true)
  })
})
