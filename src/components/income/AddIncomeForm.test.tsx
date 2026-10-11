// CONTRACT_GAP: the Radix category/currency Selects cannot be driven by
// fireEvent in jsdom, so only the default (first) category is submitted; a
// different selection is not exercised.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { Category } from '@/lib/domain'
import { AddIncomeForm } from '@/components/income/AddIncomeForm'
import { addIncome } from '@/lib/localDb'

vi.mock('@/lib/localDb', () => ({
  addIncome: vi.fn(),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...rest
  }: {
    to: string
    search?: { tab?: string }
    children?: ReactNode
  }) => (
    <a href={`${to}?tab=${search?.tab}`} {...rest}>
      {children}
    </a>
  ),
}))

const SALARY: Category = { id: 'ic1', name: 'Salary', icon: '💼' }
const OTHER: Category = { id: 'ic2', name: 'Other', icon: '🪙' }
const GIFTS: Category = { id: 'ic3', name: 'Gifts', icon: '🎁' }

function wrap(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

function renderForm(categories: Array<Category>, onSuccess = vi.fn()) {
  const view = render(
    wrap(<AddIncomeForm categories={categories} onSuccess={onSuccess} />),
  )
  return { onSuccess, ...view }
}

function fillAndSubmit(amount: string, description = '') {
  fireEvent.change(screen.getByTestId('income-form-amount'), {
    target: { value: amount },
  })
  if (description) {
    fireEvent.change(screen.getByTestId('income-form-description'), {
      target: { value: description },
    })
  }
  fireEvent.submit(screen.getByTestId('add-income-form'))
}

function submittedInput() {
  return vi.mocked(addIncome).mock.calls[0][0]
}

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

describe('AddIncomeForm with categories', () => {
  it('shows a Category field, not a Source text box', () => {
    renderForm([SALARY, OTHER])

    const form = screen.getByTestId('add-income-form')
    expect(form.textContent).toContain('Category')
    expect(form.textContent).not.toContain('Source')
    expect(screen.getByTestId('income-form-category')).toBeTruthy()
    expect(screen.queryByTestId('income-form-no-categories')).toBeNull()
  })

  it('selects the first category by default', async () => {
    renderForm([SALARY, OTHER])

    await waitFor(() => {
      expect(screen.getByTestId('income-form-category').textContent).toContain(
        'Salary',
      )
    })
    expect(screen.getByTestId('income-form-category').textContent).not.toContain(
      'Other',
    )
  })

  it('submits { categoryId, amount, currency, description } with the default category', async () => {
    const { onSuccess } = renderForm([SALARY, OTHER])

    fillAndSubmit('100', 'March')

    await waitFor(() => {
      expect(addIncome).toHaveBeenCalledTimes(1)
    })
    expect(submittedInput()).toEqual({
      categoryId: 'ic1',
      amount: 100,
      currency: 'UAH',
      description: 'March',
    })
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1)
    })
  })

  it('submits the first category of a different list and a different amount', async () => {
    renderForm([OTHER, GIFTS, SALARY])

    fillAndSubmit('42.5')

    await waitFor(() => {
      expect(addIncome).toHaveBeenCalledTimes(1)
    })
    expect(submittedInput()).toEqual({
      categoryId: 'ic2',
      amount: 42.5,
      currency: 'UAH',
    })
    expect(submittedInput()).not.toHaveProperty('source')
  })

  it('trims the description and leaves it out when blank', async () => {
    renderForm([SALARY])

    fillAndSubmit('5', '   ')

    await waitFor(() => {
      expect(addIncome).toHaveBeenCalledTimes(1)
    })
    expect(submittedInput().description).toBeUndefined()
  })

  it('picks the first category when the list arrives after the first render', async () => {
    const { rerender, onSuccess } = renderForm([])

    rerender(wrap(<AddIncomeForm categories={[GIFTS, SALARY]} onSuccess={onSuccess} />))
    await waitFor(() => {
      expect(screen.getByTestId('income-form-category').textContent).toContain(
        'Gifts',
      )
    })
    fillAndSubmit('7')

    await waitFor(() => {
      expect(addIncome).toHaveBeenCalledTimes(1)
    })
    expect(submittedInput().categoryId).toBe('ic3')
  })

  it('does not submit an invalid amount', () => {
    renderForm([SALARY])

    fillAndSubmit('0')

    expect(addIncome).not.toHaveBeenCalled()
    expect(screen.queryByTestId('income-form-category-error')).toBeNull()
  })

  it('clears the amount and description after a save but keeps the category', async () => {
    renderForm([SALARY, OTHER])

    fillAndSubmit('100', 'March')

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLInputElement>('income-form-amount').value,
      ).toBe('')
    })
    expect(
      screen.getByTestId<HTMLInputElement>('income-form-description').value,
    ).toBe('')
    expect(screen.getByTestId('income-form-category').textContent).toContain(
      'Salary',
    )
    expect(vi.mocked(toast.success)).toHaveBeenCalled()
  })

  it('reports a failed save with a toast and does not call onSuccess', async () => {
    vi.mocked(addIncome).mockRejectedValue(new Error('disk full'))
    const { onSuccess } = renderForm([SALARY])

    fillAndSubmit('100')

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalled()
    })
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain('disk full')
    expect(onSuccess).not.toHaveBeenCalled()
  })
})

describe('AddIncomeForm without categories', () => {
  it('shows the link to Settings -> Categories instead of the select', () => {
    renderForm([])

    const link = screen.getByTestId('income-form-no-categories')
    expect(link.getAttribute('href')).toBe('/settings?tab=categories')
    expect(link.textContent).toContain('Settings')
    expect(screen.queryByTestId('income-form-category')).toBeNull()
  })

  it('shows "Category is required" on submit and does not save', async () => {
    renderForm([])

    fillAndSubmit('100', 'March')

    const error = await screen.findByTestId('income-form-category-error')
    expect(error.textContent).toBe('Category is required')
    expect(addIncome).not.toHaveBeenCalled()
  })

  it('shows no category error before the first submit', () => {
    renderForm([])

    expect(screen.queryByTestId('income-form-category-error')).toBeNull()
  })
})
