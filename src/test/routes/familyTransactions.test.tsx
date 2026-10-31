// CONTRACT_GAP: the exact text of "Transaction not found" is read through the
//   existing catalog key toasts.transactionNotFound (existing behaviour).
// CONTRACT_GAP: the drawer is opened through the page search; the Paid by
//   select is found by paid-by-select scoped to expense-drawer.
// CONTRACT_GAP: transaction-select / transactions-select-all are clicked with
//   fireEvent.click; whether the testid sits on the input or on its wrapper is
//   not fixed, both toggle on click.
//
// Transactions page, ExpenseDrawer and TransactionsTable in a Family: chips and
// filter, Paid by and authorship, URL space handling, cross-space edit, bulk
// move with the confirm, read-only, refusal toast.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps, ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'

import type { Category, Expense } from '@/lib/domain'
import type { TransactionsSearch } from '@/lib/expenseDraft'
import type { ActiveSpaceState } from '@/lib/spaces/switcher'
import { formatFullDate } from '@/i18n/format'
import { plural, setLang, translate } from '@/i18n/core'
import { buildMemberDirectory } from '@/lib/memberStats'
import { SpaceSwitchProvider } from '@/lib/spaces/switcher'
import { addExpense, moveRecords } from '@/lib/localDb'
import { ExpenseDrawer } from '@/components/transactions/ExpenseDrawer'
import { TransactionsTable } from '@/components/transactions/TransactionsTable'
import { Route } from '@/routes/transactions'

const h = vi.hoisted(() => ({
  personal: [] as Array<unknown>,
  family: [] as Array<unknown>,
  categories: [] as Array<unknown>,
}))

const fam = vi.hoisted(() => ({
  getAllExpenses: vi.fn(),
  getAllCategories: vi.fn(),
  addExpense: vi.fn(),
  addRepeatingExpense: vi.fn(),
  updateExpense: vi.fn(),
  deleteExpense: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactRouter>()
  return {
    ...actual,
    Link: ({ to, children, ...rest }: { to: string; children?: ReactNode; [key: string]: unknown }) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  }
})
vi.mock('@/lib/localDb', () => ({
  getAllCategories: vi.fn(() => Promise.resolve([...h.categories])),
  getAllExpenses: vi.fn(() => Promise.resolve([...h.personal])),
  deleteExpense: vi.fn(),
  updateExpense: vi.fn(),
  addExpense: vi.fn(),
  addRepeatingExpense: vi.fn(),
  moveRecords: vi.fn(),
  spaceDb: vi.fn(() => fam),
}))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

const FAMILY = { id: 'fam-1', name: 'Our home', role: 'owner' as const, readOnly: false }
const PROFILES = [
  { id: 'u-me', displayName: 'Andrii', color: 'var(--chart-1)' },
  { id: 'u-olena', displayName: 'Olena', color: 'var(--chart-2)' },
  { id: 'u-left', displayName: 'Maksym', color: 'var(--chart-3)' },
]
const DIR = buildMemberDirectory(PROFILES, ['u-me', 'u-olena'], 'u-me')
const CATEGORIES: Array<Category> = [
  { id: 'cat-food', name: 'Food', icon: '🍔' },
  { id: 'cat-home', name: 'Home', icon: '🏠' },
]

const switchTo = vi.fn()
const navigate = vi.fn()
let search: TransactionsSearch = {}
const listeners = new Set<() => void>()

function useFakeSearch() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => search,
  )
}

function exp(id: string, amount: number, paidBy?: string, extra: Partial<Expense> = {}): Expense {
  return {
    id,
    amount,
    currency: 'UAH',
    categoryId: 'cat-food',
    createdAt: new Date(Date.UTC(2026, 9, 20, 12, 0, 0) - amount * 60_000).toISOString(),
    ...(paidBy === undefined ? {} : { paidBy }),
    ...extra,
  }
}

function familyValue(extra: Partial<ActiveSpaceState> = {}): Partial<ActiveSpaceState> {
  return { spaceId: 'fam-1', family: FAMILY, directory: DIR, memberId: 'u-me', switchTo, ...extra }
}

