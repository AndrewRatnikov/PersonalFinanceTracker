// CONTRACT_GAP: the element type of data-testid="recurring-form-backfill" is
//   not specified (native checkbox or Radix Checkbox). The tests read its state
//   through a helper that accepts both (checked property, or aria-checked) and
//   toggle it with a click.
// CONTRACT_GAP: the numeric input types of recurring-form-amount, -interval and
//   -end-count are not specified; the tests only set their string value.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Category, CreateRecurringInput, RecurringItem } from '@/lib/domain'
import RecurringForm from '@/components/recurring/RecurringForm'

const TODAY = '2026-05-15'

const EXPENSE_CATEGORIES: Array<Category> = [
  { id: 'c1', name: 'Food', icon: '🍔' },
  { id: 'c2', name: 'Rent', icon: '🏠' },
]
const INCOME_CATEGORIES: Array<Category> = [
  { id: 'ic1', name: 'Salary', icon: '💼' },
  { id: 'ic2', name: 'Gifts', icon: '🎁' },
]

type SubmitFn = (
  input: CreateRecurringInput,
  options: { createThroughToday: boolean },
) => Promise<void>

function renderForm(
  props: Partial<{
    initial: RecurringItem
    isPending: boolean
    today: string
    expenseCategories: Array<Category>
    incomeCategories: Array<Category>
  }> = {},
) {
  const onSubmit = vi.fn<SubmitFn>().mockResolvedValue(undefined)
  const onCancel = vi.fn()
  const view = render(
    <RecurringForm
      expenseCategories={props.expenseCategories ?? EXPENSE_CATEGORIES}
      incomeCategories={props.incomeCategories ?? INCOME_CATEGORIES}
      today={props.today ?? TODAY}
      initial={props.initial}
      isPending={props.isPending}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  )
  return { onSubmit, onCancel, ...view }
}

function input(testId: string) {
  return screen.getByTestId<HTMLInputElement>(testId)
}

function select(testId: string) {
  return screen.getByTestId<HTMLSelectElement>(testId)
}

function setValue(testId: string, value: string) {
  fireEvent.change(screen.getByTestId<HTMLInputElement | HTMLSelectElement>(testId), {
    target: { value },
  })
}

function isChecked(testId: string): boolean {
  const el = screen.getByTestId(testId)
  if (el instanceof HTMLInputElement) return el.checked
  return el.getAttribute('aria-checked') === 'true'
}

function optionValues(testId: string): Array<string> {
  return Array.from(select(testId).options).map((o) => o.value)
}

function submit() {
  fireEvent.submit(screen.getByTestId('recurring-form'))
}

function item(overrides: Partial<RecurringItem> = {}): RecurringItem {
  return {
    id: 'r1',
    kind: 'income',
    amount: 1200,
    currency: 'EUR',
    categoryId: 'ic2',
    description: 'Pay',
    frequency: { unit: 'week', interval: 2 },
    startDate: '2026-02-01',
    end: { type: 'onDate', date: '2026-12-31' },
    mode: 'ask',
    paused: false,
    handledThrough: null,
    handledAhead: [],
    occurrenceCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RecurringForm defaults (create)', () => {
  it('starts as an expense, UAH, first expense category, every 1 month from today, never ending, automatic', () => {
    renderForm()

    expect(screen.getByTestId('recurring-form-kind-expense').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('recurring-form-kind-income').getAttribute('aria-pressed')).toBe('false')
    expect(select('recurring-form-currency').value).toBe('UAH')
    expect(select('recurring-form-category').value).toBe('c1')
    expect(input('recurring-form-interval').value).toBe('1')
    expect(select('recurring-form-unit').value).toBe('month')
    expect(input('recurring-form-start').value).toBe(TODAY)
    expect(select('recurring-form-end-type').value).toBe('never')
    expect(select('recurring-form-mode').value).toBe('auto')
    expect(input('recurring-form-description').value).toBe('')
  })

  it('offers the expected options in the native selects', () => {
    renderForm()

    expect(optionValues('recurring-form-unit')).toEqual(['day', 'week', 'month', 'year'])
    expect(optionValues('recurring-form-end-type')).toEqual(['never', 'onDate', 'afterCount'])
    expect(optionValues('recurring-form-mode')).toEqual(['auto', 'ask'])
    expect(optionValues('recurring-form-currency')).toEqual(['UAH', 'USD', 'EUR'])
  })

  it('labels the mode options "Add automatically" and "Ask me first"', () => {
    renderForm()

    const labels = Array.from(select('recurring-form-mode').options).map(
      (o) => o.textContent,
    )
    expect(labels).toEqual(['Add automatically', 'Ask me first'])
  })

  it('the category select lists only the expense categories', () => {
    renderForm()

    expect(optionValues('recurring-form-category')).toEqual(['c1', 'c2'])
  })

  it('shows neither the end date nor the end count for "never"', () => {
    renderForm()

    expect(screen.queryByTestId('recurring-form-end-date')).toBeNull()
    expect(screen.queryByTestId('recurring-form-end-count')).toBeNull()
  })

  it('shows no validation errors before the first submit', () => {
    renderForm()

    expect(screen.queryByTestId('recurring-form-error-amount')).toBeNull()
    expect(screen.queryByTestId('recurring-form-error-categoryId')).toBeNull()
    expect(screen.queryByTestId('recurring-form-error-interval')).toBeNull()
    expect(screen.queryByTestId('recurring-form-error-startDate')).toBeNull()
    expect(screen.queryByTestId('recurring-form-error-end')).toBeNull()
  })
})

