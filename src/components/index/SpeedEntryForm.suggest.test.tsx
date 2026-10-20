// No CONTRACT_GAPs: the CurrencyPicker, the native category select, the
// category default currency and the description suggestions of SpeedEntryForm
// are specified in the Interface Contract (component: SpeedEntryForm) and plan
// section 6. The category control is a native select (decision D4), so it can
// be driven with fireEvent.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type {
  Category,
  CreateExpenseInput,
  Currency,
  QuickRepeat,
} from '@/lib/domain'
import type { SuggestionEntry } from '@/lib/suggestions'
import SpeedEntryForm from '@/components/index/SpeedEntryForm'

const CATEGORIES: Array<Category> = [
  { id: 'cat-food', name: 'Food', icon: '🍔' },
  { id: 'cat-coffee', name: 'Coffee', icon: '☕' },
  { id: 'cat-server', name: 'Server Costs', icon: '🖥️', defaultCurrency: 'USD' },
]

const ENTRIES: Array<SuggestionEntry> = [
  {
    description: 'Coffee',
    categoryId: 'cat-coffee',
    amount: 65,
    currency: 'EUR',
    createdAt: new Date().toISOString(),
  },
]

type SubmitFn = (data: CreateExpenseInput, repeat: QuickRepeat) => Promise<void>

function renderForm(
  props: Partial<{
    categories: Array<Category>
    entries: ReadonlyArray<SuggestionEntry>
    defaultCurrency: Currency
  }> = {},
) {
  const onSubmit = vi.fn<SubmitFn>().mockResolvedValue(undefined)
  render(
    <SpeedEntryForm
      categories={props.categories ?? CATEGORIES}
      entries={props.entries}
      defaultCurrency={props.defaultCurrency}
      onSubmit={onSubmit}
    />,
  )
  return { onSubmit }
}

const categorySelect = () =>
  screen.getByTestId<HTMLSelectElement>('speed-entry-category')
const amountInput = () => screen.getByTestId<HTMLInputElement>('speed-entry-amount')
const descriptionInput = () =>
  screen.getByTestId<HTMLInputElement>('speed-entry-description')
const isPressed = (code: string) =>
  screen.getByTestId(`speed-entry-currency-${code}`).getAttribute('aria-pressed') ===
  'true'

function pickCategory(id: string) {
  fireEvent.change(categorySelect(), { target: { value: id } })
}

function submit(amount = '10') {
  fireEvent.change(amountInput(), { target: { value: amount } })
  fireEvent.submit(screen.getByTestId('speed-entry-form'))
}

describe('SpeedEntryForm: currency picker', () => {
  it('shows the segmented currency buttons with the main currency pressed', () => {
    renderForm()

    expect(screen.getByTestId('speed-entry-currency').getAttribute('role')).toBe(
      'group',
    )
    expect(isPressed('UAH')).toBe(true)
    expect(isPressed('USD')).toBe(false)
    expect(isPressed('EUR')).toBe(false)
  })

  it('follows the defaultCurrency prop', () => {
    renderForm({ defaultCurrency: 'EUR' })

    expect(isPressed('EUR')).toBe(true)
    expect(isPressed('UAH')).toBe(false)
  })

  it('submits the tapped currency', async () => {
    const { onSubmit } = renderForm()
    fireEvent.click(screen.getByTestId('speed-entry-currency-USD'))
    expect(isPressed('USD')).toBe(true)

    submit('5')

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: 5, currency: 'USD' })
    expect(onSubmit.mock.calls[0][1]).toBe('none')
  })

  it('keeps the amount input a number field', () => {
    renderForm()

    expect(amountInput().type).toBe('number')
  })
})

describe('SpeedEntryForm: native category select', () => {
  it('is a native select with one option per category, labelled with the icon', () => {
    renderForm()

    expect(categorySelect().tagName).toBe('SELECT')
    expect(Array.from(categorySelect().options).map((o) => o.value)).toEqual([
      'cat-food',
      'cat-coffee',
      'cat-server',
    ])
    expect(Array.from(categorySelect().options).map((o) => o.textContent)).toEqual([
      '🍔 Food',
      '☕ Coffee',
      '🖥️ Server Costs',
    ])
    expect(categorySelect().value).toBe('cat-food')
  })

  it('submits the chosen category', async () => {
    const { onSubmit } = renderForm()
    pickCategory('cat-coffee')

    submit('12')

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      amount: 12,
      categoryId: 'cat-coffee',
      currency: 'UAH',
    })
  })
})