function renderPage(value: Partial<ActiveSpaceState>) {
  const Page = Route.options.component
  if (!Page) throw new Error('no component')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SpaceSwitchProvider value={{ switchTo, ...value }}>
        <Page />
      </SpaceSwitchProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  setLang('en', { persist: false })
  search = {}
  listeners.clear()
  h.categories = [...CATEGORIES]
  h.personal = [exp('p1', 10), exp('p2', 20)]
  h.family = [exp('f1', 100, 'u-me'), exp('f2', 200, 'u-olena'), exp('f3', 300, 'u-left')]
  fam.getAllExpenses.mockImplementation(() => Promise.resolve([...h.family]))
  fam.getAllCategories.mockImplementation(() => Promise.resolve([...h.categories]))
  fam.addExpense.mockResolvedValue(exp('new', 1, 'u-me'))
  fam.updateExpense.mockResolvedValue(exp('f1', 100, 'u-me'))
  vi.mocked(moveRecords).mockResolvedValue({ moved: 1, createdCategories: 0, skipped: 0 })
  vi.spyOn(Route, 'useSearch').mockImplementation(useFakeSearch)
  vi.spyOn(Route, 'useNavigate').mockReturnValue(navigate as never)
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('Family list: chips and member filter', () => {
  it('shows a chip per row with the payer, and the filter lists members incl. a (left) one', async () => {
    renderPage(familyValue())

    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(3))
    const chips = screen.getAllByTestId('member-chip')
    expect(chips.map((c) => c.getAttribute('data-member-id')).sort()).toEqual(['u-left', 'u-me', 'u-olena'])
    const select = screen.getByTestId<HTMLSelectElement>('member-filter')
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      translate('en', 'members.all'),
      'Andrii',
      'Olena',
      translate('en', 'members.left', { name: 'Maksym' }),
    ])
  })

  it('filtering by a member keeps only their rows, and All restores the list', async () => {
    renderPage(familyValue())
    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(3))
    const select = screen.getByTestId('member-filter')

    fireEvent.change(select, { target: { value: 'u-olena' } })
    expect(screen.getAllByTestId('transaction-row')).toHaveLength(1)
    expect(screen.getByTestId('member-chip').getAttribute('data-member-id')).toBe('u-olena')

    fireEvent.change(select, { target: { value: 'u-left' } })
    expect(screen.getAllByTestId('transaction-row')).toHaveLength(1)
    expect(screen.getByTestId('member-chip').getAttribute('aria-label')).toBe('Maksym')

    fireEvent.change(select, { target: { value: 'all' } })
    expect(screen.getAllByTestId('transaction-row')).toHaveLength(3)
  })

  it('shows the title cue and no member UI in Personal', async () => {
    renderPage({ spaceId: 'personal', family: FAMILY })

    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(2))
    expect(screen.queryByTestId('member-chip')).toBeNull()
    expect(screen.queryByTestId('member-filter')).toBeNull()
    expect(screen.queryByTestId('space-title-cue')).toBeNull()
  })

  it('shows the Family title cue while the Family is active', async () => {
    renderPage(familyValue())

    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(3))
    expect(screen.getByTestId('space-title-cue').textContent).toContain('Our home')
  })
})

