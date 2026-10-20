// No CONTRACT_GAPs: the transactions route approach, the fake testids (#5) and
// the search / navigate harness are specified in the Interface Contract (route:
// /transactions). No router is mounted, so both Route.useSearch and
// Route.useNavigate are spied. The search lives in a tiny external store that
// the spied useSearch subscribes to, so a navigate call re-renders the page the
// way the router would.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Category, Expense } from '@/lib/domain'
import type { TransactionsSearch } from '@/lib/expenseDraft'
import {
  addExpense,
  deleteExpense,
  getAllExpenses,
  updateExpense,
} from '@/lib/localDb'
import { computeGate } from '@/lib/vaultSession'
import { Route } from '@/routes/transactions'

const { items, categoryItems } = vi.hoisted(() => ({
  items: [] as Array<Expense>,
  categoryItems: [] as Array<Category>,
}))

vi.mock('@/lib/localDb', () => ({
  getAllCategories: vi.fn(() => Promise.resolve([...categoryItems])),
  getAllExpenses: vi.fn(() => Promise.resolve([...items])),
  deleteExpense: vi.fn((id: string) => {
    const index = items.findIndex((e) => e.id === id)
    if (index !== -1) items.splice(index, 1)
    return Promise.resolve()
  }),
  updateExpense: vi.fn(),
  addExpense: vi.fn(),
  addRepeatingExpense: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/components/transactions/TransactionsPagination', () => ({
  TransactionsPagination: ({
    pageIndex,
    totalPages,
    onPageChange,
  }: {
    pageIndex: number
    totalPages: number
    onPageChange: (next: number) => void
  }) => (
    <div
      data-testid="fake-pagination"
      data-page-index={pageIndex}
      data-total-pages={totalPages}
    >
      <button
        data-testid="fake-pagination-next"
        onClick={() => onPageChange(pageIndex + 1)}
      />
    </div>
  ),
}))

vi.mock('@/components/transactions/TransactionsTable', () => ({
  TransactionsTable: ({
    transactions,
    onDelete,
    onEdit,
  }: {
    transactions: Array<Expense>
    onDelete: (id: string, createdAt: string) => void
    onEdit: (expense: Expense) => void
  }) => (
    <div>
      {transactions.map((t) => (
        <div data-testid="fake-row" key={t.id}>
          <button
            data-testid="fake-row-delete"
            onClick={() => onDelete(t.id, t.createdAt)}
          />
          <button data-testid="fake-row-edit" onClick={() => onEdit(t)} />
        </div>
      ))}
    </div>
  ),
}))

// The search the page reads, and the listeners of the pages showing it.
let search: TransactionsSearch = {}
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function useFakeSearch() {
  return useSyncExternalStore(subscribe, () => search)
}

function setSearch(next: TransactionsSearch) {
  search = next
  act(() => {
    listeners.forEach((listener) => listener())
  })
}

const navigate = vi.fn(
  (options: { search: TransactionsSearch; replace?: boolean }) => {
    search = options.search
    listeners.forEach((listener) => listener())
  },
)

function fill(count: number) {
  items.length = 0
  for (let i = 0; i < count; i++) {
    items.push({
      id: `e${i}`,
      amount: 10 + i,
      currency: 'UAH',
      categoryId: 'cat-food',
      // Distinct, descending createdAt.
      createdAt: new Date(Date.UTC(2024, 0, 31, 12, 0, 0) - i * 3_600_000)
        .toISOString(),
    })
  }
}

function renderPage() {
  const Page = Route.options.component
  if (!Page) throw new Error('transactions route has no component')
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
  vi.clearAllMocks()
  search = {}
  listeners.clear()
  categoryItems.length = 0
  categoryItems.push(
    { id: 'cat-food', name: 'Food', icon: '🍔' },
    { id: 'cat-coffee', name: 'Coffee', icon: '☕' },
    { id: 'cat-server', name: 'Server Costs', icon: '🖥️', defaultCurrency: 'USD' },
  )
  vi.spyOn(Route, 'useSearch').mockImplementation(useFakeSearch)
  vi.spyOn(Route, 'useNavigate').mockReturnValue(navigate as never)
})

describe('transactions page clamps the page index (#5)', () => {
  beforeEach(() => {
    fill(31)
  })

  it('falls back to the last page when the only row on the current page is deleted', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(15)
    })

    fireEvent.click(screen.getByTestId('fake-pagination-next'))
    fireEvent.click(screen.getByTestId('fake-pagination-next'))
    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(1)
    })

    fireEvent.click(screen.getByTestId('fake-row-delete'))

    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(15)
    })
    const pagination = screen.getByTestId('fake-pagination')
    expect(pagination.getAttribute('data-page-index')).toBe('1')
    expect(pagination.getAttribute('data-total-pages')).toBe('2')
  })

  it('shows the first page for a small list and does not clamp prematurely', async () => {
    fill(20)
    renderPage()

    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(15)
    })
    expect(
      screen.getByTestId('fake-pagination').getAttribute('data-page-index'),
    ).toBe('0')

    fireEvent.click(screen.getByTestId('fake-pagination-next'))

    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(5)
    })
    expect(
      screen.getByTestId('fake-pagination').getAttribute('data-page-index'),
    ).toBe('1')
  })
})

