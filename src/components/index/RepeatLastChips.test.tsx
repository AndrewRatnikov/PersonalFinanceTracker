// No CONTRACT_GAPs: RepeatLastChips props, testids, undo and long-press
// behaviour are fully specified in the Interface Contract (component:
// RepeatLastChips) and plan section 6. Timers: only setTimeout / clearTimeout
// are faked, and the fake clock is switched off again before anything awaits
// (Testing Library's waitFor needs the real timers).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Category, Expense } from '@/lib/domain'
import type { ExpenseDrawerInitial } from '@/lib/expenseDraft'
import { LONG_PRESS_MS, RepeatLastChips } from '@/components/index/RepeatLastChips'
import { addExpense, deleteExpense } from '@/lib/localDb'

vi.mock('@/lib/localDb', () => ({
  addExpense: vi.fn(),
  deleteExpense: vi.fn(),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const DAY = 86_400_000

function ago(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString()
}

const CATEGORIES: Array<Category> = [
  { id: 'cat-food', name: 'Food', icon: '🍔' },
  { id: 'cat-coffee', name: 'Coffee', icon: '☕' },
  { id: 'cat-server', name: 'Server Costs', icon: '🖥️', defaultCurrency: 'USD' },
]

let counter = 0
function expense(daysAgo: number, overrides: Partial<Expense> = {}): Expense {
  counter += 1
  return {
    id: `x${counter}`,
    amount: 65,
    currency: 'UAH',
    categoryId: 'cat-coffee',
    description: 'Coffee',
    createdAt: ago(daysAgo),
    ...overrides,
  }
}

function renderChips(
  expenses: ReadonlyArray<Expense>,
  categories: Array<Category> = CATEGORIES,
) {
  const onCustomize = vi.fn<(initial: ExpenseDrawerInitial) => void>()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const view = render(
    <QueryClientProvider client={client}>
      <RepeatLastChips
        expenses={expenses}
        categories={categories}
        onCustomize={onCustomize}
      />
    </QueryClientProvider>,
  )
  return { onCustomize, invalidate, ...view }
}

const chips = () => screen.getAllByTestId('repeat-last-chip')
const mores = () => screen.getAllByTestId('repeat-last-more')
const labels = () => chips().map((c) => c.textContent)

function invalidatedKeys(invalidate: ReturnType<typeof renderChips>['invalidate']) {
  return invalidate.mock.calls.map((c) => c[0]?.queryKey)
}

const SAVED_AT = '2026-10-20T08:15:00.000Z'

interface UndoToastOptions {
  duration?: number
  action?: { label: string; onClick: () => void }
}

// The options argument of the n-th toast.success call, typed for what the
// chips pass (sonner's own type is a wide union).
function toastOptions(callIndex: number): UndoToastOptions | undefined {
  const call: ReadonlyArray<unknown> = vi.mocked(toast.success).mock.calls[callIndex]
  return call[1] as UndoToastOptions | undefined
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(addExpense).mockImplementation((input) =>
    Promise.resolve({ ...input, id: 'new1', createdAt: SAVED_AT }),
  )
  vi.mocked(deleteExpense).mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RepeatLastChips: what is shown', () => {
  it('renders a labelled group with a chip and a "…" button per candidate', () => {
    renderChips([expense(1), expense(2, { description: 'Lunch', categoryId: 'cat-food', amount: 120 })])

    const row = screen.getByTestId('repeat-last-row')
    expect(row.getAttribute('role')).toBe('group')
    expect(row.getAttribute('aria-label')).toBe('Repeat last')
    expect(labels()).toEqual(['☕ Coffee · 65 UAH', '🍔 Lunch · 120 UAH'])
    expect(mores()).toHaveLength(2)
    expect(mores().map((m) => m.textContent)).toEqual(['…', '…'])
    expect(chips()[0].getAttribute('type')).toBe('button')
    expect(mores()[0].getAttribute('type')).toBe('button')
  })

  it('labels the "…" button with what it edits', () => {
    renderChips([expense(1)])

    expect(mores()[0].getAttribute('aria-label')).toBe(
      'Edit before adding Coffee · 65 UAH',
    )
  })

  it('renders nothing when there are no candidates', () => {
    renderChips([])

    expect(screen.queryByTestId('repeat-last-row')).toBeNull()
  })

  it('renders nothing when only recurring or old entries exist', () => {
    renderChips([expense(1, { recurringId: 'r1' }), expense(90)])

    expect(screen.queryByTestId('repeat-last-row')).toBeNull()
  })

  it('drops candidates whose category is gone, keeps the others', () => {
    renderChips([
      expense(1, { categoryId: 'deleted', description: 'Ghost' }),
      expense(2),
    ])

    expect(labels()).toEqual(['☕ Coffee · 65 UAH'])
  })

  it('renders nothing when every candidate lost its category', () => {
    renderChips([expense(1, { categoryId: 'deleted' })])

    expect(screen.queryByTestId('repeat-last-row')).toBeNull()
  })

  it('shows at most 3 chips, the most recent first', () => {
    renderChips([
      expense(5, { description: 'E', amount: 5 }),
      expense(1, { description: 'A', amount: 1 }),
      expense(4, { description: 'D', amount: 4 }),
      expense(2, { description: 'B', amount: 2 }),
      expense(3, { description: 'C', amount: 3 }),
    ])

    expect(labels()).toEqual([
      '☕ A · 1 UAH',
      '☕ B · 2 UAH',
      '☕ C · 3 UAH',
    ])
  })

  it('shows one chip for identical entries', () => {
    renderChips([expense(1), expense(2), expense(3)])

    expect(chips()).toHaveLength(1)
  })

  it('falls back to the category name when there is no description', () => {
    renderChips([
      expense(1, { description: undefined, categoryId: 'cat-food', amount: 12.5, currency: 'USD' }),
    ])

    expect(labels()).toEqual(['🍔 Food · 12.50 USD'])
  })
})

describe('RepeatLastChips: tap to add', () => {
  it('adds one expense dated now and toasts with Undo', async () => {
    const { invalidate } = renderChips([expense(1)])

    fireEvent.click(chips()[0])

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    const input = vi.mocked(addExpense).mock.calls[0][0]
    expect(input).toEqual({
      amount: 65,
      currency: 'UAH',
      categoryId: 'cat-coffee',
      description: 'Coffee',
    })
    expect(input).not.toHaveProperty('createdAt')
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    const message = vi.mocked(toast.success).mock.calls[0][0]
    const options = toastOptions(0)
    expect(message).toBe('Added Coffee · 65 UAH')
    expect(options?.duration).toBe(5000)
    expect(options?.action).toMatchObject({ label: 'Undo' })
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([['expenses'], ['analytics']]),
    )
  })

  it('adds the values of the tapped chip', async () => {
    renderChips([
      expense(1),
      expense(2, {
        description: 'Hosting',
        categoryId: 'cat-server',
        amount: 12.5,
        currency: 'USD',
      }),
    ])

    fireEvent.click(chips()[1])

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(vi.mocked(addExpense).mock.calls[0][0]).toEqual({
      amount: 12.5,
      currency: 'USD',
      categoryId: 'cat-server',
      description: 'Hosting',
    })
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(vi.mocked(toast.success).mock.calls[0][0]).toBe(
      'Added Hosting · 12.50 USD',
    )
  })

  it('leaves the description out when the candidate has none', async () => {
    renderChips([expense(1, { description: null, categoryId: 'cat-food' })])

    fireEvent.click(chips()[0])

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(vi.mocked(addExpense).mock.calls[0][0].description).toBeUndefined()
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(vi.mocked(toast.success).mock.calls[0][0]).toBe('Added Food · 65 UAH')
  })

  it('does not open the editor', async () => {
    const { onCustomize } = renderChips([expense(1)])

    fireEvent.click(chips()[0])

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(onCustomize).not.toHaveBeenCalled()
  })

  it('reports a failed add and shows no success toast', async () => {
    vi.mocked(addExpense).mockRejectedValue(new Error('disk full'))
    renderChips([expense(1)])

    fireEvent.click(chips()[0])

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to add expense')
    })
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('RepeatLastChips: Undo', () => {
  async function addAndGetToast(invalidate: ReturnType<typeof renderChips>['invalidate']) {
    fireEvent.click(chips()[0])
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    const options = toastOptions(0)
    invalidate.mockClear()
    return options
  }

  it('deletes exactly the record that was added', async () => {
    const { invalidate } = renderChips([expense(1)])
    const options = await addAndGetToast(invalidate)

    options?.action?.onClick()

    await waitFor(() => expect(deleteExpense).toHaveBeenCalledTimes(1))
    expect(deleteExpense).toHaveBeenCalledWith('new1', SAVED_AT)
    await waitFor(() => {
      expect(toast.success).toHaveBeenLastCalledWith('Removed')
    })
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([['expenses'], ['analytics']]),
    )
  })

  it('undoes the record of its own tap when two were added', async () => {
    let n = 0
    vi.mocked(addExpense).mockImplementation((input) => {
      n += 1
      return Promise.resolve({ ...input, id: `added${n}`, createdAt: `2026-10-20T08:0${n}:00.000Z` })
    })
    renderChips([expense(1)])

    fireEvent.click(chips()[0])
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    fireEvent.click(chips()[0])
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2))

    toastOptions(0)?.action?.onClick()

    await waitFor(() => expect(deleteExpense).toHaveBeenCalledTimes(1))
    expect(deleteExpense).toHaveBeenCalledWith('added1', '2026-10-20T08:01:00.000Z')
  })
})