describe('bulk move', () => {
  it('Personal to Family: select rows, bulk bar, confirm text, then moveRecords with the ids', async () => {
    renderPage({ spaceId: 'personal', family: FAMILY })
    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(2))
    expect(screen.queryByTestId('transactions-bulk-bar')).toBeNull()

    fireEvent.click(screen.getAllByTestId('transaction-select')[0])
    expect(screen.getByTestId('transactions-bulk-bar').textContent).toContain(plural('move.selected', 1))
    fireEvent.click(screen.getAllByTestId('transaction-select')[1])
    expect(screen.getByTestId('transactions-bulk-bar').textContent).toContain(plural('move.selected', 2))

    fireEvent.click(screen.getByTestId('transactions-bulk-move'))
    expect(screen.getByTestId('move-confirm-title').textContent).toBe(
      plural('move.titleToFamily', 2, { name: 'Our home' }),
    )
    expect(screen.getByTestId('move-confirm-text').textContent).toBe(
      translate('en', 'move.bodyToFamily', { name: 'Our home' }),
    )
    expect(moveRecords).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('move-confirm-btn'))

    await waitFor(() => expect(moveRecords).toHaveBeenCalledTimes(1))
    const input = vi.mocked(moveRecords).mock.calls[0][0]
    expect(input.from).toBe('personal')
    expect(input.to).toBe('fam-1')
    expect(input.type).toBe('expense')
    expect([...input.ids].sort()).toEqual(['p1', 'p2'])
    await waitFor(() => expect(screen.queryByTestId('transactions-bulk-bar')).toBeNull())
    expect(toast.success).toHaveBeenCalled()
  })

  it('Family to Personal uses the other direction and text', async () => {
    renderPage(familyValue())
    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(3))

    fireEvent.click(screen.getAllByTestId('transaction-select')[0])
    fireEvent.click(screen.getByTestId('transactions-bulk-move'))

    expect(screen.getByTestId('move-confirm-title').textContent).toBe(
      plural('move.titleToPersonal', 1, { name: 'Our home' }),
    )
    expect(screen.getByTestId('move-confirm-text').textContent).toBe(
      translate('en', 'move.bodyToPersonal', { name: 'Our home' }),
    )
    fireEvent.click(screen.getByTestId('move-confirm-btn'))
    await waitFor(() => expect(moveRecords).toHaveBeenCalledTimes(1))
    expect(vi.mocked(moveRecords).mock.calls[0][0]).toMatchObject({ from: 'fam-1', to: 'personal', type: 'expense' })
  })

  it('cancel leaves the selection and moves nothing', async () => {
    renderPage({ spaceId: 'personal', family: FAMILY })
    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(2))
    fireEvent.click(screen.getAllByTestId('transaction-select')[0])
    fireEvent.click(screen.getByTestId('transactions-bulk-move'))

    fireEvent.click(screen.getByTestId('move-cancel-btn'))

    expect(moveRecords).not.toHaveBeenCalled()
    expect(screen.getByTestId('transactions-bulk-bar')).toBeTruthy()
  })

  it('select all on the page selects every row', async () => {
    renderPage({ spaceId: 'personal', family: FAMILY })
    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(2))

    fireEvent.click(screen.getByTestId('transactions-select-all'))

    expect(screen.getByTestId('transactions-bulk-bar').textContent).toContain(plural('move.selected', 2))
  })

  it('a row action moves that one entry after the confirm', async () => {
    renderPage({ spaceId: 'personal', family: FAMILY })
    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(2))
    const button = screen.getAllByTestId('transaction-move-button')[0]
    expect(button.getAttribute('aria-label') ?? button.textContent).toContain(translate('en', 'move.toFamily'))

    fireEvent.click(button)
    fireEvent.click(screen.getByTestId('move-confirm-btn'))

    await waitFor(() => expect(moveRecords).toHaveBeenCalledTimes(1))
    expect(vi.mocked(moveRecords).mock.calls[0][0].ids).toHaveLength(1)
  })

  it('a refused move shows an error toast and keeps the list', async () => {
    vi.mocked(moveRecords).mockRejectedValue(new Error('boom'))
    renderPage({ spaceId: 'personal', family: FAMILY })
    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(2))
    fireEvent.click(screen.getAllByTestId('transaction-select')[0])
    fireEvent.click(screen.getByTestId('transactions-bulk-move'))

    fireEvent.click(screen.getByTestId('move-confirm-btn'))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain('boom')
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getAllByTestId('transaction-row')).toHaveLength(2)
  })

  it('without a Family there are no selection, move controls or bulk bar', async () => {
    renderPage({ spaceId: 'personal', family: null })
    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(2))

    expect(screen.queryByTestId('transaction-select')).toBeNull()
    expect(screen.queryByTestId('transactions-select-all')).toBeNull()
    expect(screen.queryByTestId('transaction-move-button')).toBeNull()
    expect(screen.queryByTestId('transactions-bulk-bar')).toBeNull()
  })
})

