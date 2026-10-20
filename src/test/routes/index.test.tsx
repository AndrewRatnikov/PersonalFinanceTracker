// No CONTRACT_GAPs: the index route's phase-driven rendering is fully
// specified in the Interface Contract (route: index). InstallHintCard is
// replaced by a fake (fake-install-hint), BackupReminderBanner by a fake
// (fake-backup-reminder), RecoveryKeyBanner by a fake (fake-recovery-key-banner)
// and Link by a plain anchor.
//
// Recurring additions: the localDb mock gains getAllRecurring,
// getAllIncomeCategories, addRepeatingExpense, confirmRecurringOccurrence and
// skipRecurringOccurrence (the dashboard now renders RecurringDashboardSection
// and a repeat-aware Quick Add). Dates for the section tests are built from the
// real clock (today, +2 days) so they hold on any day.
//
// Fast-entry additions: the localDb mock gains deleteExpense and updateExpense
// (the dashboard now renders the repeat-last row and the ExpenseDrawer).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import dayjs from 'dayjs'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'

import type { Expense, RecurringItem } from '@/lib/domain'
import {
  addExpense,
  addRepeatingExpense,
  getAllBudgets,
  getAllCategories,
  getAllIncome,
  getAllIncomeCategories,
  getAllRecurring,
  getExpensesForRange,
} from '@/lib/localDb'
import { cancelCreateVault, setVaultPhase } from '@/lib/vaultSession'
import { Route } from '@/routes/index'

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
vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))
vi.mock('@/lib/backup', () => ({ formatRestoreSummary: vi.fn() }))
vi.mock('@/components/InstallHintCard', () => ({
  InstallHintCard: () => <div data-testid="fake-install-hint" />,
}))
vi.mock('@/components/index/BackupReminderBanner', () => ({
  BackupReminderBanner: () => <div data-testid="fake-backup-reminder" />,
}))
vi.mock('@/components/index/RecoveryKeyBanner', () => ({
  RecoveryKeyBanner: () => <div data-testid="fake-recovery-key-banner" />,
}))
vi.mock('@/components/RestoreBackupDialog', () => ({
  RestoreBackupDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="fake-restore-backup-dialog" /> : null,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const FOOD = { id: 'c1', name: 'Food', icon: '🍔' }

function recurringItem(
  overrides: Partial<RecurringItem> & { id: string },
): RecurringItem {
  return {
    kind: 'expense',
    amount: 100,
    currency: 'UAH',
    categoryId: 'c1',
    description: null,
    frequency: { unit: 'month', interval: 1 },
    startDate: dayjs().format('YYYY-MM-DD'),
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

function renderIndex() {
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

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getAllCategories).mockResolvedValue([])
  vi.mocked(getExpensesForRange).mockResolvedValue([])
  vi.mocked(getAllIncome).mockResolvedValue([])
  vi.mocked(getAllBudgets).mockResolvedValue([])
  vi.mocked(getAllRecurring).mockResolvedValue([])
  vi.mocked(getAllIncomeCategories).mockResolvedValue([])
  cancelCreateVault()
})

afterEach(() => {
  cleanup()
  act(() => {
    setVaultPhase('checking')
  })
})

describe('index route', () => {
  it('renders the dashboard, with the install hint, when unlocked', async () => {
    setVaultPhase('unlocked')
    renderIndex()

    await screen.findByTestId('dashboard-summary')
    expect(screen.getByTestId('fake-install-hint')).toBeTruthy()
    expect(screen.queryByTestId('landing-start-tracking')).toBeNull()
  })

  it.each(['none', 'locked', 'checking'] as const)(
    'renders the landing page when the phase is %s',
    (phase) => {
      setVaultPhase(phase)
      renderIndex()

      expect(screen.getByTestId('landing-start-tracking')).toBeTruthy()
      expect(screen.queryByTestId('dashboard-summary')).toBeNull()
      expect(screen.queryByTestId('fake-install-hint')).toBeNull()
      expect(screen.queryByTestId('fake-backup-reminder')).toBeNull()
      expect(screen.queryByTestId('fake-recovery-key-banner')).toBeNull()
      expect(getAllCategories).not.toHaveBeenCalled()
      expect(getAllRecurring).not.toHaveBeenCalled()
    },
  )

  it('switches from the landing page to the dashboard when the vault unlocks', async () => {
    setVaultPhase('locked')
    renderIndex()
    expect(screen.getByTestId('landing-start-tracking')).toBeTruthy()

    act(() => {
      setVaultPhase('unlocked')
    })

    await screen.findByTestId('dashboard-summary')
    expect(screen.queryByTestId('landing-start-tracking')).toBeNull()
  })

  it('renders the backup reminder banner on the unlocked dashboard', async () => {
    setVaultPhase('unlocked')
    renderIndex()

    await screen.findByTestId('dashboard-summary')
    expect(screen.getAllByTestId('fake-backup-reminder')).toHaveLength(1)
  })

  it('renders the recovery key banner once on the unlocked dashboard', async () => {
    setVaultPhase('unlocked')
    renderIndex()

    await screen.findByTestId('dashboard-summary')
    expect(screen.getAllByTestId('fake-recovery-key-banner')).toHaveLength(1)
  })

  it('puts the recovery key banner directly above the backup reminder', async () => {
    setVaultPhase('unlocked')
    renderIndex()

    await screen.findByTestId('dashboard-summary')
    const recovery = screen.getByTestId('fake-recovery-key-banner')
    const backup = screen.getByTestId('fake-backup-reminder')
    expect(
      recovery.compareDocumentPosition(backup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(recovery.nextElementSibling).toBe(backup)
  })

  it('puts the banners after the install hint and above the summary', async () => {
    setVaultPhase('unlocked')
    renderIndex()

    const summary = await screen.findByTestId('dashboard-summary')
    const hint = screen.getByTestId('fake-install-hint')
    const recovery = screen.getByTestId('fake-recovery-key-banner')
    const banner = screen.getByTestId('fake-backup-reminder')
    expect(
      hint.compareDocumentPosition(recovery) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      hint.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      banner.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

describe('index route: recurring section', () => {
  it('shows neither the Due nor the Upcoming card when there are no recurring items', async () => {
    setVaultPhase('unlocked')
    renderIndex()

    await screen.findByTestId('dashboard-summary')
    await waitFor(() => expect(getAllRecurring).toHaveBeenCalled())

    expect(screen.queryByTestId('recurring-due')).toBeNull()
    expect(screen.queryByTestId('recurring-upcoming')).toBeNull()
  })

  it('shows the Due card for a due ask-mode item, below the summary and above Quick Add', async () => {
    vi.mocked(getAllCategories).mockResolvedValue([FOOD])
    vi.mocked(getAllRecurring).mockResolvedValue([
      recurringItem({ id: 'ask', mode: 'ask', description: 'Rent' }),
    ])
    setVaultPhase('unlocked')
    renderIndex()

    const due = await screen.findByTestId('recurring-due')

    const summary = screen.getByTestId('dashboard-summary')
    const quickAdd = screen.getByTestId('speed-entry-form')
    expect(
      summary.compareDocumentPosition(due) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      due.compareDocumentPosition(quickAdd) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.getAllByTestId('recurring-due-row')).toHaveLength(1)
  })

  it('shows the Upcoming card with the occurrences of the next 7 days and no Due card for auto items', async () => {
    vi.mocked(getAllCategories).mockResolvedValue([FOOD])
    vi.mocked(getAllRecurring).mockResolvedValue([
      recurringItem({
        id: 'soon',
        description: 'Netflix',
        startDate: dayjs().add(2, 'day').format('YYYY-MM-DD'),
      }),
    ])
    setVaultPhase('unlocked')
    renderIndex()

    const upcoming = await screen.findByTestId('recurring-upcoming')

    expect(screen.getAllByTestId('recurring-upcoming-row')).toHaveLength(1)
    expect(upcoming.textContent).toContain('Netflix')
    expect(screen.queryByTestId('recurring-due')).toBeNull()
  })

  it('shows a query error when the recurring items fail to load', async () => {
    vi.mocked(getAllRecurring).mockRejectedValue(new Error('boom'))
    setVaultPhase('unlocked')
    renderIndex()

    await screen.findByTestId('query-error')
  })
})

describe('index route: repeat-aware Quick Add', () => {
  async function renderQuickAdd() {
    vi.mocked(getAllCategories).mockResolvedValue([FOOD])
    vi.mocked(addExpense).mockResolvedValue({
      id: 'e1',
      amount: 30,
      currency: 'UAH',
      categoryId: 'c1',
      createdAt: '2026-05-15T10:00:00.000Z',
    })
    vi.mocked(addRepeatingExpense).mockResolvedValue({
      id: 'e2',
      amount: 30,
      currency: 'UAH',
      categoryId: 'c1',
      createdAt: '2026-05-15T10:00:00.000Z',
      recurringId: 'r1',
    })
    setVaultPhase('unlocked')
    renderIndex()
    await screen.findByTestId('speed-entry-form')
  }

  function submitQuickAdd(amount: string, repeat?: string) {
    if (repeat) {
      fireEvent.change(screen.getByTestId('speed-entry-repeat'), {
        target: { value: repeat },
      })
    }
    fireEvent.change(screen.getByTestId('speed-entry-amount'), {
      target: { value: amount },
    })
    fireEvent.submit(screen.getByTestId('speed-entry-form'))
  }

  it('without a repeat it saves with addExpense only', async () => {
    await renderQuickAdd()

    submitQuickAdd('30')

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(vi.mocked(addExpense).mock.calls[0][0]).toMatchObject({
      amount: 30,
      categoryId: 'c1',
    })
    expect(addRepeatingExpense).not.toHaveBeenCalled()
  })

  it.each(['week', 'month', 'year'] as const)(
    'with Repeat = %s it saves with addRepeatingExpense(data, unit) only',
    async (unit) => {
      await renderQuickAdd()

      submitQuickAdd('45', unit)

      await waitFor(() => expect(addRepeatingExpense).toHaveBeenCalledTimes(1))
      expect(vi.mocked(addRepeatingExpense).mock.calls[0][0]).toMatchObject({
        amount: 45,
        categoryId: 'c1',
      })
      expect(vi.mocked(addRepeatingExpense).mock.calls[0][1]).toBe(unit)
      expect(addExpense).not.toHaveBeenCalled()
    },
  )

  it('a repeat save refreshes the recurring items', async () => {
    await renderQuickAdd()
    await waitFor(() => expect(getAllRecurring).toHaveBeenCalled())
    const callsBefore = vi.mocked(getAllRecurring).mock.calls.length

    submitQuickAdd('30', 'month')

    await waitFor(() => {
      expect(vi.mocked(getAllRecurring).mock.calls.length).toBeGreaterThan(callsBefore)
    })
  })

  it('a plain save does not refresh the recurring items', async () => {
    await renderQuickAdd()
    await waitFor(() => expect(getAllRecurring).toHaveBeenCalled())
    const callsBefore = vi.mocked(getAllRecurring).mock.calls.length

    submitQuickAdd('30')

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLInputElement>('speed-entry-amount').value,
      ).toBe('')
    })
    expect(vi.mocked(getAllRecurring).mock.calls.length).toBe(callsBefore)
  })
})

describe('index route: repeat-last row', () => {
  function recent(overrides: Partial<Expense> = {}): Expense {
    return {
      id: 'x1',
      amount: 30,
      currency: 'UAH',
      categoryId: 'c1',
      description: 'Lunch',
      createdAt: new Date().toISOString(),
      ...overrides,
    }
  }

  async function renderWith(
    expenses: Array<Expense>,
    categories: Array<typeof FOOD> = [FOOD],
  ) {
    vi.mocked(getAllCategories).mockResolvedValue(categories)
    vi.mocked(getExpensesForRange).mockResolvedValue(expenses)
    vi.mocked(addExpense).mockImplementation((input) =>
      Promise.resolve({
        ...input,
        id: 'new1',
        createdAt: '2026-10-20T08:15:00.000Z',
      }),
    )
    setVaultPhase('unlocked')
    renderIndex()
    await screen.findByTestId('dashboard-summary')
    await waitFor(() => expect(getExpensesForRange).toHaveBeenCalled())
  }

  it('shows a chip for a recent expense, above Quick Add', async () => {
    await renderWith([recent()])

    const chip = await screen.findByTestId('repeat-last-chip')
    expect(chip.textContent).toBe('🍔 Lunch · 30 UAH')
    const row = screen.getByTestId('repeat-last-row')
    const quickAdd = screen.getByTestId('speed-entry-form')
    expect(
      row.compareDocumentPosition(quickAdd) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('shows one chip per distinct recent expense, at most 3', async () => {
    await renderWith([
      recent({ id: 'a', description: 'A', amount: 1 }),
      recent({ id: 'b', description: 'B', amount: 2 }),
      recent({ id: 'c', description: 'C', amount: 3 }),
      recent({ id: 'd', description: 'D', amount: 4 }),
      recent({ id: 'e', description: 'A', amount: 1 }),
    ])

    await screen.findByTestId('repeat-last-row')
    expect(screen.getAllByTestId('repeat-last-chip')).toHaveLength(3)
  })

  it('shows no row when there are no expenses', async () => {
    await renderWith([])

    expect(screen.queryByTestId('repeat-last-row')).toBeNull()
  })

  it('shows no row when the only recent expense came from a recurring item', async () => {
    await renderWith([recent({ recurringId: 'r1' })])

    expect(screen.queryByTestId('repeat-last-row')).toBeNull()
  })

  it('shows no row when there are no categories', async () => {
    await renderWith([recent()], [])

    expect(screen.queryByTestId('repeat-last-row')).toBeNull()
  })

  it('a tap adds the expense and toasts', async () => {
    await renderWith([recent()])

    fireEvent.click(await screen.findByTestId('repeat-last-chip'))

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(vi.mocked(addExpense).mock.calls[0][0]).toEqual({
      amount: 30,
      currency: 'UAH',
      categoryId: 'c1',
      description: 'Lunch',
    })
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        'Added Lunch · 30 UAH',
        expect.anything(),
      )
    })
  })

  it('"…" opens the drawer on the dashboard, prefilled, and adds nothing', async () => {
    await renderWith([recent({ amount: 45, description: 'Dinner' })])

    fireEvent.click(await screen.findByTestId('repeat-last-more'))

    const drawer = await screen.findByTestId('expense-drawer')
    expect(drawer.getAttribute('data-mode')).toBe('add')
    expect(screen.getByTestId<HTMLInputElement>('drawer-amount').value).toBe('45')
    expect(screen.getByTestId<HTMLInputElement>('drawer-description').value).toBe(
      'Dinner',
    )
    const group = within(screen.getByTestId('drawer-category-group'))
    expect(group.getByRole('radio', { checked: true }).textContent).toContain('Food')
    expect(addExpense).not.toHaveBeenCalled()
  })

  it('the drawer is closed by Cancel and saves like the drawer on Transactions', async () => {
    await renderWith([recent()])
    expect(screen.queryByTestId('expense-drawer')).toBeNull()

    fireEvent.click(await screen.findByTestId('repeat-last-more'))
    await screen.findByTestId('expense-drawer')
    fireEvent.click(screen.getByTestId('drawer-cancel'))
    await waitFor(() => {
      expect(screen.queryByTestId('expense-drawer')).toBeNull()
    })
    expect(addExpense).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('repeat-last-more'))
    await screen.findByTestId('expense-drawer')
    fireEvent.change(screen.getByTestId('drawer-amount'), { target: { value: '31' } })
    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(vi.mocked(addExpense).mock.calls[0][0]).toMatchObject({
      amount: 31,
      categoryId: 'c1',
      description: 'Lunch',
    })
    await waitFor(() => {
      expect(screen.queryByTestId('expense-drawer')).toBeNull()
    })
  })
})