describe('transactions page: Add transaction button and FAB', () => {
  beforeEach(() => {
    fill(3)
  })

  it('shows both buttons and no drawer by default', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(3)
    })

    expect(screen.getByTestId('transactions-add-btn').textContent).toContain(
      'Add transaction',
    )
    expect(
      screen.getByTestId('transactions-add-fab').getAttribute('aria-label'),
    ).toBe('Add transaction')
    expect(screen.queryByTestId('expense-drawer')).toBeNull()
  })

  it('the button navigates to ?add=expense and the drawer opens with the amount focused', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(3)
    })

    fireEvent.click(screen.getByTestId('transactions-add-btn'))

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({ search: { add: 'expense' } })
    const drawer = await screen.findByTestId('expense-drawer')
    expect(drawer.getAttribute('data-mode')).toBe('add')
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('drawer-amount'))
    })
  })

  it('the floating button does the same', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(3)
    })

    fireEvent.click(screen.getByTestId('transactions-add-fab'))

    expect(navigate).toHaveBeenCalledWith({ search: { add: 'expense' } })
    expect((await screen.findByTestId('expense-drawer')).getAttribute('data-mode')).toBe(
      'add',
    )
  })

  it('keeps the button when the expenses fail to load', async () => {
    vi.mocked(getAllExpenses).mockRejectedValueOnce(new Error('boom'))
    renderPage()

    await screen.findByTestId('query-error')

    expect(screen.getByTestId('transactions-add-btn')).toBeTruthy()
  })
})

