// No CONTRACT_GAPs: the income category default currency, the currency trigger
// testid and the description suggestions of AddIncomeForm are specified in the
// Interface Contract (component: AddIncomeForm) and plan section 7.
//
// The Radix category and currency selects cannot be driven by fireEvent in
// jsdom, so the default currency is tested through the first category, and the
// category switch through a suggestion pick. Both triggers are only read.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { Category, Currency } from '@/lib/domain'
import type { SuggestionEntry } from '@/lib/suggestions'
import { AddIncomeForm } from '@/components/income/AddIncomeForm'
import { addIncome } from '@/lib/localDb'

vi.mock('@/lib/localDb', () => ({
  addIncome: vi.fn(),
  addRepeatingIncome: vi.fn(),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}))

const SALARY_USD: Category = {
  id: 'ic1',
  name: 'Salary',
  icon: '💼',
  defaultCurrency: 'USD',
}
const GIFTS: Category = { id: 'ic2', name: 'Gifts', icon: '🎁' }
const BONUS_EUR: Category = {
  id: 'ic3',
  name: 'Bonus',
  icon: '🎉',
  defaultCurrency: 'EUR',
}

const ENTRIES: Array<SuggestionEntry> = [
  {
    description: 'Birthday',
    categoryId: 'ic2',
    amount: 500,
    currency: 'EUR',
    createdAt: new Date().toISOString(),
  },
]

function renderForm(
  categories: Array<Category>,
  props: Partial<{
    entries: ReadonlyArray<SuggestionEntry>
    defaultCurrency: Currency
  }> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <AddIncomeForm
        categories={categories}
        onSuccess={vi.fn()}
        entries={props.entries}
        defaultCurrency={props.defaultCurrency}
      />
    </QueryClientProvider>,
  )
}

const currencyText = () => screen.getByTestId('income-form-currency').textContent
const categoryText = () => screen.getByTestId('income-form-category').textContent
const descriptionInput = () =>
  screen.getByTestId<HTMLInputElement>('income-form-description')
const amountInput = () => screen.getByTestId<HTMLInputElement>('income-form-amount')

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(addIncome).mockResolvedValue({
    id: 'i1',
    categoryId: 'ic1',
    amount: 1,
    currency: 'UAH',
    createdAt: '2026-01-01T00:00:00.000Z',
  })
})

describe('AddIncomeForm: category default currency', () => {
  it('starts with the default currency of the first category', () => {
    renderForm([SALARY_USD, GIFTS])

    expect(currencyText()).toContain('USD')
    expect(currencyText()).not.toContain('UAH')
  })

  it('a different first category gives a different currency', () => {
    renderForm([BONUS_EUR, GIFTS])

    expect(currencyText()).toContain('EUR')
    expect(currencyText()).not.toContain('USD')
  })

  it('falls back to the main currency when the first category has no default', () => {
    renderForm([GIFTS, SALARY_USD])

    expect(currencyText()).toContain('UAH')
  })

  it('falls back to the defaultCurrency prop', () => {
    renderForm([GIFTS], { defaultCurrency: 'EUR' })

    expect(currencyText()).toContain('EUR')
  })

  it('submits the category default currency', async () => {
    renderForm([SALARY_USD, GIFTS])
    fireEvent.change(amountInput(), { target: { value: '1000' } })

    fireEvent.submit(screen.getByTestId('add-income-form'))

    await waitFor(() => expect(addIncome).toHaveBeenCalledTimes(1))
    expect(vi.mocked(addIncome).mock.calls[0][0]).toMatchObject({
      categoryId: 'ic1',
      amount: 1000,
      currency: 'USD',
    })
  })

  it('follows the first category when the list arrives later', async () => {
    const client = new QueryClient()
    const view = render(
      <QueryClientProvider client={client}>
        <AddIncomeForm categories={[GIFTS]} onSuccess={vi.fn()} />
      </QueryClientProvider>,
    )
    expect(currencyText()).toContain('UAH')

    view.rerender(
      <QueryClientProvider client={client}>
        <AddIncomeForm categories={[SALARY_USD, GIFTS]} onSuccess={vi.fn()} />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(currencyText()).toContain('USD'))
    expect(categoryText()).toContain('Salary')
  })
})

describe('AddIncomeForm: description suggestions', () => {
  function openList() {
    fireEvent.focus(descriptionInput())
  }

  it('keeps the description field and shows no list without entries', () => {
    renderForm([SALARY_USD, GIFTS])

    openList()

    expect(descriptionInput().getAttribute('role')).toBe('combobox')
    expect(screen.queryByTestId('income-form-suggestions')).toBeNull()
  })

  it('lists suggestions on focus with the amount hint', () => {
    renderForm([SALARY_USD, GIFTS], { entries: ENTRIES })

    openList()

    const list = screen.getByTestId('income-form-suggestions')
    expect(list.getAttribute('role')).toBe('listbox')
    expect(screen.getAllByTestId('income-form-suggestion')).toHaveLength(1)
    expect(screen.getByTestId('income-form-suggestion-amount').textContent).toBe(
      'last: 500 EUR',
    )
  })

  it('a pick fills the description, switches the category and currency, and leaves the amount', () => {
    renderForm([SALARY_USD, GIFTS], { entries: ENTRIES })
    expect(categoryText()).toContain('Salary')
    openList()

    fireEvent.click(screen.getByTestId('income-form-suggestion'))

    expect(descriptionInput().value).toBe('Birthday')
    expect(categoryText()).toContain('Gifts')
    expect(currencyText()).toContain('EUR')
    expect(amountInput().value).toBe('')
  })

  it('the hint chip also fills the amount', () => {
    renderForm([SALARY_USD, GIFTS], { entries: ENTRIES })
    openList()

    fireEvent.click(screen.getByTestId('income-form-suggestion-amount'))

    expect(descriptionInput().value).toBe('Birthday')
    expect(amountInput().value).toBe('500')
    expect(categoryText()).toContain('Gifts')
  })

  it('submits what the pick filled in', async () => {
    renderForm([SALARY_USD, GIFTS], { entries: ENTRIES })
    openList()
    fireEvent.click(screen.getByTestId('income-form-suggestion-amount'))

    fireEvent.submit(screen.getByTestId('add-income-form'))

    await waitFor(() => expect(addIncome).toHaveBeenCalledTimes(1))
    expect(vi.mocked(addIncome).mock.calls[0][0]).toEqual({
      categoryId: 'ic2',
      amount: 500,
      currency: 'EUR',
      description: 'Birthday',
    })
  })

  it('filters while typing', () => {
    renderForm([SALARY_USD, GIFTS], {
      entries: [
        ...ENTRIES,
        {
          description: 'March salary',
          categoryId: 'ic1',
          amount: 1000,
          currency: 'USD',
          createdAt: new Date().toISOString(),
        },
      ],
    })

    fireEvent.change(descriptionInput(), { target: { value: 'birth' } })

    expect(screen.getAllByTestId('income-form-suggestion')).toHaveLength(1)
    expect(screen.getByTestId('income-form-suggestion').textContent).toContain(
      'Birthday',
    )
  })
})