describe('SpeedEntryForm: category default currency', () => {
  it('switches the currency to the default of the picked category', () => {
    renderForm()

    pickCategory('cat-server')

    expect(isPressed('USD')).toBe(true)
    expect(isPressed('UAH')).toBe(false)
  })

  it('switches back to the main currency for a category without a default', () => {
    renderForm({ defaultCurrency: 'EUR' })
    pickCategory('cat-server')
    expect(isPressed('USD')).toBe(true)

    pickCategory('cat-food')

    expect(isPressed('EUR')).toBe(true)
  })

  it('a tapped currency is kept when the category changes', () => {
    renderForm()
    fireEvent.click(screen.getByTestId('speed-entry-currency-EUR'))

    pickCategory('cat-server')

    expect(isPressed('EUR')).toBe(true)
    expect(isPressed('USD')).toBe(false)
  })

  it('tapping the already selected currency also counts as a choice', () => {
    renderForm()
    fireEvent.click(screen.getByTestId('speed-entry-currency-UAH'))

    pickCategory('cat-server')

    expect(isPressed('UAH')).toBe(true)
  })

  it('starts with the default of the first category when it has one', () => {
    renderForm({ categories: [CATEGORIES[2], CATEGORIES[0]] })

    expect(isPressed('USD')).toBe(true)
  })

  it('submits the category default currency', async () => {
    const { onSubmit } = renderForm()
    pickCategory('cat-server')

    submit('100')

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      categoryId: 'cat-server',
      currency: 'USD',
      amount: 100,
    })
  })
})

describe('SpeedEntryForm: description suggestions', () => {
  function openList() {
    fireEvent.focus(descriptionInput())
  }

  it('shows no list without entries', () => {
    renderForm()

    openList()

    expect(screen.queryByTestId('speed-entry-suggestions')).toBeNull()
  })

  it('lists suggestions on focus and filters while typing', () => {
    renderForm({ entries: ENTRIES })

    openList()
    expect(screen.getAllByTestId('speed-entry-suggestion')).toHaveLength(1)
    expect(screen.getByTestId('speed-entry-suggestion-amount').textContent).toBe(
      'last: 65 EUR',
    )

    fireEvent.change(descriptionInput(), { target: { value: 'zzz' } })
    expect(screen.queryByTestId('speed-entry-suggestions')).toBeNull()
  })

  it('a pick fills the description, category and currency, but never the amount', () => {
    renderForm({ entries: ENTRIES })
    openList()

    fireEvent.click(screen.getByTestId('speed-entry-suggestion'))

    expect(descriptionInput().value).toBe('Coffee')
    expect(categorySelect().value).toBe('cat-coffee')
    expect(isPressed('EUR')).toBe(true)
    expect(amountInput().value).toBe('')
  })

  it('the hint chip also fills the amount', () => {
    renderForm({ entries: ENTRIES })
    openList()

    fireEvent.click(screen.getByTestId('speed-entry-suggestion-amount'))

    expect(descriptionInput().value).toBe('Coffee')
    expect(amountInput().value).toBe('65')
    expect(categorySelect().value).toBe('cat-coffee')
  })

  it('keeps a category the user changed, but still sets the untouched currency', () => {
    renderForm({ entries: ENTRIES })
    pickCategory('cat-food')
    openList()

    fireEvent.click(screen.getByTestId('speed-entry-suggestion'))

    expect(categorySelect().value).toBe('cat-food')
    expect(isPressed('EUR')).toBe(true)
  })

  it('keeps a currency the user tapped, but still sets the untouched category', () => {
    renderForm({ entries: ENTRIES })
    fireEvent.click(screen.getByTestId('speed-entry-currency-USD'))
    openList()

    fireEvent.click(screen.getByTestId('speed-entry-suggestion'))

    expect(isPressed('USD')).toBe(true)
    expect(isPressed('EUR')).toBe(false)
    expect(categorySelect().value).toBe('cat-coffee')
  })

  it('submits what the pick filled in', async () => {
    const { onSubmit } = renderForm({ entries: ENTRIES })
    openList()
    fireEvent.click(screen.getByTestId('speed-entry-suggestion'))

    submit('30')

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      amount: 30,
      currency: 'EUR',
      categoryId: 'cat-coffee',
      description: 'Coffee',
    })
  })

  it('Enter in the description does not swallow the form submit', () => {
    renderForm({ entries: ENTRIES })

    const notPrevented = fireEvent.keyDown(descriptionInput(), { key: 'Enter' })

    expect(notPrevented).toBe(true)
  })

  it('keeps the 120 character limit', () => {
    renderForm()

    expect(descriptionInput().maxLength).toBe(120)
  })
})
