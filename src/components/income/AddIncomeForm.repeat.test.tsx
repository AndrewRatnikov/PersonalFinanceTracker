// CONTRACT_GAP: the Radix category/currency Selects cannot be driven by
// fireEvent in jsdom, so only the default (first) category and currency are
// submitted. The native income-repeat select is driven with fireEvent.change.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { Category } from '@/lib/domain'
import { AddIncomeForm } from '@/components/income/AddIncomeForm'
import { addIncome, addRepeatingIncome } from '@/lib/localDb'

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

const SALARY: Category = { id: 'ic1', name: 'Salary', icon: '💼' }
const OTHER: Category = { id: 'ic2', name: 'Other', icon: '🪙' }

const SAVED = {
  id: 'i1',
  categoryId: 'ic1',
  amount: 1,
  currency: 'UAH' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
}

let client: QueryClient

function renderForm(categories: Array<Category> = [SALARY, OTHER]) {
  const onSuccess = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <AddIncomeForm categories={categories} onSuccess={onSuccess} />
    </QueryClientProvider>,
  )
  return { onSuccess }
}

function repeatSelect() {
  return screen.getByTestId<HTMLSelectElement>('income-repeat')
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

function invalidatedKeys(spy: { mock: { calls: Array<Array<unknown>> } }) {
  return spy.mock.calls.map(
    (c) => (c[0] as { queryKey?: unknown } | undefined)?.queryKey,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(addIncome).mockResolvedValue(SAVED)
  vi.mocked(addRepeatingIncome).mockResolvedValue({ ...SAVED, recurringId: 'r1' })
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})

describe('AddIncomeForm Repeat select', () => {
  it('defaults to "Don\'t repeat" and offers Weekly, Monthly and Yearly', () => {
    renderForm()

    expect(repeatSelect().value).toBe('none')
    const options = Array.from(repeatSelect().options)
    expect(options.map((o) => o.value)).toEqual(['none', 'week', 'month', 'year'])
    expect(options.map((o) => o.textContent)).toEqual([
      "Don't repeat",
      'Weekly',
      'Monthly',
      'Yearly',
    ])
  })

  it('with "Don\'t repeat" it calls addIncome and never addRepeatingIncome', async () => {
    const { onSuccess } = renderForm()

    fillAndSubmit('100', 'March')

    await waitFor(() => expect(addIncome).toHaveBeenCalledTimes(1))
    expect(vi.mocked(addIncome).mock.calls[0][0]).toEqual({
      categoryId: 'ic1',
      amount: 100,
      currency: 'UAH',
      description: 'March',
    })
    expect(addRepeatingIncome).not.toHaveBeenCalled()
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
  })

  it.each(['week', 'month', 'year'] as const)(
    'with "%s" it calls addRepeatingIncome(data, unit) and not addIncome',
    async (unit) => {
      const { onSuccess } = renderForm()
      fireEvent.change(repeatSelect(), { target: { value: unit } })

      fillAndSubmit('250.5', 'Paycheck')

      await waitFor(() => expect(addRepeatingIncome).toHaveBeenCalledTimes(1))
      expect(vi.mocked(addRepeatingIncome).mock.calls[0][0]).toEqual({
        categoryId: 'ic1',
        amount: 250.5,
        currency: 'UAH',
        description: 'Paycheck',
      })
      expect(vi.mocked(addRepeatingIncome).mock.calls[0][1]).toBe(unit)
      expect(addIncome).not.toHaveBeenCalled()
      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
    },
  )

  it('a repeat save invalidates the recurring query', async () => {
    const spy = vi.spyOn(client, 'invalidateQueries')
    renderForm()
    fireEvent.change(repeatSelect(), { target: { value: 'month' } })

    fillAndSubmit('100')

    await waitFor(() => expect(addRepeatingIncome).toHaveBeenCalled())
    await waitFor(() => {
      expect(invalidatedKeys(spy)).toContainEqual(['recurring'])
    })
  })

  it('a plain save does not invalidate the recurring query', async () => {
    const spy = vi.spyOn(client, 'invalidateQueries')
    renderForm()

    fillAndSubmit('100')

    await waitFor(() => expect(addIncome).toHaveBeenCalled())
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(invalidatedKeys(spy)).not.toContainEqual(['recurring'])
  })

  it('resets to "Don\'t repeat" after a successful repeat save', async () => {
    renderForm()
    fireEvent.change(repeatSelect(), { target: { value: 'month' } })

    fillAndSubmit('100')

    await waitFor(() => expect(repeatSelect().value).toBe('none'))
    expect(screen.getByTestId<HTMLInputElement>('income-form-amount').value).toBe('')
  })

  it('keeps the chosen repeat and reports the error when the repeat save fails', async () => {
    vi.mocked(addRepeatingIncome).mockRejectedValue(new Error('disk full'))
    const spy = vi.spyOn(client, 'invalidateQueries')
    const { onSuccess } = renderForm()
    fireEvent.change(repeatSelect(), { target: { value: 'year' } })

    fillAndSubmit('100')

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain('disk full')
    expect(repeatSelect().value).toBe('year')
    expect(onSuccess).not.toHaveBeenCalled()
    expect(invalidatedKeys(spy)).not.toContainEqual(['recurring'])
  })

  it('does not save when validation fails, whatever the repeat', () => {
    renderForm()
    fireEvent.change(repeatSelect(), { target: { value: 'month' } })

    fillAndSubmit('0')

    expect(addRepeatingIncome).not.toHaveBeenCalled()
    expect(addIncome).not.toHaveBeenCalled()
  })
})