describe('RepeatLastChips: "…" button', () => {
  it('opens the editor with the candidate and adds nothing', () => {
    const { onCustomize } = renderChips([expense(1)])

    fireEvent.click(mores()[0])

    expect(onCustomize).toHaveBeenCalledTimes(1)
    expect(onCustomize).toHaveBeenCalledWith({
      categoryId: 'cat-coffee',
      amount: '65',
      currency: 'UAH',
      description: 'Coffee',
    })
    expect(addExpense).not.toHaveBeenCalled()
  })

  it('passes the values of its own chip', () => {
    const { onCustomize } = renderChips([
      expense(1),
      expense(2, { description: 'Hosting', categoryId: 'cat-server', amount: 12.5, currency: 'USD' }),
    ])

    fireEvent.click(mores()[1])

    expect(onCustomize).toHaveBeenCalledWith({
      categoryId: 'cat-server',
      amount: '12.5',
      currency: 'USD',
      description: 'Hosting',
    })
  })

  it('leaves the description out when there is none', () => {
    const { onCustomize } = renderChips([expense(1, { description: undefined })])

    fireEvent.click(mores()[0])

    const initial = onCustomize.mock.calls[0][0]
    expect(Object.keys(initial)).not.toContain('description')
    expect(initial.amount).toBe('65')
  })
})

