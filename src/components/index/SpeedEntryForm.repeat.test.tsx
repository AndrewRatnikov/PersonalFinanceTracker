// No CONTRACT_GAPs: the speed-entry-repeat select, its values and the new
// onSubmit(data, repeat) signature are specified in the Interface Contract
// (component changes: SpeedEntryForm).

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import type { Category, CreateExpenseInput, QuickRepeat } from '@/lib/domain'
import SpeedEntryForm from '@/components/index/SpeedEntryForm'

const categories: Array<Category> = [{ id: 'c1', name: 'Food' }]

type SubmitFn = (data: CreateExpenseInput, repeat: QuickRepeat) => Promise<void>

function renderForm(onSubmit: Mock<SubmitFn>) {
  return render(<SpeedEntryForm categories={categories} onSubmit={onSubmit} />)
}

function repeatSelect() {
  return screen.getByTestId<HTMLSelectElement>('speed-entry-repeat')
}

function fillAndSubmit(amount: string) {
  fireEvent.change(screen.getByTestId<HTMLInputElement>('speed-entry-amount'), {
    target: { value: amount },
  })
  fireEvent.submit(screen.getByTestId('speed-entry-form'))
}

const flush = () => act(async () => {})

describe('SpeedEntryForm Repeat select', () => {
  it('defaults to "Don\'t repeat" and offers Weekly, Monthly and Yearly', () => {
    renderForm(vi.fn<SubmitFn>().mockResolvedValue(undefined))

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

  it('is labelled "Repeat"', () => {
    renderForm(vi.fn<SubmitFn>().mockResolvedValue(undefined))

    expect(screen.getByTestId('speed-entry-form').textContent).toContain('Repeat')
  })

  it('submits with "none" by default', async () => {
    const onSubmit = vi.fn<SubmitFn>().mockResolvedValue(undefined)
    renderForm(onSubmit)

    fillAndSubmit('12')

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: 12, categoryId: 'c1' })
    expect(onSubmit.mock.calls[0][1]).toBe('none')
  })

  it.each(['week', 'month', 'year'] as const)(
    'submits the chosen repeat "%s" together with the data',
    async (repeat) => {
      const onSubmit = vi.fn<SubmitFn>().mockResolvedValue(undefined)
      renderForm(onSubmit)
      fireEvent.change(repeatSelect(), { target: { value: repeat } })

      fillAndSubmit('30')

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
      expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: 30 })
      expect(onSubmit.mock.calls[0][1]).toBe(repeat)
    },
  )

  it('resets to "Don\'t repeat" after a successful save', async () => {
    const onSubmit = vi.fn<SubmitFn>().mockResolvedValue(undefined)
    renderForm(onSubmit)
    fireEvent.change(repeatSelect(), { target: { value: 'month' } })

    fillAndSubmit('30')

    await waitFor(() => expect(repeatSelect().value).toBe('none'))
    expect(screen.getByTestId<HTMLInputElement>('speed-entry-amount').value).toBe('')
  })

  it('keeps the chosen repeat when the save fails', async () => {
    const onSubmit = vi.fn<SubmitFn>().mockRejectedValue(new Error('save failed'))
    renderForm(onSubmit)
    fireEvent.change(repeatSelect(), { target: { value: 'year' } })

    fillAndSubmit('30')
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    await flush()

    expect(repeatSelect().value).toBe('year')
    expect(screen.getByTestId<HTMLInputElement>('speed-entry-amount').value).toBe('30')
  })

  it('does not submit, and keeps the repeat, when validation fails', async () => {
    const onSubmit = vi.fn<SubmitFn>().mockResolvedValue(undefined)
    renderForm(onSubmit)
    fireEvent.change(repeatSelect(), { target: { value: 'week' } })

    fillAndSubmit('0')
    await flush()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(repeatSelect().value).toBe('week')
  })
})