describe('RecurringForm kind toggle', () => {
  it('switching to income swaps the category options and resets the selection', () => {
    renderForm()
    setValue('recurring-form-category', 'c2')

    fireEvent.click(screen.getByTestId('recurring-form-kind-income'))

    expect(screen.getByTestId('recurring-form-kind-income').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('recurring-form-kind-expense').getAttribute('aria-pressed')).toBe('false')
    expect(optionValues('recurring-form-category')).toEqual(['ic1', 'ic2'])
    expect(select('recurring-form-category').value).toBe('ic1')
  })

  it('switching back restores the expense categories with the first one selected', () => {
    renderForm()
    fireEvent.click(screen.getByTestId('recurring-form-kind-income'))
    setValue('recurring-form-category', 'ic2')

    fireEvent.click(screen.getByTestId('recurring-form-kind-expense'))

    expect(optionValues('recurring-form-category')).toEqual(['c1', 'c2'])
    expect(select('recurring-form-category').value).toBe('c1')
  })

  it('submits kind income with the income category id', async () => {
    const { onSubmit } = renderForm()
    fireEvent.click(screen.getByTestId('recurring-form-kind-income'))
    setValue('recurring-form-amount', '2500')

    submit()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      kind: 'income',
      categoryId: 'ic1',
      amount: 2500,
    })
  })
})

describe('RecurringForm submit (create)', () => {
  it('submits the defaults plus the amount, with description null and createThroughToday true when starting today', async () => {
    const { onSubmit } = renderForm()
    setValue('recurring-form-amount', '50')

    submit()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toEqual({
      kind: 'expense',
      amount: 50,
      currency: 'UAH',
      categoryId: 'c1',
      description: null,
      frequency: { unit: 'month', interval: 1 },
      startDate: TODAY,
      end: { type: 'never' },
      mode: 'auto',
    })
    expect(onSubmit.mock.calls[0][1]).toEqual({ createThroughToday: true })
  })

  it('submits every edited field', async () => {
    const { onSubmit } = renderForm()
    setValue('recurring-form-amount', '12.5')
    setValue('recurring-form-currency', 'USD')
    setValue('recurring-form-category', 'c2')
    setValue('recurring-form-description', 'Rent for the flat')
    setValue('recurring-form-interval', '3')
    setValue('recurring-form-unit', 'week')
    setValue('recurring-form-start', '2026-06-01')
    setValue('recurring-form-mode', 'ask')

    submit()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toEqual({
      kind: 'expense',
      amount: 12.5,
      currency: 'USD',
      categoryId: 'c2',
      description: 'Rent for the flat',
      frequency: { unit: 'week', interval: 3 },
      startDate: '2026-06-01',
      end: { type: 'never' },
      mode: 'ask',
    })
    // A start date in the future hides the checkbox, so nothing is created.
    expect(onSubmit.mock.calls[0][1]).toEqual({ createThroughToday: false })
  })

  it('an empty description is submitted as null, a typed one as typed', async () => {
    const { onSubmit } = renderForm()
    setValue('recurring-form-amount', '5')
    setValue('recurring-form-description', '')

    submit()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].description).toBeNull()

    setValue('recurring-form-description', 'Gym')
    submit()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(onSubmit.mock.calls[1][0].description).toBe('Gym')
  })

  it('end "On date" shows the date field and submits it', async () => {
    const { onSubmit } = renderForm()
    setValue('recurring-form-amount', '5')

    setValue('recurring-form-end-type', 'onDate')

    expect(screen.getByTestId('recurring-form-end-date')).toBeTruthy()
    expect(screen.queryByTestId('recurring-form-end-count')).toBeNull()
    setValue('recurring-form-end-date', '2026-12-31')
    submit()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].end).toEqual({
      type: 'onDate',
      date: '2026-12-31',
    })
  })

  it('end "After N times" shows the count field and submits it', async () => {
    const { onSubmit } = renderForm()
    setValue('recurring-form-amount', '5')

    setValue('recurring-form-end-type', 'afterCount')

    expect(screen.getByTestId('recurring-form-end-count')).toBeTruthy()
    expect(screen.queryByTestId('recurring-form-end-date')).toBeNull()
    setValue('recurring-form-end-count', '6')
    submit()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].end).toEqual({ type: 'afterCount', count: 6 })
  })

  it('switching the end back to "never" hides both fields and submits never', async () => {
    const { onSubmit } = renderForm()
    setValue('recurring-form-amount', '5')
    setValue('recurring-form-end-type', 'afterCount')

    setValue('recurring-form-end-type', 'never')

    expect(screen.queryByTestId('recurring-form-end-count')).toBeNull()
    submit()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].end).toEqual({ type: 'never' })
  })

  it('Cancel calls onCancel and does not submit', () => {
    const { onSubmit, onCancel } = renderForm()

    fireEvent.click(screen.getByTestId('recurring-form-cancel'))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('disables the submit button while pending', () => {
    renderForm({ isPending: true })

    expect(
      screen.getByTestId<HTMLButtonElement>('recurring-form-submit').disabled,
    ).toBe(true)
  })

  it('enables the submit button when not pending', () => {
    renderForm({ isPending: false })

    expect(
      screen.getByTestId<HTMLButtonElement>('recurring-form-submit').disabled,
    ).toBe(false)
  })
})

