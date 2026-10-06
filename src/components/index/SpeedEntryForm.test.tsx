// No CONTRACT_GAPs: SpeedEntryForm props and testids (#7) are fully specified
// in the Interface Contract.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Category, CreateExpenseInput } from '@/lib/domain'
import SpeedEntryForm from '@/components/index/SpeedEntryForm'

const categories: Array<Category> = [{ id: 'c1', name: 'Food' }]

function typeValues(amount: string, description: string) {
  fireEvent.change(screen.getByTestId<HTMLInputElement>('speed-entry-amount'), {
    target: { value: amount },
  })
  fireEvent.change(
    screen.getByTestId<HTMLInputElement>('speed-entry-description'),
    { target: { value: description } },
  )
}

const flush = () => act(async () => {})

describe('SpeedEntryForm keeps input until the save succeeds (#7)', () => {
  it('keeps the typed values when onSubmit rejects', async () => {
    const onSubmit = vi
      .fn<(data: CreateExpenseInput) => Promise<void>>()
      .mockRejectedValue(new Error('save failed'))
    render(<SpeedEntryForm categories={categories} onSubmit={onSubmit} />)
    typeValues('12.5', 'lunch')

    fireEvent.submit(screen.getByTestId('speed-entry-form'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    await flush()

    expect(
      screen.getByTestId<HTMLInputElement>('speed-entry-amount').value,
    ).toBe('12.5')
    expect(
      screen.getByTestId<HTMLInputElement>('speed-entry-description').value,
    ).toBe('lunch')
  })

  it('passes the validated data to onSubmit', async () => {
    const onSubmit = vi
      .fn<(data: CreateExpenseInput) => Promise<void>>()
      .mockResolvedValue(undefined)
    render(<SpeedEntryForm categories={categories} onSubmit={onSubmit} />)
    typeValues('7', 'tea')

    fireEvent.submit(screen.getByTestId('speed-entry-form'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))

    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      amount: 7,
      currency: 'UAH',
      categoryId: 'c1',
      description: 'tea',
    })
  })

  it('keeps the values while onSubmit is pending and clears them after it resolves', async () => {
    let resolve: () => void = () => {}
    const pending = new Promise<void>((r) => {
      resolve = r
    })
    const onSubmit = vi
      .fn<(data: CreateExpenseInput) => Promise<void>>()
      .mockReturnValue(pending)
    render(<SpeedEntryForm categories={categories} onSubmit={onSubmit} />)
    typeValues('30', 'taxi')

    fireEvent.submit(screen.getByTestId('speed-entry-form'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    await flush()

    expect(
      screen.getByTestId<HTMLInputElement>('speed-entry-amount').value,
    ).toBe('30')
    expect(
      screen.getByTestId<HTMLInputElement>('speed-entry-description').value,
    ).toBe('taxi')

    await act(async () => {
      resolve()
      await pending
    })

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLInputElement>('speed-entry-amount').value,
      ).toBe('')
    })
    expect(
      screen.getByTestId<HTMLInputElement>('speed-entry-description').value,
    ).toBe('')
  })

  it('does not call onSubmit and keeps the values when validation fails', async () => {
    const onSubmit = vi
      .fn<(data: CreateExpenseInput) => Promise<void>>()
      .mockResolvedValue(undefined)
    render(<SpeedEntryForm categories={categories} onSubmit={onSubmit} />)
    typeValues('0', 'free')

    fireEvent.submit(screen.getByTestId('speed-entry-form'))
    await flush()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(
      screen.getByTestId<HTMLInputElement>('speed-entry-description').value,
    ).toBe('free')
  })
})