describe('read-only Family', () => {
  it('shows the banner and disables add, edit, delete, select and move', async () => {
    renderPage(familyValue({ readOnly: true }))

    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(3))
    expect(screen.getByTestId('space-readonly-banner')).toBeTruthy()
    expect(screen.getByTestId('space-readonly-settings-link')).toBeTruthy()
    expect(screen.getByTestId<HTMLButtonElement>('transactions-add-btn').disabled).toBe(true)
    expect(screen.getByTestId<HTMLButtonElement>('transactions-add-fab').disabled).toBe(true)
    for (const id of ['transaction-edit-button', 'transaction-delete-button', 'transaction-move-button']) {
      for (const el of screen.getAllByTestId<HTMLButtonElement>(id)) expect(el.disabled, id).toBe(true)
    }
    for (const el of screen.getAllByTestId<HTMLInputElement>('transaction-select')) expect(el.disabled).toBe(true)
  })

  it('a healthy Family has the same controls enabled', async () => {
    renderPage(familyValue())

    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(3))
    expect(screen.getByTestId<HTMLButtonElement>('transactions-add-btn').disabled).toBe(false)
    expect(screen.getAllByTestId<HTMLButtonElement>('transaction-edit-button')[0].disabled).toBe(false)
  })

  it('a paused Family keeps editing enabled and shows the small banner', async () => {
    renderPage(familyValue({ paused: true }))

    await waitFor(() => expect(screen.getAllByTestId('transaction-row')).toHaveLength(3))
    expect(screen.getByTestId('space-paused-banner')).toBeTruthy()
    expect(screen.getByTestId<HTMLButtonElement>('transactions-add-btn').disabled).toBe(false)
  })
})