describe('RecurringForm validation', () => {
  it.each(['', '0', '-3'])('amount "%s" shows the amount error and does not submit', async (amount) => {
    const { onSubmit } = renderForm()
    setValue('recurring-form-amount', amount)

    submit()

    await screen.findByTestId('recurring-form-error-amount')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('a valid amount shows no amount error', async () => {
    const { onSubmit } = renderForm()
    setValue('recurring-form-amount', '0')
    submit()
    await screen.findByTestId('recurring-form-error-amount')

    setValue('recurring-form-amount', '10')
    submit()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('recurring-form-error-amount')).toBeNull()
  })

  it.each(['0', '366', '1.5'])('interval "%s" shows the interval error and does not submit', async (interval) => {
    const { onSubmit } = renderForm()
    setValue('recurring-form-amount', '5')
    setValue('recurring-form-interval', interval)

    submit()

    const error = await screen.findByTestId('recurring-form-error-interval')
    expect(error.textContent).toContain('1 to 365')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('an end date before the start date shows the end error', async () => {
    const { onSubmit } = renderForm()
    setValue('recurring-form-amount', '5')
    setValue('recurring-form-end-type', 'onDate')
    setValue('recurring-form-end-date', '2026-05-01')

    submit()

    const error = await screen.findByTestId('recurring-form-error-end')
    expect(error.textContent).toContain("can't be before the start date")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('an after-count of 0 shows the end error', async () => {
    const { onSubmit } = renderForm()
    setValue('recurring-form-amount', '5')
    setValue('recurring-form-end-type', 'afterCount')
    setValue('recurring-form-end-count', '0')

    submit()

    await screen.findByTestId('recurring-form-error-end')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('a cleared start date shows the start date error', async () => {
    const { onSubmit } = renderForm()
    setValue('recurring-form-amount', '5')
    setValue('recurring-form-start', '')

    submit()

    await screen.findByTestId('recurring-form-error-startDate')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows the category error when the kind has no categories', async () => {
    const { onSubmit } = renderForm({ expenseCategories: [] })
    setValue('recurring-form-amount', '5')

    submit()

    await screen.findByTestId('recurring-form-error-categoryId')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows several errors at once', async () => {
    renderForm()
    setValue('recurring-form-amount', '0')
    setValue('recurring-form-interval', '0')

    submit()

    await screen.findByTestId('recurring-form-error-amount')
    expect(screen.getByTestId('recurring-form-error-interval')).toBeTruthy()
  })
})

describe('RecurringForm backfill checkbox', () => {
  it('is shown and checked by default when the start date is today', () => {
    renderForm()

    expect(screen.getByTestId('recurring-form-backfill')).toBeTruthy()
    expect(isChecked('recurring-form-backfill')).toBe(true)
  })

  it('is unchecked when the start date is earlier than today', () => {
    renderForm()

    setValue('recurring-form-start', '2026-02-15')

    expect(screen.getByTestId('recurring-form-backfill')).toBeTruthy()
    expect(isChecked('recurring-form-backfill')).toBe(false)
  })

  it('is hidden when the start date is after today', () => {
    renderForm()

    setValue('recurring-form-start', '2026-06-01')

    expect(screen.queryByTestId('recurring-form-backfill')).toBeNull()
  })

  it('its default follows the start date until the user toggles it', () => {
    renderForm()

    setValue('recurring-form-start', '2026-02-15')
    expect(isChecked('recurring-form-backfill')).toBe(false)
    setValue('recurring-form-start', TODAY)
    expect(isChecked('recurring-form-backfill')).toBe(true)
    setValue('recurring-form-start', '2026-01-01')
    expect(isChecked('recurring-form-backfill')).toBe(false)
  })

  it('keeps the user choice when the start date changes afterwards', () => {
    renderForm()
    setValue('recurring-form-start', '2026-02-15')
    fireEvent.click(screen.getByTestId('recurring-form-backfill'))
    expect(isChecked('recurring-form-backfill')).toBe(true)

    setValue('recurring-form-start', '2026-03-15')

    expect(isChecked('recurring-form-backfill')).toBe(true)
  })

  it('is labelled "Also add occurrences up to today"', () => {
    renderForm()

    expect(screen.getByTestId('recurring-form').textContent).toContain(
      'Also add occurrences up to today',
    )
  })

  it('submits createThroughToday from the checkbox', async () => {
    const { onSubmit } = renderForm()
    setValue('recurring-form-amount', '5')
    setValue('recurring-form-start', '2026-02-15')

    submit()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][1]).toEqual({ createThroughToday: false })

    fireEvent.click(screen.getByTestId('recurring-form-backfill'))
    submit()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(onSubmit.mock.calls[1][1]).toEqual({ createThroughToday: true })
  })
})

describe('RecurringForm edit mode (initial)', () => {
  it('is prefilled from the item', () => {
    renderForm({ initial: item() })

    expect(screen.getByTestId('recurring-form-kind-income').getAttribute('aria-pressed')).toBe('true')
    expect(input('recurring-form-amount').value).toBe('1200')
    expect(select('recurring-form-currency').value).toBe('EUR')
    expect(select('recurring-form-category').value).toBe('ic2')
    expect(input('recurring-form-description').value).toBe('Pay')
    expect(input('recurring-form-interval').value).toBe('2')
    expect(select('recurring-form-unit').value).toBe('week')
    expect(input('recurring-form-start').value).toBe('2026-02-01')
    expect(select('recurring-form-end-type').value).toBe('onDate')
    expect(input('recurring-form-end-date').value).toBe('2026-12-31')
    expect(select('recurring-form-mode').value).toBe('ask')
  })

  it('prefills a different item with its own values', () => {
    renderForm({
      initial: item({
        kind: 'expense',
        categoryId: 'c2',
        amount: 80,
        currency: 'USD',
        description: null,
        frequency: { unit: 'year', interval: 1 },
        end: { type: 'afterCount', count: 4 },
        mode: 'auto',
      }),
    })

    expect(input('recurring-form-amount').value).toBe('80')
    expect(select('recurring-form-currency').value).toBe('USD')
    expect(select('recurring-form-category').value).toBe('c2')
    expect(input('recurring-form-description').value).toBe('')
    expect(select('recurring-form-unit').value).toBe('year')
    expect(select('recurring-form-end-type').value).toBe('afterCount')
    expect(input('recurring-form-end-count').value).toBe('4')
    expect(select('recurring-form-mode').value).toBe('auto')
  })

  it('does not show the backfill checkbox', () => {
    renderForm({ initial: item({ startDate: '2026-02-01' }) })

    expect(screen.queryByTestId('recurring-form-backfill')).toBeNull()
  })

  it('submits the unchanged values with createThroughToday false', async () => {
    const { onSubmit } = renderForm({ initial: item() })

    submit()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toEqual({
      kind: 'income',
      amount: 1200,
      currency: 'EUR',
      categoryId: 'ic2',
      description: 'Pay',
      frequency: { unit: 'week', interval: 2 },
      startDate: '2026-02-01',
      end: { type: 'onDate', date: '2026-12-31' },
      mode: 'ask',
    })
    expect(onSubmit.mock.calls[0][1]).toEqual({ createThroughToday: false })
  })

  it('submits an edited amount', async () => {
    const { onSubmit } = renderForm({ initial: item() })
    setValue('recurring-form-amount', '1500')

    submit()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].amount).toBe(1500)
  })
})