describe('transactions page: the drawer follows the URL', () => {
  beforeEach(() => {
    fill(3)
  })

  it('opens the add drawer when the page mounts with ?add=expense (also after an unlock)', async () => {
    const locked = computeGate({
      mounted: true,
      phase: 'locked',
      createRequested: false,
      pathname: '/transactions',
    })
    expect(locked.showChildren).toBe(false)
    const unlocked = computeGate({
      mounted: true,
      phase: 'unlocked',
      createRequested: false,
      pathname: '/transactions',
    })
    expect(unlocked.showChildren).toBe(true)
    search = { add: 'expense' }

    renderPage()

    const drawer = await screen.findByTestId('expense-drawer')
    expect(drawer.getAttribute('data-mode')).toBe('add')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('prefills the drawer from the URL params', async () => {
    search = {
      add: 'expense',
      category: 'cat-coffee',
      amount: '12.5',
      currency: 'EUR',
      description: 'Tea',
    }

    renderPage()

    await screen.findByTestId('expense-drawer')
    expect(screen.getByTestId<HTMLInputElement>('drawer-amount').value).toBe('12.5')
    expect(screen.getByTestId<HTMLInputElement>('drawer-description').value).toBe('Tea')
    expect(screen.getByTestId('drawer-currency-EUR').getAttribute('aria-pressed')).toBe(
      'true',
    )
    await waitFor(() => {
      expect(screen.getByTestId('drawer-category-cat-coffee').getAttribute('aria-checked')).toBe(
        'true',
      )
    })
  })

  it('a row edit button navigates to ?edit=<id> and opens the edit drawer with that expense', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(3)
    })

    fireEvent.click(screen.getAllByTestId('fake-row-edit')[1])

    expect(navigate).toHaveBeenCalledWith({ search: { edit: 'e1' } })
    const drawer = await screen.findByTestId('expense-drawer')
    expect(drawer.getAttribute('data-mode')).toBe('edit')
    expect(screen.getByTestId<HTMLInputElement>('drawer-amount').value).toBe('11')
    expect(
      screen.getByTestId('drawer-category-cat-food').getAttribute('aria-checked'),
    ).toBe('true')
  })

  it('opens the edit drawer of another row with its own values', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(3)
    })

    fireEvent.click(screen.getAllByTestId('fake-row-edit')[2])

    await screen.findByTestId('expense-drawer')
    expect(screen.getByTestId<HTMLInputElement>('drawer-amount').value).toBe('12')
  })

  it('opens the edit drawer when the page mounts with ?edit=<id>', async () => {
    search = { edit: 'e0' }

    renderPage()

    const drawer = await screen.findByTestId('expense-drawer')
    expect(drawer.getAttribute('data-mode')).toBe('edit')
    expect(screen.getByTestId<HTMLInputElement>('drawer-amount').value).toBe('10')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('waits for the expenses to load before judging ?edit=<id>', async () => {
    let release: (list: Array<Expense>) => void = () => {}
    const pending = new Promise<Array<Expense>>((resolve) => {
      release = resolve
    })
    vi.mocked(getAllExpenses).mockImplementationOnce(() => pending)
    search = { edit: 'e0' }

    renderPage()
    await act(async () => {
      await Promise.resolve()
    })

    expect(toast.error).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    expect(screen.queryByTestId('expense-drawer')).toBeNull()

    await act(async () => {
      release([...items])
      await pending
    })

    const drawer = await screen.findByTestId('expense-drawer')
    expect(drawer.getAttribute('data-mode')).toBe('edit')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('toasts once and drops the param for an unknown edit id', async () => {
    search = { edit: 'nope' }

    renderPage()

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Transaction not found')
    })
    expect(navigate).toHaveBeenCalledWith({ search: {}, replace: true })
    await act(async () => {
      await Promise.resolve()
    })
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('expense-drawer')).toBeNull()
    expect(search).toEqual({})
  })

  it('closing with Cancel removes the params with a replace', async () => {
    search = { add: 'expense' }
    renderPage()
    await screen.findByTestId('expense-drawer')

    fireEvent.click(screen.getByTestId('drawer-cancel'))

    expect(navigate).toHaveBeenCalledWith({ search: {}, replace: true })
    await waitFor(() => {
      expect(screen.queryByTestId('expense-drawer')).toBeNull()
    })
  })

  it('closing with Escape removes the params with a replace', async () => {
    search = { edit: 'e0' }
    renderPage()
    await screen.findByTestId('expense-drawer')

    fireEvent.keyDown(screen.getByTestId('drawer-amount'), { key: 'Escape' })

    expect(navigate).toHaveBeenCalledWith({ search: {}, replace: true })
    await waitFor(() => {
      expect(screen.queryByTestId('expense-drawer')).toBeNull()
    })
    expect(updateExpense).not.toHaveBeenCalled()
  })

  it('follows the URL when it changes (the back button)', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(3)
    })
    expect(screen.queryByTestId('expense-drawer')).toBeNull()

    setSearch({ add: 'expense' })
    expect(await screen.findByTestId('expense-drawer')).toBeTruthy()

    setSearch({})
    await waitFor(() => {
      expect(screen.queryByTestId('expense-drawer')).toBeNull()
    })
  })

  it('saving from the drawer adds the expense, refreshes the list and closes', async () => {
    vi.mocked(addExpense).mockResolvedValue({
      id: 'new1',
      amount: 65,
      currency: 'UAH',
      categoryId: 'cat-coffee',
      createdAt: new Date().toISOString(),
    })
    search = { add: 'expense' }
    renderPage()
    await screen.findByTestId('expense-drawer')
    await waitFor(() => expect(getAllExpenses).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('drawer-category-cat-coffee'))
    fireEvent.change(screen.getByTestId('drawer-amount'), { target: { value: '65' } })

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(vi.mocked(addExpense).mock.calls[0][0]).toMatchObject({
      amount: 65,
      categoryId: 'cat-coffee',
    })
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ search: {}, replace: true })
    })
    expect(toast.success).toHaveBeenCalledWith('Expense saved')
    await waitFor(() => {
      expect(vi.mocked(getAllExpenses).mock.calls.length).toBeGreaterThan(1)
    })
  })

  it('saving an edit updates that expense by id and createdAt', async () => {
    vi.mocked(updateExpense).mockResolvedValue(items[0])
    search = { edit: 'e0' }
    renderPage()
    await screen.findByTestId('expense-drawer')
    fireEvent.change(screen.getByTestId('drawer-amount'), { target: { value: '99' } })

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(updateExpense).toHaveBeenCalledTimes(1))
    expect(updateExpense).toHaveBeenCalledWith(
      'e0',
      items[0].createdAt,
      expect.objectContaining({ amount: 99 }),
    )
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ search: {}, replace: true })
    })
    expect(toast.success).toHaveBeenCalledWith('Transaction updated')
  })

  it('deleting from the edit drawer removes the row and closes', async () => {
    search = { edit: 'e1' }
    renderPage()
    await screen.findByTestId('expense-drawer')
    const createdAt = items[1].createdAt

    fireEvent.click(screen.getByTestId('drawer-delete'))
    fireEvent.click(screen.getByTestId('drawer-delete-confirm'))

    await waitFor(() => expect(deleteExpense).toHaveBeenCalledWith('e1', createdAt))
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ search: {}, replace: true })
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(2)
    })
  })

  it('the row delete button still deletes without the drawer', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByTestId('fake-row')).toHaveLength(3)
    })

    fireEvent.click(screen.getAllByTestId('fake-row-delete')[0])

    await waitFor(() => expect(deleteExpense).toHaveBeenCalledTimes(1))
    expect(deleteExpense).toHaveBeenCalledWith('e0', expect.any(String))
    expect(screen.queryByTestId('expense-drawer')).toBeNull()
  })
})
