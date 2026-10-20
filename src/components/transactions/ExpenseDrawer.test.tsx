// No CONTRACT_GAPs: ExpenseDrawer props, testids, defaults, touched rules and
// save / delete behaviour are fully specified in the Interface Contract
// (component: ExpenseDrawer) and plan section 4. The tests of the removed inline
// row editor (prefill, validation, Enter / Escape, patch values, unchanged date
// keeps the original timestamp) are moved here and adapted to the drawer.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import dayjs from 'dayjs'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Category, Expense } from '@/lib/domain'
import type { ExpenseDrawerProps } from '@/components/transactions/ExpenseDrawer'
import { ExpenseDrawer } from '@/components/transactions/ExpenseDrawer'
import {
  addExpense,
  addRepeatingExpense,
  deleteExpense,
  updateExpense,
} from '@/lib/localDb'
import { formatMoney } from '@/lib/money'

vi.mock('@/lib/localDb', () => ({
  addExpense: vi.fn(),
  addRepeatingExpense: vi.fn(),
  updateExpense: vi.fn(),
  deleteExpense: vi.fn(),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const TODAY = dayjs().format('YYYY-MM-DD')

const CATEGORIES: Array<Category> = [
  { id: 'cat-food', name: 'Food', icon: '🍔' },
  { id: 'cat-coffee', name: 'Coffee', icon: '☕' },
  { id: 'cat-server', name: 'Server Costs', icon: '🖥️', defaultCurrency: 'USD' },
]

// A local noon on 15 March, so the calendar date is the same in any timezone.
const MARCH_15 = new Date(2026, 2, 15, 12, 0, 0, 0).toISOString()

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'e1',
    amount: 12.5,
    currency: 'UAH',
    categoryId: 'cat-food',
    description: 'Lunch',
    createdAt: MARCH_15,
    ...overrides,
  }
}

function saved(overrides: Partial<Expense> = {}): Expense {
  return makeExpense({ id: 'new1', createdAt: new Date().toISOString(), ...overrides })
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type OpenChange = (open: boolean) => void

function renderDrawer(props: Partial<ExpenseDrawerProps> = {}) {
  const { onOpenChange = vi.fn<OpenChange>(), ...rest } = props
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const view = render(
    <QueryClientProvider client={client}>
      <ExpenseDrawer
        mode="add"
        open
        onOpenChange={onOpenChange}
        categories={CATEGORIES}
        mainCurrency="UAH"
        entries={[]}
        {...rest}
      />
    </QueryClientProvider>,
  )
  return { onOpenChange, invalidate, ...view }
}

function invalidatedKeys(invalidate: ReturnType<typeof renderDrawer>['invalidate']) {
  return invalidate.mock.calls.map((c) => c[0]?.queryKey)
}

const amountInput = () => screen.getByTestId<HTMLInputElement>('drawer-amount')
const dateInput = () => screen.getByTestId<HTMLInputElement>('drawer-date')
const descriptionInput = () =>
  screen.getByTestId<HTMLInputElement>('drawer-description')
const repeatSelect = () => screen.getByTestId<HTMLSelectElement>('drawer-repeat')
const chip = (id: string) => screen.getByTestId(`drawer-category-${id}`)
const isChecked = (id: string) => chip(id).getAttribute('aria-checked') === 'true'
const isPressed = (code: string) =>
  screen.getByTestId(`drawer-currency-${code}`).getAttribute('aria-pressed') ===
  'true'

function setAmount(value: string) {
  fireEvent.change(amountInput(), { target: { value } })
}

function setDescription(value: string) {
  fireEvent.change(descriptionInput(), { target: { value } })
}

function setDate(value: string) {
  fireEvent.change(dateInput(), { target: { value } })
}

function addCall() {
  return vi.mocked(addExpense).mock.calls[0][0]
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(addExpense).mockResolvedValue(saved())
  vi.mocked(addRepeatingExpense).mockResolvedValue(saved())
  vi.mocked(updateExpense).mockResolvedValue(makeExpense())
  vi.mocked(deleteExpense).mockResolvedValue(undefined)
})

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia')
})

describe('ExpenseDrawer: shell', () => {
  it('renders nothing when closed', () => {
    renderDrawer({ open: false })

    expect(screen.queryByTestId('expense-drawer')).toBeNull()
  })

  it('opens in add mode with the title, as a bottom sheet when matchMedia is missing', () => {
    renderDrawer()

    const drawer = screen.getByTestId('expense-drawer')
    expect(drawer.getAttribute('data-mode')).toBe('add')
    expect(drawer.getAttribute('data-side')).toBe('bottom')
    expect(screen.getByTestId('expense-drawer-title').textContent).toBe(
      'Add transaction',
    )
  })

  it('opens from the right on a wide screen', async () => {
    const matchMedia = vi.fn((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: matchMedia,
    })

    renderDrawer()

    await waitFor(() => {
      expect(screen.getByTestId('expense-drawer').getAttribute('data-side')).toBe(
        'right',
      )
    })
    expect(matchMedia).toHaveBeenCalledWith('(min-width: 640px)')
  })

  it('focuses the amount input on open', async () => {
    renderDrawer()

    await waitFor(() => {
      expect(document.activeElement).toBe(amountInput())
    })
  })

  it('has a decimal amount input', () => {
    renderDrawer()

    expect(amountInput().getAttribute('inputmode')).toBe('decimal')
  })

  it('starts empty with the first category, the main currency and today', () => {
    renderDrawer()

    expect(amountInput().value).toBe('')
    expect(descriptionInput().value).toBe('')
    expect(isChecked('cat-food')).toBe(true)
    expect(isChecked('cat-coffee')).toBe(false)
    expect(isPressed('UAH')).toBe(true)
    expect(isPressed('USD')).toBe(false)
    expect(dateInput().value).toBe(TODAY)
    expect(repeatSelect().value).toBe('none')
    expect(screen.getByTestId('drawer-save-another')).toBeTruthy()
    expect(screen.queryByTestId('drawer-delete')).toBeNull()
    expect(screen.queryByTestId('drawer-recurring-note')).toBeNull()
  })

  it('offers the four repeat options', () => {
    renderDrawer()

    expect(Array.from(repeatSelect().options).map((o) => o.value)).toEqual([
      'none',
      'week',
      'month',
      'year',
    ])
    expect(Array.from(repeatSelect().options).map((o) => o.textContent)).toEqual([
      "Don't repeat",
      'Weekly',
      'Monthly',
      'Yearly',
    ])
  })

  it('starts in the main currency, whichever it is', () => {
    renderDrawer({ mainCurrency: 'EUR' })

    expect(isPressed('EUR')).toBe(true)
    expect(isPressed('UAH')).toBe(false)
  })

  it('has no category selected when there are no categories', () => {
    renderDrawer({ categories: [] })

    expect(screen.getByTestId('drawer-category-group').querySelectorAll('button')).toHaveLength(0)
  })
})

