// CONTRACT_GAP: the exact text of the date inside a recurring-due-row and a
//   recurring-upcoming-row is not specified, so rows are checked through their
//   name, their order and their amount input / amount text only.
// CONTRACT_GAP: the testid of the "Nothing in the next 7 days" message is not
//   specified; it is asserted through the text of recurring-upcoming.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { Category, RecurringItem } from '@/lib/domain'
import RecurringDashboardSection from '@/components/index/RecurringDashboardSection'
import {
  confirmRecurringOccurrence,
  getAllCategories,
  getAllIncomeCategories,
  getAllRecurring,
  skipRecurringOccurrence,
} from '@/lib/localDb'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string
    children?: ReactNode
    [key: string]: unknown
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}))
vi.mock('@/lib/localDb', () => ({
  getAllRecurring: vi.fn(),
  getAllCategories: vi.fn(),
  getAllIncomeCategories: vi.fn(),
  confirmRecurringOccurrence: vi.fn(),
  skipRecurringOccurrence: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const TODAY = '2026-05-15'

const EXPENSE_CATEGORIES: Array<Category> = [{ id: 'c1', name: 'Food', icon: '🍔' }]
const INCOME_CATEGORIES: Array<Category> = [{ id: 'ic1', name: 'Salary', icon: '💼' }]

function make(overrides: Partial<RecurringItem> & { id: string }): RecurringItem {
  return {
    kind: 'expense',
    amount: 100,
    currency: 'UAH',
    categoryId: 'c1',
    description: null,
    frequency: { unit: 'month', interval: 1 },
    startDate: '2026-03-15',
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

// Due: 2026-03-15, 04-15 and 05-15.
const ASK_DUE = make({ id: 'ask', mode: 'ask', description: 'Rent', amount: 100 })
// Upcoming: next occurrence 2026-05-20 (5 days ahead).
const AUTO_SOON = make({
  id: 'soon',
  description: 'Netflix',
  amount: 30,
  startDate: '2026-04-20',
  handledThrough: '2026-04-20',
})
// Next occurrence 2026-05-23, 8 days ahead: outside the 7 day window.
const AUTO_LATER = make({
  id: 'later',
  description: 'Later sub',
  startDate: '2026-04-23',
  handledThrough: '2026-04-23',
})

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <RecurringDashboardSection today={TODAY} />
    </QueryClientProvider>,
  )
}

function dueRows() {
  return screen.getAllByTestId('recurring-due-row')
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getAllCategories).mockResolvedValue(EXPENSE_CATEGORIES)
  vi.mocked(getAllIncomeCategories).mockResolvedValue(INCOME_CATEGORIES)
  vi.mocked(getAllRecurring).mockResolvedValue([])
  vi.mocked(confirmRecurringOccurrence).mockResolvedValue(undefined)
  vi.mocked(skipRecurringOccurrence).mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe('RecurringDashboardSection with no items', () => {
  it('renders nothing at all', async () => {
    const { container } = renderSection()

    await waitFor(() => expect(getAllRecurring).toHaveBeenCalled())
    await waitFor(() => expect(getAllCategories).toHaveBeenCalled())

    expect(container.innerHTML).toBe('')
    expect(screen.queryByTestId('recurring-due')).toBeNull()
    expect(screen.queryByTestId('recurring-upcoming')).toBeNull()
  })

  it('renders nothing while the queries are pending', () => {
    vi.mocked(getAllRecurring).mockReturnValue(new Promise(() => {}))

    const { container } = renderSection()

    expect(container.innerHTML).toBe('')
  })

  it('shows the query error when loading the items fails', async () => {
    vi.mocked(getAllRecurring).mockRejectedValue(new Error('boom'))

    renderSection()

    await screen.findByTestId('query-error')
    expect(screen.queryByTestId('recurring-due')).toBeNull()
    expect(screen.queryByTestId('recurring-upcoming')).toBeNull()
  })
})

describe('Due card', () => {
  beforeEach(() => {
    vi.mocked(getAllRecurring).mockResolvedValue([ASK_DUE])
  })

  it('lists every due occurrence of an ask-mode item, oldest first, with the item name', async () => {
    renderSection()

    await screen.findByTestId('recurring-due')

    const rows = dueRows()
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(row.textContent).toContain('Rent')
    expect(screen.getByTestId('recurring-due').textContent).toContain('Due')
  })

  it('pre-fills each amount input with the item amount', async () => {
    vi.mocked(getAllRecurring).mockResolvedValue([make({ ...ASK_DUE, amount: 42.5 })])
    renderSection()
    await screen.findByTestId('recurring-due')

    for (const row of dueRows()) {
      expect(within(row).getByTestId<HTMLInputElement>('recurring-due-amount').value).toBe('42.5')
    }
  })

  it('is not shown for auto items, paused items, or ask items with nothing due', async () => {
    vi.mocked(getAllRecurring).mockResolvedValue([
      make({ id: 'auto', description: 'Auto' }),
      make({ id: 'paused', mode: 'ask', paused: true }),
      make({ id: 'handled', mode: 'ask', handledThrough: TODAY }),
    ])
    renderSection()

    await waitFor(() => expect(getAllRecurring).toHaveBeenCalled())
    await screen.findByTestId('recurring-upcoming')

    expect(screen.queryByTestId('recurring-due')).toBeNull()
  })

  it('uses the income category name for an income item without a description', async () => {
    vi.mocked(getAllRecurring).mockResolvedValue([
      make({
        id: 'inc',
        kind: 'income',
        categoryId: 'ic1',
        mode: 'ask',
        startDate: '2026-05-15',
      }),
    ])
    renderSection()

    await screen.findByTestId('recurring-due')

    expect(dueRows()).toHaveLength(1)
    expect(dueRows()[0].textContent).toContain('Salary')
  })

  it('Add confirms the oldest occurrence with no overrides when the amount is unchanged', async () => {
    renderSection()
    await screen.findByTestId('recurring-due')

    fireEvent.click(within(dueRows()[0]).getByTestId('recurring-due-add'))

    await waitFor(() => expect(confirmRecurringOccurrence).toHaveBeenCalledTimes(1))
    const call = vi.mocked(confirmRecurringOccurrence).mock.calls[0]
    expect(call[0]).toBe('ask')
    expect(call[1]).toBe('2026-03-15')
    expect(call[2]).toBeUndefined()
  })

  it('Add passes the changed amount as an override, for that row only', async () => {
    renderSection()
    await screen.findByTestId('recurring-due')
    const second = dueRows()[1]
    fireEvent.change(within(second).getByTestId('recurring-due-amount'), {
      target: { value: '75' },
    })

    fireEvent.click(within(second).getByTestId('recurring-due-add'))

    await waitFor(() => expect(confirmRecurringOccurrence).toHaveBeenCalledTimes(1))
    const call = vi.mocked(confirmRecurringOccurrence).mock.calls[0]
    expect(call[1]).toBe('2026-04-15')
    expect(call[2]).toEqual({ amount: 75 })
    expect(
      within(dueRows()[0]).getByTestId<HTMLInputElement>('recurring-due-amount').value,
    ).toBe('100')
  })

  it('Skip skips that occurrence without creating anything', async () => {
    renderSection()
    await screen.findByTestId('recurring-due')

    fireEvent.click(within(dueRows()[2]).getByTestId('recurring-due-skip'))

    await waitFor(() => expect(skipRecurringOccurrence).toHaveBeenCalledTimes(1))
    expect(vi.mocked(skipRecurringOccurrence).mock.calls[0].slice(0, 2)).toEqual([
      'ask',
      '2026-05-15',
    ])
    expect(confirmRecurringOccurrence).not.toHaveBeenCalled()
  })

  it('after Add the data is refetched and the row is gone', async () => {
    let handledThrough: string | null = null
    vi.mocked(getAllRecurring).mockImplementation(() =>
      Promise.resolve([make({ ...ASK_DUE, handledThrough })]),
    )
    vi.mocked(confirmRecurringOccurrence).mockImplementation(() => {
      handledThrough = '2026-03-15'
      return Promise.resolve()
    })
    renderSection()
    await screen.findByTestId('recurring-due')
    expect(dueRows()).toHaveLength(3)

    fireEvent.click(within(dueRows()[0]).getByTestId('recurring-due-add'))

    await waitFor(() => expect(dueRows()).toHaveLength(2))
  })

  it('after the last Skip the Due card disappears', async () => {
    let handledThrough: string | null = null
    vi.mocked(getAllRecurring).mockImplementation(() =>
      Promise.resolve([make({ ...ASK_DUE, startDate: '2026-05-15', handledThrough })]),
    )
    vi.mocked(skipRecurringOccurrence).mockImplementation(() => {
      handledThrough = '2026-05-15'
      return Promise.resolve()
    })
    renderSection()
    await screen.findByTestId('recurring-due')

    fireEvent.click(within(dueRows()[0]).getByTestId('recurring-due-skip'))

    await waitFor(() => expect(screen.queryByTestId('recurring-due')).toBeNull())
  })

  it('a failed Add shows an error toast and keeps the row', async () => {
    vi.mocked(confirmRecurringOccurrence).mockRejectedValue(new Error('Category not found'))
    renderSection()
    await screen.findByTestId('recurring-due')

    fireEvent.click(within(dueRows()[0]).getByTestId('recurring-due-add'))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(dueRows()).toHaveLength(3)
  })

  it('a failed Skip shows an error toast and keeps the row', async () => {
    vi.mocked(skipRecurringOccurrence).mockRejectedValue(new Error('Occurrence is not due'))
    renderSection()
    await screen.findByTestId('recurring-due')

    fireEvent.click(within(dueRows()[0]).getByTestId('recurring-due-skip'))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(dueRows()).toHaveLength(3)
  })
})

describe('Upcoming card', () => {
  it('lists occurrences in the next 7 days and links to /recurring', async () => {
    vi.mocked(getAllRecurring).mockResolvedValue([AUTO_SOON, AUTO_LATER])
    renderSection()

    const card = await screen.findByTestId('recurring-upcoming')

    const rows = within(card).getAllByTestId('recurring-upcoming-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Netflix')
    expect(card.textContent).toContain('Upcoming')
    expect(card.textContent).not.toContain('Later sub')
    expect(screen.getByTestId('recurring-upcoming-link').getAttribute('href')).toBe(
      '/recurring',
    )
    expect(screen.queryByTestId('recurring-due')).toBeNull()
  })

  it('a different item shows its own name', async () => {
    vi.mocked(getAllRecurring).mockResolvedValue([
      make({
        id: 'x',
        description: 'Gym',
        startDate: '2026-05-21',
      }),
    ])
    renderSection()

    const row = await screen.findByTestId('recurring-upcoming-row')

    expect(row.textContent).toContain('Gym')
    expect(row.textContent).not.toContain('Netflix')
  })

  it('shows "Nothing in the next 7 days" and the link when items exist but none fall in the window', async () => {
    vi.mocked(getAllRecurring).mockResolvedValue([AUTO_LATER])
    renderSection()

    const card = await screen.findByTestId('recurring-upcoming')

    expect(card.textContent).toContain('Nothing in the next 7 days')
    expect(screen.queryByTestId('recurring-upcoming-row')).toBeNull()
    expect(screen.getByTestId('recurring-upcoming-link')).toBeTruthy()
  })

  it('shows at most 5 rows', async () => {
    vi.mocked(getAllRecurring).mockResolvedValue(
      Array.from({ length: 7 }, (_, i) =>
        make({
          id: `u${i}`,
          description: `Sub ${i}`,
          startDate: `2026-05-${String(16 + (i % 6)).padStart(2, '0')}`,
        }),
      ),
    )
    renderSection()

    await screen.findByTestId('recurring-upcoming')

    expect(screen.getAllByTestId('recurring-upcoming-row')).toHaveLength(5)
  })

  it('does not list paused items', async () => {
    vi.mocked(getAllRecurring).mockResolvedValue([
      make({ id: 'p', description: 'Paused one', startDate: '2026-05-18', paused: true }),
    ])
    renderSection()

    const card = await screen.findByTestId('recurring-upcoming')

    expect(within(card).queryByTestId('recurring-upcoming-row')).toBeNull()
  })

  it('shows both cards when an ask item is due and another item is upcoming', async () => {
    vi.mocked(getAllRecurring).mockResolvedValue([ASK_DUE, AUTO_SOON])
    renderSection()

    await screen.findByTestId('recurring-due')

    expect(await screen.findByTestId('recurring-upcoming')).toBeTruthy()
    expect(dueRows()).toHaveLength(3)
    expect(screen.getAllByTestId('recurring-upcoming-row')).toHaveLength(1)
  })
})