describe('URL: space param', () => {
  it('?add=expense&space=family while in Personal switches first, strips the param and keeps the drawer closed', async () => {
    search = { add: 'expense', space: 'family' }
    renderPage({ spaceId: 'personal', family: FAMILY })

    await waitFor(() => expect(switchTo).toHaveBeenCalledWith('fam-1'))
    await waitFor(() => expect(navigate).toHaveBeenCalled())
    const call = navigate.mock.calls[0][0] as { search: TransactionsSearch; replace?: boolean }
    expect(call.search).toEqual({ add: 'expense' })
    expect(call.replace).toBe(true)
    expect(screen.queryByTestId('expense-drawer')).toBeNull()
  })

  it('?space=personal while in the Family switches to Personal', async () => {
    search = { add: 'expense', space: 'personal' }
    renderPage(familyValue())

    await waitFor(() => expect(switchTo).toHaveBeenCalledWith('personal'))
  })

  it('a space equal to the active one is only stripped, no switch', async () => {
    search = { add: 'expense', space: 'family' }
    renderPage(familyValue())

    await waitFor(() => expect(navigate).toHaveBeenCalled())
    expect(switchTo).not.toHaveBeenCalled()
    expect((navigate.mock.calls[0][0] as { search: TransactionsSearch }).search).toEqual({ add: 'expense' })
  })

  it('without a Family the param is ignored and nothing navigates', async () => {
    search = { add: 'expense', space: 'family' }
    renderPage({ spaceId: 'personal', family: null })

    await screen.findByTestId('expense-drawer')
    expect(switchTo).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('?add=expense alone opens the drawer in the active space (the shortcut)', async () => {
    search = { add: 'expense' }
    renderPage(familyValue())

    await screen.findByTestId('expense-drawer')
    expect(switchTo).not.toHaveBeenCalled()
    expect(screen.getByTestId('drawer-space-cue').textContent).toBe(translate('en', 'space.adding', { name: 'Our home' }))
  })
})

describe('URL: cross-space edit', () => {
  it('finds the id in the other space, switches and toasts', async () => {
    search = { edit: 'f2' }
    renderPage({ spaceId: 'personal', family: FAMILY })

    await waitFor(() => expect(switchTo).toHaveBeenCalledWith('fam-1'))
    expect(toast).toHaveBeenCalledWith(translate('en', 'space.switchedTo', { name: 'Our home' }))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('an id in the active space needs no switch', async () => {
    search = { edit: 'p1' }
    renderPage({ spaceId: 'personal', family: FAMILY })

    await screen.findByTestId('expense-drawer')
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('an id in neither space gives the not-found toast, judged after both lookups', async () => {
    search = { edit: 'nowhere' }
    renderPage({ spaceId: 'personal', family: FAMILY })

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(translate('en', 'toasts.transactionNotFound')))
    expect(fam.getAllExpenses).toHaveBeenCalled()
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('without a Family only the active space is searched', async () => {
    search = { edit: 'f2' }
    renderPage({ spaceId: 'personal', family: null })

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(translate('en', 'toasts.transactionNotFound')))
    expect(fam.getAllExpenses).not.toHaveBeenCalled()
  })
})

describe('ExpenseDrawer in a Family', () => {
  function renderDrawer(value: Partial<ActiveSpaceState>, props: Partial<ComponentProps<typeof ExpenseDrawer>> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={client}>
        <SpaceSwitchProvider value={{ switchTo, ...value }}>
          <ExpenseDrawer
            mode="add"
            open
            onOpenChange={() => undefined}
            categories={CATEGORIES}
            mainCurrency="UAH"
            entries={[]}
            initial={{ categoryId: 'cat-food' }}
            {...props}
          />
        </SpaceSwitchProvider>
      </QueryClientProvider>,
    )
  }

  it('shows "Adding to <name>" and Paid by defaulting to me', () => {
    renderDrawer(familyValue())

    expect(screen.getByTestId('drawer-space-cue').textContent).toBe(translate('en', 'space.adding', { name: 'Our home' }))
    const select = within(screen.getByTestId('expense-drawer')).getByTestId<HTMLSelectElement>('paid-by-select')
    expect(select.value).toBe('u-me')
    expect(within(screen.getByTestId('expense-drawer')).getByLabelText(translate('en', 'members.paidBy'))).toBe(select)
  })

  it('saves the chosen payer into the Family space only', async () => {
    renderDrawer(familyValue())
    fireEvent.change(screen.getByTestId('drawer-amount'), { target: { value: '50' } })
    fireEvent.change(screen.getByTestId('paid-by-select'), { target: { value: 'u-olena' } })

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(fam.addExpense).toHaveBeenCalledTimes(1))
    expect(fam.addExpense.mock.calls[0][0]).toMatchObject({ paidBy: 'u-olena', amount: 50 })
  })

  it('saving without touching Paid by stores me', async () => {
    renderDrawer(familyValue())
    fireEvent.change(screen.getByTestId('drawer-amount'), { target: { value: '12' } })

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(fam.addExpense).toHaveBeenCalledTimes(1))
    expect(fam.addExpense.mock.calls[0][0].paidBy).toBe('u-me')
  })

  it('Personal shows no cue, no Paid by and saves without a paidBy key', async () => {
    renderDrawer({ spaceId: 'personal', family: FAMILY })
    expect(screen.queryByTestId('drawer-space-cue')).toBeNull()
    expect(screen.queryByTestId('paid-by-select')).toBeNull()
    expect(screen.queryByTestId('drawer-authorship')).toBeNull()
    fireEvent.change(screen.getByTestId('drawer-amount'), { target: { value: '12' } })

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect('paidBy' in vi.mocked(addExpense).mock.calls[0][0]).toBe(false)
  })

  it('edit mode keeps the stored payer and shows who added and edited it', () => {
    const edited = exp('f2', 200, 'u-olena', {
      createdBy: 'u-me',
      updatedBy: 'u-olena',
      updatedAt: '2026-10-21T08:00:00.000Z',
    })
    renderDrawer(familyValue(), { mode: 'edit', expense: edited, initial: undefined })

    expect(screen.getByTestId<HTMLSelectElement>('paid-by-select').value).toBe('u-olena')
    const text = screen.getByTestId('drawer-authorship').textContent
    expect(text).toContain(translate('en', 'members.addedBy', { name: 'Andrii' }))
    expect(text).toContain(translate('en', 'members.editedBy', { name: 'Olena', date: formatFullDate('2026-10-21T08:00:00.000Z') }))
  })

  it('authorship omits "Edited by" when the editor is the creator, and shows Former member for unknown ids', () => {
    const own = exp('f1', 100, 'u-me', { createdBy: 'u-ghost', updatedBy: 'u-ghost' })
    renderDrawer(familyValue(), { mode: 'edit', expense: own, initial: undefined })

    const text = screen.getByTestId('drawer-authorship').textContent
    expect(text).toContain(translate('en', 'members.addedBy', { name: translate('en', 'members.formerMember') }))
    expect(text).not.toContain('Edited by')
  })

  it('registers a switch guard while open: clean until input, dirty after, close() closes the drawer', () => {
    const unregister = vi.fn()
    const registerGuard = vi.fn((_guard: { isDirty: () => boolean; close: () => void }) => unregister)
    const onOpenChange = vi.fn()
    renderDrawer(familyValue({ registerGuard }), { onOpenChange })

    expect(registerGuard).toHaveBeenCalledTimes(1)
    const guard = registerGuard.mock.calls[0][0]
    expect(guard.isDirty()).toBe(false)

    fireEvent.change(screen.getByTestId('drawer-amount'), { target: { value: '50' } })
    expect(registerGuard.mock.calls.at(-1)?.[0].isDirty()).toBe(true)

    registerGuard.mock.calls.at(-1)?.[0].close()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('registers no guard while the drawer is closed', () => {
    const registerGuard = vi.fn(() => () => undefined)
    renderDrawer(familyValue({ registerGuard }), { open: false })

    expect(registerGuard).not.toHaveBeenCalled()
  })

  it('a read-only Family disables save and delete', () => {
    renderDrawer(familyValue({ readOnly: true }), { mode: 'edit', expense: exp('f1', 100, 'u-me'), initial: undefined })

    expect(screen.getByTestId<HTMLButtonElement>('drawer-save').disabled).toBe(true)
    expect(screen.getByTestId<HTMLButtonElement>('drawer-delete').disabled).toBe(true)
  })
})

describe('TransactionsTable selection props', () => {
  function renderTable(extra: Partial<ComponentProps<typeof TransactionsTable>> = {}) {
    const onToggle = vi.fn()
    const onToggleAll = vi.fn()
    const onMove = vi.fn()
    render(
      <TransactionsTable
        transactions={[exp('f1', 100, 'u-me'), exp('f2', 200, 'u-olena')]}
        onDelete={() => undefined}
        onEdit={() => undefined}
        members={DIR}
        selection={{ selected: new Set(['f2']), onToggle, onToggleAll }}
        onMove={onMove}
        moveLabel="Move to Personal"
        {...extra}
      />,
    )
    return { onToggle, onToggleAll, onMove }
  }

  it('reports toggles and reflects the selected set', () => {
    const { onToggle, onToggleAll } = renderTable()

    const boxes = screen.getAllByTestId<HTMLInputElement>('transaction-select')
    expect(boxes.map((b) => b.checked)).toEqual([false, true])
    fireEvent.click(boxes[0])
    expect(onToggle).toHaveBeenCalledWith('f1')
    fireEvent.click(screen.getByTestId('transactions-select-all'))
    expect(onToggleAll).toHaveBeenCalledTimes(1)
  })

  it('calls onMove with the expense of the row and uses the label', () => {
    const { onMove } = renderTable()

    const buttons = screen.getAllByTestId('transaction-move-button')
    fireEvent.click(buttons[1])
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: 'f2' }))
    expect(buttons[0].getAttribute('aria-label') ?? buttons[0].textContent).toContain('Move to Personal')
  })

  it('moveDisabled disables the move buttons only', () => {
    renderTable({ moveDisabled: true })

    for (const b of screen.getAllByTestId<HTMLButtonElement>('transaction-move-button')) expect(b.disabled).toBe(true)
    expect(screen.getAllByTestId<HTMLButtonElement>('transaction-edit-button')[0].disabled).toBe(false)
  })

  it('without the optional props the table is unchanged (no chips, boxes, move)', () => {
    render(
      <TransactionsTable transactions={[exp('f1', 100, 'u-me')]} onDelete={() => undefined} onEdit={() => undefined} />,
    )

    expect(screen.queryByTestId('member-chip')).toBeNull()
    expect(screen.queryByTestId('transaction-select')).toBeNull()
    expect(screen.queryByTestId('transaction-move-button')).toBeNull()
  })
})