describe('RepeatLastChips: long press', () => {
  it('exports a 500 ms threshold', () => {
    expect(LONG_PRESS_MS).toBe(500)
  })

  it('opens the editor after the threshold and swallows the click that follows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { onCustomize } = renderChips([expense(1)])

    fireEvent.pointerDown(chips()[0])
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(onCustomize).toHaveBeenCalledTimes(1)
    expect(onCustomize).toHaveBeenCalledWith({
      categoryId: 'cat-coffee',
      amount: '65',
      currency: 'UAH',
      description: 'Coffee',
    })
    fireEvent.pointerUp(chips()[0])
    fireEvent.click(chips()[0])

    vi.useRealTimers()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20)
    })
    expect(addExpense).not.toHaveBeenCalled()
    expect(onCustomize).toHaveBeenCalledTimes(1)
  })

  it('does not fire before the threshold', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { onCustomize } = renderChips([expense(1)])

    fireEvent.pointerDown(chips()[0])
    vi.advanceTimersByTime(LONG_PRESS_MS - 1)

    expect(onCustomize).not.toHaveBeenCalled()
  })

  it('a short press still adds on click', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { onCustomize } = renderChips([expense(1)])

    fireEvent.pointerDown(chips()[0])
    vi.advanceTimersByTime(LONG_PRESS_MS - 100)
    fireEvent.pointerUp(chips()[0])
    vi.advanceTimersByTime(LONG_PRESS_MS)
    fireEvent.click(chips()[0])

    vi.useRealTimers()
    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(onCustomize).not.toHaveBeenCalled()
  })

  it.each(['pointerLeave', 'pointerCancel'] as const)(
    '%s cancels the pending long press',
    (event) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { onCustomize } = renderChips([expense(1)])

      fireEvent.pointerDown(chips()[0])
      vi.advanceTimersByTime(LONG_PRESS_MS - 100)
      fireEvent[event](chips()[0])
      vi.advanceTimersByTime(LONG_PRESS_MS)

      expect(onCustomize).not.toHaveBeenCalled()
    },
  )

  it('a long press on the second chip customises that chip', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { onCustomize } = renderChips([
      expense(1),
      expense(2, { description: 'Lunch', categoryId: 'cat-food', amount: 120 }),
    ])

    fireEvent.pointerDown(chips()[1])
    vi.advanceTimersByTime(LONG_PRESS_MS)

    expect(onCustomize).toHaveBeenCalledWith({
      categoryId: 'cat-food',
      amount: '120',
      currency: 'UAH',
      description: 'Lunch',
    })
  })

  it('suppresses the browser context menu on a chip', () => {
    renderChips([expense(1)])

    const notPrevented = fireEvent.contextMenu(chips()[0])

    expect(notPrevented).toBe(false)
  })
})