describe('ExpenseDrawer: category chips', () => {
  it('is a labelled radio group of radio chips', () => {
    renderDrawer()

    const group = screen.getByTestId('drawer-category-group')
    expect(group.getAttribute('role')).toBe('radiogroup')
    expect(group.getAttribute('aria-label')).toBe('Category')
    for (const c of CATEGORIES) {
      const el = chip(c.id)
      expect(el.getAttribute('role')).toBe('radio')
      expect(el.textContent).toContain(c.name)
      expect(el.textContent).toContain(c.icon)
    }
  })

  it('selects a chip on click', () => {
    renderDrawer()

    fireEvent.click(chip('cat-coffee'))

    expect(isChecked('cat-coffee')).toBe(true)
    expect(isChecked('cat-food')).toBe(false)
  })

  it('uses a roving tab index: 0 on the checked chip, -1 on the others', () => {
    renderDrawer()

    expect(chip('cat-food').getAttribute('tabindex')).toBe('0')
    expect(chip('cat-coffee').getAttribute('tabindex')).toBe('-1')
    expect(chip('cat-server').getAttribute('tabindex')).toBe('-1')
  })

  it('arrow keys move the focus without selecting, and wrap around', () => {
    renderDrawer()
    act(() => {
      chip('cat-food').focus()
    })

    fireEvent.keyDown(chip('cat-food'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(chip('cat-coffee'))
    expect(isChecked('cat-food')).toBe(true)
    expect(isChecked('cat-coffee')).toBe(false)
    expect(chip('cat-coffee').getAttribute('tabindex')).toBe('0')
    expect(chip('cat-food').getAttribute('tabindex')).toBe('-1')

    fireEvent.keyDown(chip('cat-coffee'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(chip('cat-server'))

    fireEvent.keyDown(chip('cat-server'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(chip('cat-food'))

    fireEvent.keyDown(chip('cat-food'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(chip('cat-server'))

    fireEvent.keyDown(chip('cat-server'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(chip('cat-coffee'))
    expect(isChecked('cat-food')).toBe(true)
  })

  it('Enter and Space select the focused chip', () => {
    renderDrawer()
    act(() => {
      chip('cat-coffee').focus()
    })

    const enterPrevented = fireEvent.keyDown(chip('cat-coffee'), { key: 'Enter' })
    expect(enterPrevented).toBe(false)
    expect(isChecked('cat-coffee')).toBe(true)

    fireEvent.keyDown(chip('cat-server'), { key: ' ' })
    expect(isChecked('cat-server')).toBe(true)
    expect(isChecked('cat-coffee')).toBe(false)
  })
})

describe('ExpenseDrawer: currency rules (add mode)', () => {
  it('a category with a default currency switches the currency', () => {
    renderDrawer()

    fireEvent.click(chip('cat-server'))

    expect(isPressed('USD')).toBe(true)
    expect(isPressed('UAH')).toBe(false)
  })

  it('switches back to the main currency for a category without a default', () => {
    renderDrawer()
    fireEvent.click(chip('cat-server'))

    fireEvent.click(chip('cat-food'))

    expect(isPressed('UAH')).toBe(true)
    expect(isPressed('USD')).toBe(false)
  })

  it('a currency tapped first is kept when a category is picked', () => {
    renderDrawer()
    fireEvent.click(screen.getByTestId('drawer-currency-EUR'))

    fireEvent.click(chip('cat-server'))

    expect(isPressed('EUR')).toBe(true)
    expect(isPressed('USD')).toBe(false)
  })

  it('tapping the already selected currency also counts as a choice', () => {
    renderDrawer()
    fireEvent.click(screen.getByTestId('drawer-currency-UAH'))

    fireEvent.click(chip('cat-server'))

    expect(isPressed('UAH')).toBe(true)
    expect(isPressed('USD')).toBe(false)
  })

  it('the first category of the list counts for the default currency of an add', () => {
    renderDrawer({
      categories: [CATEGORIES[2], CATEGORIES[0]],
    })

    expect(isPressed('USD')).toBe(true)
  })

  it('saves the tapped currency', async () => {
    renderDrawer()
    setAmount('10')
    fireEvent.click(screen.getByTestId('drawer-currency-USD'))

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(addCall().currency).toBe('USD')
  })
})

describe('ExpenseDrawer: initial values', () => {
  it('prefills every field from initial', () => {
    renderDrawer({
      initial: {
        categoryId: 'cat-coffee',
        amount: '12.5',
        currency: 'EUR',
        description: 'Tea',
      },
    })

    expect(amountInput().value).toBe('12.5')
    expect(descriptionInput().value).toBe('Tea')
    expect(isChecked('cat-coffee')).toBe(true)
    expect(isPressed('EUR')).toBe(true)
  })

  it('falls back to the first category when initial names an unknown one', () => {
    renderDrawer({ initial: { categoryId: 'gone', amount: '3' } })

    expect(isChecked('cat-food')).toBe(true)
    expect(amountInput().value).toBe('3')
  })

  it('a currency from initial counts as chosen, so a category pick keeps it', () => {
    renderDrawer({ initial: { currency: 'EUR' } })

    fireEvent.click(chip('cat-server'))

    expect(isPressed('EUR')).toBe(true)
    expect(isPressed('USD')).toBe(false)
  })

  it('without a currency in initial a category pick still switches it', () => {
    renderDrawer({ initial: { amount: '3' } })

    fireEvent.click(chip('cat-server'))

    expect(isPressed('USD')).toBe(true)
  })

  it('saves what was prefilled', async () => {
    renderDrawer({
      initial: {
        categoryId: 'cat-coffee',
        amount: '65',
        currency: 'UAH',
        description: 'Coffee',
      },
    })

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(addCall()).toEqual({
      amount: 65,
      currency: 'UAH',
      categoryId: 'cat-coffee',
      description: 'Coffee',
    })
  })
})

describe('ExpenseDrawer: saving in add mode', () => {
  it('saves 65 UAH Coffee dated today, then closes and reports success', async () => {
    const { onOpenChange, invalidate } = renderDrawer()
    fireEvent.click(chip('cat-coffee'))
    setAmount('65')
    setDescription('Coffee')

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(addExpense).toHaveBeenCalledTimes(1)
    expect(addCall()).toEqual({
      amount: 65,
      currency: 'UAH',
      categoryId: 'cat-coffee',
      description: 'Coffee',
    })
    expect(addCall()).not.toHaveProperty('createdAt')
    expect(addRepeatingExpense).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('Expense saved')
    const keys = invalidatedKeys(invalidate)
    expect(keys).toEqual(expect.arrayContaining([['expenses'], ['analytics']]))
    expect(keys).not.toContainEqual(['recurring'])
  })

  it('saves different values differently', async () => {
    renderDrawer()
    fireEvent.click(chip('cat-server'))
    setAmount('7.25')

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(addCall()).toEqual({
      amount: 7.25,
      currency: 'USD',
      categoryId: 'cat-server',
    })
    expect(addCall().description).toBeUndefined()
  })

  it('accepts a decimal comma', async () => {
    renderDrawer()
    setAmount('12,5')

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(addCall().amount).toBe(12.5)
  })

  it('trims the description and leaves it out when blank', async () => {
    renderDrawer()
    setAmount('5')
    setDescription('   ')

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(addCall().description).toBeUndefined()
  })

  it('Enter in the amount saves', async () => {
    const { onOpenChange } = renderDrawer()
    setAmount('65')

    fireEvent.keyDown(amountInput(), { key: 'Enter' })

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(addCall().amount).toBe(65)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('Enter in the description saves', async () => {
    renderDrawer()
    setAmount('40')
    setDescription('Taxi')

    fireEvent.keyDown(descriptionInput(), { key: 'Enter' })

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(addCall()).toMatchObject({ amount: 40, description: 'Taxi' })
  })

  it.each([
    ['0', /greater than 0/i],
    ['-5', /greater than 0/i],
  ])('shows an inline amount error for "%s" and does not save', (value, message) => {
    renderDrawer()
    setAmount(value)

    fireEvent.click(screen.getByTestId('drawer-save'))

    expect(screen.getByTestId('drawer-error-amount').textContent).toMatch(message)
    expect(addExpense).not.toHaveBeenCalled()
    expect(amountInput().value).toBe(value)
  })

  it.each(['', 'abc', '1.2.3'])(
    'shows an inline amount error for the unusable amount "%s"',
    (value) => {
      renderDrawer()
      setAmount(value)

      fireEvent.click(screen.getByTestId('drawer-save'))

      expect(screen.getByTestId('drawer-error-amount').textContent).not.toBe('')
      expect(addExpense).not.toHaveBeenCalled()
    },
  )

  it('shows no errors before the first save attempt', () => {
    renderDrawer()

    expect(screen.queryByTestId('drawer-error-amount')).toBeNull()
    expect(screen.queryByTestId('drawer-error-categoryId')).toBeNull()
    expect(screen.queryByTestId('drawer-error-createdAt')).toBeNull()
  })

  it('shows a category error when there are no categories', () => {
    renderDrawer({ categories: [] })
    setAmount('5')

    fireEvent.click(screen.getByTestId('drawer-save'))

    expect(screen.getByTestId('drawer-error-categoryId').textContent).toBe(
      'Category is required',
    )
    expect(addExpense).not.toHaveBeenCalled()
  })

  it('shows a date error for an empty date', () => {
    renderDrawer()
    setAmount('5')
    setDate('')

    fireEvent.click(screen.getByTestId('drawer-save'))

    expect(screen.getByTestId('drawer-error-createdAt').textContent).toBe(
      'Date is required',
    )
    expect(addExpense).not.toHaveBeenCalled()
  })

  it('stamps a past date with the current time of day', async () => {
    renderDrawer()
    setAmount('5')
    const past = dayjs().subtract(3, 'day').format('YYYY-MM-DD')
    setDate(past)

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    const { createdAt } = addCall()
    expect(createdAt).toBeDefined()
    expect(dayjs(createdAt).format('YYYY-MM-DD')).toBe(past)
  })

  it('shows a future-date hint only for a later date', () => {
    renderDrawer()
    expect(screen.queryByTestId('drawer-future-hint')).toBeNull()

    setDate(dayjs().subtract(2, 'day').format('YYYY-MM-DD'))
    expect(screen.queryByTestId('drawer-future-hint')).toBeNull()

    setDate(dayjs().add(3, 'day').format('YYYY-MM-DD'))
    expect(screen.getByTestId('drawer-future-hint').textContent).toBe('Future date')

    setDate(TODAY)
    expect(screen.queryByTestId('drawer-future-hint')).toBeNull()
  })

  it('saves a future date as it is', async () => {
    renderDrawer()
    setAmount('5')
    const future = dayjs().add(3, 'day').format('YYYY-MM-DD')
    setDate(future)

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(dayjs(addCall().createdAt).format('YYYY-MM-DD')).toBe(future)
  })

  it('reports a failed save, keeps the values and stays open', async () => {
    vi.mocked(addExpense).mockRejectedValue(new Error('disk full'))
    const { onOpenChange } = renderDrawer()
    setAmount('65')
    setDescription('Coffee')

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save: disk full')
    })
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(amountInput().value).toBe('65')
    expect(descriptionInput().value).toBe('Coffee')
    expect(screen.getByTestId('drawer-save').hasAttribute('disabled')).toBe(false)
  })

  it('disables the buttons while saving and ignores a second submit', async () => {
    const pending = deferred<Expense>()
    vi.mocked(addExpense).mockReturnValue(pending.promise)
    const { onOpenChange } = renderDrawer()
    setAmount('65')

    fireEvent.click(screen.getByTestId('drawer-save'))
    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))

    await waitFor(() => {
      expect(screen.getByTestId<HTMLButtonElement>('drawer-save').disabled).toBe(true)
    })
    expect(screen.getByTestId<HTMLButtonElement>('drawer-save-another').disabled).toBe(
      true,
    )
    expect(screen.getByTestId<HTMLButtonElement>('drawer-cancel').disabled).toBe(true)
    fireEvent.click(screen.getByTestId('drawer-save'))
    fireEvent.keyDown(amountInput(), { key: 'Enter' })
    expect(addExpense).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.resolve(saved())
      await pending.promise
    })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(addExpense).toHaveBeenCalledTimes(1)
  })
})

describe('ExpenseDrawer: Save & add another', () => {
  it('keeps the drawer open, clears amount and description, keeps the rest and refocuses the amount', async () => {
    const { onOpenChange } = renderDrawer()
    fireEvent.click(chip('cat-coffee'))
    fireEvent.click(screen.getByTestId('drawer-currency-EUR'))
    const past = dayjs().subtract(1, 'day').format('YYYY-MM-DD')
    setDate(past)
    setAmount('5')
    setDescription('Tea')

    fireEvent.click(screen.getByTestId('drawer-save-another'))

    await waitFor(() => expect(amountInput().value).toBe(''))
    expect(addExpense).toHaveBeenCalledTimes(1)
    expect(addCall()).toMatchObject({
      amount: 5,
      currency: 'EUR',
      categoryId: 'cat-coffee',
      description: 'Tea',
    })
    expect(toast.success).toHaveBeenCalledWith('Expense saved')
    expect(descriptionInput().value).toBe('')
    expect(isChecked('cat-coffee')).toBe(true)
    expect(isPressed('EUR')).toBe(true)
    expect(dateInput().value).toBe(past)
    await waitFor(() => expect(document.activeElement).toBe(amountInput()))
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('keeps the touched flags: a later category pick still keeps the tapped currency', async () => {
    renderDrawer()
    fireEvent.click(screen.getByTestId('drawer-currency-EUR'))
    setAmount('5')
    fireEvent.click(screen.getByTestId('drawer-save-another'))
    await waitFor(() => expect(amountInput().value).toBe(''))

    fireEvent.click(chip('cat-server'))

    expect(isPressed('EUR')).toBe(true)
  })

  it('saves a second expense from the same drawer', async () => {
    renderDrawer()
    setAmount('5')
    fireEvent.click(screen.getByTestId('drawer-save-another'))
    await waitFor(() => expect(amountInput().value).toBe(''))

    setAmount('9')
    fireEvent.click(screen.getByTestId('drawer-save-another'))

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(2))
    expect(vi.mocked(addExpense).mock.calls[1][0].amount).toBe(9)
  })

  it('does not clear the form when the save fails', async () => {
    vi.mocked(addExpense).mockRejectedValue(new Error('boom'))
    renderDrawer()
    setAmount('5')
    setDescription('Tea')

    fireEvent.click(screen.getByTestId('drawer-save-another'))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(amountInput().value).toBe('5')
    expect(descriptionInput().value).toBe('Tea')
  })

  it('sets Repeat back to none', async () => {
    renderDrawer()
    setAmount('5')
    fireEvent.change(repeatSelect(), { target: { value: 'week' } })

    fireEvent.click(screen.getByTestId('drawer-save-another'))

    await waitFor(() => expect(amountInput().value).toBe(''))
    expect(addRepeatingExpense).toHaveBeenCalledTimes(1)
    expect(repeatSelect().value).toBe('none')
    expect(dateInput().disabled).toBe(false)
  })
})

describe('ExpenseDrawer: Repeat', () => {
  it('fixes the date to today and disables it while a repeat is chosen', () => {
    renderDrawer()
    setDate(dayjs().subtract(4, 'day').format('YYYY-MM-DD'))

    fireEvent.change(repeatSelect(), { target: { value: 'month' } })

    expect(dateInput().value).toBe(TODAY)
    expect(dateInput().disabled).toBe(true)
    expect(screen.getByTestId('expense-drawer').textContent).toContain(
      'Repeating entries start today',
    )

    fireEvent.change(repeatSelect(), { target: { value: 'none' } })
    expect(dateInput().disabled).toBe(false)
  })

  it.each(['week', 'month', 'year'] as const)(
    'Repeat = %s saves with addRepeatingExpense only',
    async (unit) => {
      const { invalidate, onOpenChange } = renderDrawer()
      fireEvent.click(chip('cat-coffee'))
      setAmount('45')
      setDescription('Gym')
      fireEvent.change(repeatSelect(), { target: { value: unit } })

      fireEvent.click(screen.getByTestId('drawer-save'))

      await waitFor(() => expect(addRepeatingExpense).toHaveBeenCalledTimes(1))
      const [input, repeat] = vi.mocked(addRepeatingExpense).mock.calls[0]
      expect(repeat).toBe(unit)
      expect(input).toEqual({
        amount: 45,
        currency: 'UAH',
        categoryId: 'cat-coffee',
        description: 'Gym',
      })
      expect(input).not.toHaveProperty('createdAt')
      expect(addExpense).not.toHaveBeenCalled()
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
      expect(invalidatedKeys(invalidate)).toEqual(
        expect.arrayContaining([['expenses'], ['analytics'], ['recurring']]),
      )
    },
  )

  it('reports a failed repeating save', async () => {
    vi.mocked(addRepeatingExpense).mockRejectedValue(new Error('nope'))
    const { onOpenChange } = renderDrawer()
    setAmount('5')
    fireEvent.change(repeatSelect(), { target: { value: 'week' } })

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save: nope')
    })
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

describe('ExpenseDrawer: Cancel and Escape', () => {
  it('Cancel closes without saving', () => {
    const { onOpenChange } = renderDrawer()
    setAmount('65')

    fireEvent.click(screen.getByTestId('drawer-cancel'))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(addExpense).not.toHaveBeenCalled()
    expect(addRepeatingExpense).not.toHaveBeenCalled()
  })

  it('Escape closes without saving', () => {
    const { onOpenChange } = renderDrawer()
    setAmount('65')

    fireEvent.keyDown(amountInput(), { key: 'Escape' })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(addExpense).not.toHaveBeenCalled()
  })

  it('Escape with an open suggestion list closes only the list', () => {
    const entries = [saved({ id: 's1', description: 'Coffee', categoryId: 'cat-coffee' })]
    const { onOpenChange } = renderDrawer({ entries })
    act(() => {
      descriptionInput().focus()
    })
    expect(screen.getByTestId('drawer-suggestions')).toBeTruthy()

    fireEvent.keyDown(descriptionInput(), { key: 'Escape' })

    expect(screen.queryByTestId('drawer-suggestions')).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()

    fireEvent.keyDown(descriptionInput(), { key: 'Escape' })

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('ExpenseDrawer: suggestions', () => {
  const entries = [
    saved({
      id: 's1',
      description: 'Coffee',
      categoryId: 'cat-coffee',
      amount: 65,
      currency: 'EUR',
    }),
  ]

  function openList() {
    fireEvent.focus(descriptionInput())
  }

  it('lists suggestions on focus, with the amount hint', () => {
    renderDrawer({ entries })

    openList()

    expect(screen.getAllByTestId('drawer-suggestion')).toHaveLength(1)
    expect(screen.getByTestId('drawer-suggestion-amount').textContent).toBe(
      'last: 65 EUR',
    )
  })

  it('a plain pick fills the description, category and currency, but not the amount', () => {
    renderDrawer({ entries })
    openList()

    fireEvent.click(screen.getByTestId('drawer-suggestion'))

    expect(descriptionInput().value).toBe('Coffee')
    expect(isChecked('cat-coffee')).toBe(true)
    expect(isPressed('EUR')).toBe(true)
    expect(amountInput().value).toBe('')
  })

  it('the hint chip also fills the amount', () => {
    renderDrawer({ entries })
    openList()

    fireEvent.click(screen.getByTestId('drawer-suggestion-amount'))

    expect(descriptionInput().value).toBe('Coffee')
    expect(amountInput().value).toBe('65')
    expect(isChecked('cat-coffee')).toBe(true)
  })

  it('the suggested currency wins over the category default', () => {
    renderDrawer({
      entries: [
        saved({
          id: 's2',
          description: 'Hosting',
          categoryId: 'cat-server',
          currency: 'EUR',
        }),
      ],
    })
    openList()

    fireEvent.click(screen.getByTestId('drawer-suggestion'))

    expect(isChecked('cat-server')).toBe(true)
    expect(isPressed('EUR')).toBe(true)
  })

  it('keeps a category the user picked, but still sets the untouched currency', () => {
    renderDrawer({ entries })
    fireEvent.click(chip('cat-server'))
    expect(isPressed('USD')).toBe(true)
    openList()

    fireEvent.click(screen.getByTestId('drawer-suggestion'))

    expect(isChecked('cat-server')).toBe(true)
    expect(isChecked('cat-coffee')).toBe(false)
    expect(isPressed('EUR')).toBe(true)
  })

  it('keeps a currency the user tapped, but still sets the untouched category', () => {
    renderDrawer({ entries })
    fireEvent.click(screen.getByTestId('drawer-currency-USD'))
    openList()

    fireEvent.click(screen.getByTestId('drawer-suggestion'))

    expect(isPressed('USD')).toBe(true)
    expect(isPressed('EUR')).toBe(false)
    expect(isChecked('cat-coffee')).toBe(true)
  })

  it('keeps a category and a currency that came from initial', () => {
    renderDrawer({
      entries,
      initial: { categoryId: 'cat-food', currency: 'USD' },
    })
    openList()

    fireEvent.click(screen.getByTestId('drawer-suggestion'))

    expect(descriptionInput().value).toBe('Coffee')
    expect(isChecked('cat-food')).toBe(true)
    expect(isPressed('USD')).toBe(true)
  })

  it('a pick does not count as a choice: a later category pick still follows its default', () => {
    renderDrawer({ entries })
    openList()
    fireEvent.click(screen.getByTestId('drawer-suggestion'))
    expect(isPressed('EUR')).toBe(true)

    fireEvent.click(chip('cat-server'))

    expect(isPressed('USD')).toBe(true)
  })

  it('does not change a suggested category that no longer exists', () => {
    renderDrawer({
      entries: [saved({ id: 's3', description: 'Old', categoryId: 'deleted' })],
    })
    openList()

    fireEvent.click(screen.getByTestId('drawer-suggestion'))

    expect(descriptionInput().value).toBe('Old')
    expect(isChecked('cat-food')).toBe(true)
  })

  it('saves what the pick filled in', async () => {
    renderDrawer({ entries })
    openList()
    fireEvent.click(screen.getByTestId('drawer-suggestion-amount'))

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1))
    expect(addCall()).toEqual({
      amount: 65,
      currency: 'EUR',
      categoryId: 'cat-coffee',
      description: 'Coffee',
    })
  })
})

describe('ExpenseDrawer: edit mode', () => {
  const ORIGINAL = MARCH_15

  it('opens with the title and the values of the expense', () => {
    renderDrawer({ mode: 'edit', expense: makeExpense() })

    expect(screen.getByTestId('expense-drawer').getAttribute('data-mode')).toBe('edit')
    expect(screen.getByTestId('expense-drawer-title').textContent).toBe(
      'Edit transaction',
    )
    expect(amountInput().value).toBe('12.5')
    expect(isPressed('UAH')).toBe(true)
    expect(isChecked('cat-food')).toBe(true)
    expect(dateInput().value).toBe('2026-03-15')
    expect(descriptionInput().value).toBe('Lunch')
  })

  it('prefills another expense with its own values', () => {
    renderDrawer({
      mode: 'edit',
      expense: makeExpense({
        id: 'e2',
        amount: 40,
        currency: 'USD',
        categoryId: 'cat-coffee',
        description: 'Taxi',
        createdAt: new Date(2026, 3, 2, 9, 30, 0, 0).toISOString(),
      }),
    })

    expect(amountInput().value).toBe('40')
    expect(isPressed('USD')).toBe(true)
    expect(isPressed('UAH')).toBe(false)
    expect(isChecked('cat-coffee')).toBe(true)
    expect(dateInput().value).toBe('2026-04-02')
    expect(descriptionInput().value).toBe('Taxi')
  })

  it('shows an empty description for an expense without one', () => {
    renderDrawer({ mode: 'edit', expense: makeExpense({ description: null }) })

    expect(descriptionInput().value).toBe('')
  })

  it('has Save, Delete and Cancel, but no Repeat and no Save & add another', () => {
    renderDrawer({ mode: 'edit', expense: makeExpense() })

    expect(screen.getByTestId('drawer-save')).toBeTruthy()
    expect(screen.getByTestId('drawer-delete')).toBeTruthy()
    expect(screen.getByTestId('drawer-cancel')).toBeTruthy()
    expect(screen.queryByTestId('drawer-repeat')).toBeNull()
    expect(screen.queryByTestId('drawer-save-another')).toBeNull()
  })

  it('saves unchanged values with the original timestamp', async () => {
    const { onOpenChange, invalidate } = renderDrawer({
      mode: 'edit',
      expense: makeExpense(),
    })

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(updateExpense).toHaveBeenCalledTimes(1))
    expect(updateExpense).toHaveBeenCalledWith(
      'e1',
      ORIGINAL,
      expect.objectContaining({
        amount: 12.5,
        currency: 'UAH',
        categoryId: 'cat-food',
        description: 'Lunch',
        createdAt: ORIGINAL,
      }),
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(toast.success).toHaveBeenCalledWith('Transaction updated')
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([['expenses'], ['analytics']]),
    )
    expect(addExpense).not.toHaveBeenCalled()
  })

  it('saves an edited amount, keyed by id and the original createdAt', async () => {
    renderDrawer({ mode: 'edit', expense: makeExpense() })
    setAmount('42.5')

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(updateExpense).toHaveBeenCalledTimes(1))
    expect(updateExpense).toHaveBeenCalledWith(
      'e1',
      ORIGINAL,
      expect.objectContaining({ amount: 42.5, createdAt: ORIGINAL }),
    )
  })

  it('saves a different amount differently and accepts a comma', async () => {
    renderDrawer({ mode: 'edit', expense: makeExpense() })
    setAmount('7,25')

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(updateExpense).toHaveBeenCalledTimes(1))
    expect(vi.mocked(updateExpense).mock.calls[0][2].amount).toBe(7.25)
  })

  it('Enter in the amount saves', async () => {
    renderDrawer({ mode: 'edit', expense: makeExpense() })
    setAmount('99')

    fireEvent.keyDown(amountInput(), { key: 'Enter' })

    await waitFor(() => expect(updateExpense).toHaveBeenCalledTimes(1))
    expect(vi.mocked(updateExpense).mock.calls[0][2].amount).toBe(99)
  })

  it('saves the new category and currency', async () => {
    renderDrawer({ mode: 'edit', expense: makeExpense() })
    fireEvent.click(chip('cat-coffee'))
    fireEvent.click(screen.getByTestId('drawer-currency-EUR'))

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(updateExpense).toHaveBeenCalledTimes(1))
    expect(vi.mocked(updateExpense).mock.calls[0][2]).toMatchObject({
      categoryId: 'cat-coffee',
      currency: 'EUR',
    })
  })

  it('does not change the stored currency when the category changes', async () => {
    renderDrawer({ mode: 'edit', expense: makeExpense() })

    fireEvent.click(chip('cat-server'))

    expect(isPressed('UAH')).toBe(true)
    expect(isPressed('USD')).toBe(false)
    fireEvent.click(screen.getByTestId('drawer-save'))
    await waitFor(() => expect(updateExpense).toHaveBeenCalledTimes(1))
    expect(vi.mocked(updateExpense).mock.calls[0][2]).toMatchObject({
      categoryId: 'cat-server',
      currency: 'UAH',
    })
  })

  it('sends an empty string for a cleared description', async () => {
    renderDrawer({ mode: 'edit', expense: makeExpense() })
    setDescription('')

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(updateExpense).toHaveBeenCalledTimes(1))
    expect(vi.mocked(updateExpense).mock.calls[0][2].description).toBe('')
  })

  it('moves to another month keeping the original local time of day', async () => {
    renderDrawer({ mode: 'edit', expense: makeExpense() })
    setDate('2026-04-10')

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => expect(updateExpense).toHaveBeenCalledTimes(1))
    const [id, originalCreatedAt, patch] = vi.mocked(updateExpense).mock.calls[0]
    expect(id).toBe('e1')
    expect(originalCreatedAt).toBe(ORIGINAL)
    expect(patch.createdAt).not.toBe(ORIGINAL)
    const moved = dayjs(patch.createdAt)
    expect(moved.format('YYYY-MM-DD')).toBe('2026-04-10')
    expect(moved.hour()).toBe(12)
    expect(moved.minute()).toBe(0)
  })

  it.each(['0', '-5'])('shows an inline amount error for "%s" and does not save', (value) => {
    const { onOpenChange } = renderDrawer({ mode: 'edit', expense: makeExpense() })
    setAmount(value)

    fireEvent.click(screen.getByTestId('drawer-save'))

    expect(screen.getByTestId('drawer-error-amount').textContent).toMatch(
      /greater than 0/i,
    )
    expect(updateExpense).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(amountInput().value).toBe(value)
  })

  it('shows a date error for an empty date', () => {
    renderDrawer({ mode: 'edit', expense: makeExpense() })
    setDate('')

    fireEvent.click(screen.getByTestId('drawer-save'))

    expect(screen.getByTestId('drawer-error-createdAt')).toBeTruthy()
    expect(updateExpense).not.toHaveBeenCalled()
  })

  it('reports a failed save, keeps the values and stays open', async () => {
    vi.mocked(updateExpense).mockRejectedValue(new Error('network down'))
    const { onOpenChange } = renderDrawer({ mode: 'edit', expense: makeExpense() })
    setAmount('55')

    fireEvent.click(screen.getByTestId('drawer-save'))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to update: network down')
    })
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(amountInput().value).toBe('55')
  })

  it('Escape closes without saving the edits', () => {
    const { onOpenChange } = renderDrawer({ mode: 'edit', expense: makeExpense() })
    setAmount('999')

    fireEvent.keyDown(amountInput(), { key: 'Escape' })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(updateExpense).not.toHaveBeenCalled()
  })

  it('Cancel closes without saving the edits', () => {
    const { onOpenChange } = renderDrawer({ mode: 'edit', expense: makeExpense() })
    setAmount('999')

    fireEvent.click(screen.getByTestId('drawer-cancel'))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(updateExpense).not.toHaveBeenCalled()
  })

  it('a suggestion pick does not change the category or currency of a stored record', () => {
    const entries = [
      saved({ id: 's1', description: 'Lunch', categoryId: 'cat-coffee', currency: 'EUR' }),
    ]
    renderDrawer({ mode: 'edit', expense: makeExpense(), entries })
    act(() => {
      descriptionInput().focus()
    })

    fireEvent.click(screen.getByTestId('drawer-suggestion'))

    expect(isChecked('cat-food')).toBe(true)
    expect(isPressed('UAH')).toBe(true)
  })
})

describe('ExpenseDrawer: edit mode information', () => {
  const usd = (overrides: Partial<Expense> = {}) =>
    makeExpense({
      amount: 40,
      currency: 'USD',
      conversion: {
        mainCurrency: 'UAH',
        rate: 41.52,
        mainAmount: 1660.8,
        rateDate: '2026-10-14',
        source: 'nbu',
      },
      ...overrides,
    })

  it('notes that a recurring record only changes this entry', () => {
    renderDrawer({ mode: 'edit', expense: makeExpense({ recurringId: 'r1' }) })

    expect(screen.getByTestId('drawer-recurring-note').textContent).toBe(
      'From a recurring item. Changes apply only to this entry.',
    )
  })

  it('shows no recurring note for an ordinary record', () => {
    renderDrawer({ mode: 'edit', expense: makeExpense() })

    expect(screen.queryByTestId('drawer-recurring-note')).toBeNull()
  })

  it('shows the stored conversion read-only', () => {
    renderDrawer({ mode: 'edit', expense: usd() })

    expect(screen.getByTestId('drawer-conversion-info').textContent).toBe(
      `≈ ${formatMoney(1660.8, 'UAH')} · NBU · 14 Oct`,
    )
  })

  it('names a manual rate and upper-cases any other source', () => {
    const manual = renderDrawer({
      mode: 'edit',
      expense: usd({
        conversion: {
          mainCurrency: 'UAH',
          rate: 40,
          mainAmount: 1600,
          rateDate: '2026-10-02',
          source: 'manual',
        },
      }),
    })
    expect(screen.getByTestId('drawer-conversion-info').textContent).toBe(
      `≈ ${formatMoney(1600, 'UAH')} · Manual rate · 2 Oct`,
    )
    manual.unmount()

    renderDrawer({
      mode: 'edit',
      expense: usd({
        conversion: {
          mainCurrency: 'UAH',
          rate: 40,
          mainAmount: 1600,
          rateDate: '2026-10-02',
          source: 'ecb',
        },
      }),
    })
    expect(screen.getByTestId('drawer-conversion-info').textContent).toContain(
      '· ECB ·',
    )
  })

  it('shows no conversion for a main-currency record', () => {
    renderDrawer({ mode: 'edit', expense: makeExpense() })

    expect(screen.queryByTestId('drawer-conversion-info')).toBeNull()
  })

  it('shows no conversion when it is not into the current main currency', () => {
    renderDrawer({
      mode: 'edit',
      expense: usd({
        conversion: {
          mainCurrency: 'EUR',
          rate: 0.9,
          mainAmount: 36,
          rateDate: '2026-10-14',
          source: 'nbu',
        },
      }),
    })

    expect(screen.queryByTestId('drawer-conversion-info')).toBeNull()
  })

  it('shows no conversion for a foreign record that has none yet', () => {
    renderDrawer({ mode: 'edit', expense: usd({ conversion: undefined }) })

    expect(screen.queryByTestId('drawer-conversion-info')).toBeNull()
  })

  it('says the entry will be recalculated once the amount, currency or date differ', () => {
    renderDrawer({ mode: 'edit', expense: usd() })
    expect(screen.queryByTestId('drawer-recalc-note')).toBeNull()

    setAmount('41')
    expect(screen.getByTestId('drawer-recalc-note').textContent).toBe(
      'Will be recalculated',
    )

    setAmount('40')
    expect(screen.queryByTestId('drawer-recalc-note')).toBeNull()

    fireEvent.click(screen.getByTestId('drawer-currency-EUR'))
    expect(screen.getByTestId('drawer-recalc-note')).toBeTruthy()

    fireEvent.click(screen.getByTestId('drawer-currency-USD'))
    expect(screen.queryByTestId('drawer-recalc-note')).toBeNull()

    setDate('2026-03-20')
    expect(screen.getByTestId('drawer-recalc-note')).toBeTruthy()
  })

  it('shows no recalculation note without a conversion', () => {
    renderDrawer({ mode: 'edit', expense: makeExpense() })

    setAmount('99')

    expect(screen.queryByTestId('drawer-recalc-note')).toBeNull()
  })
})

describe('ExpenseDrawer: delete', () => {
  it('asks first and deletes nothing yet', () => {
    renderDrawer({ mode: 'edit', expense: makeExpense() })

    fireEvent.click(screen.getByTestId('drawer-delete'))

    expect(screen.getByTestId('drawer-delete-confirm').textContent).toBe('Delete')
    expect(screen.getByTestId('drawer-delete-cancel')).toBeTruthy()
    expect(deleteExpense).not.toHaveBeenCalled()
  })

  it('cancelling the question deletes nothing and keeps the drawer open', async () => {
    const { onOpenChange } = renderDrawer({ mode: 'edit', expense: makeExpense() })
    fireEvent.click(screen.getByTestId('drawer-delete'))

    fireEvent.click(screen.getByTestId('drawer-delete-cancel'))

    await waitFor(() => {
      expect(screen.queryByTestId('drawer-delete-confirm')).toBeNull()
    })
    expect(deleteExpense).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('expense-drawer')).toBeTruthy()
  })

  it('confirming deletes exactly that record, then closes', async () => {
    const { onOpenChange, invalidate } = renderDrawer({
      mode: 'edit',
      expense: makeExpense({ id: 'e7', createdAt: MARCH_15 }),
    })
    fireEvent.click(screen.getByTestId('drawer-delete'))

    fireEvent.click(screen.getByTestId('drawer-delete-confirm'))

    await waitFor(() => expect(deleteExpense).toHaveBeenCalledTimes(1))
    expect(deleteExpense).toHaveBeenCalledWith('e7', MARCH_15)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(toast.success).toHaveBeenCalledWith('Transaction deleted')
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([['expenses'], ['analytics']]),
    )
  })

  it('reports a failed delete and stays open', async () => {
    vi.mocked(deleteExpense).mockRejectedValue(new Error('locked'))
    const { onOpenChange } = renderDrawer({ mode: 'edit', expense: makeExpense() })
    fireEvent.click(screen.getByTestId('drawer-delete'))

    fireEvent.click(screen.getByTestId('drawer-delete-confirm'))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete: locked')
    })
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('ExpenseRowEditor is gone', () => {
  const sources = import.meta.glob<string>(
    ['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'],
    { query: '?raw', import: 'default', eager: true },
  )

  it('is not imported or rendered by any source file', () => {
    const offenders = Object.entries(sources)
      .filter(
        ([, text]) =>
          /^import .*ExpenseRowEditor/m.test(text) ||
          /from\s+['"][^'"]*ExpenseRowEditor['"]/.test(text) ||
          /<ExpenseRowEditor[\s/>]/.test(text),
      )
      .map(([path]) => path)

    expect(Object.keys(sources).length).toBeGreaterThan(10)
    expect(offenders).toEqual([])
  })
})
