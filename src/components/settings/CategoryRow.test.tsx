// No CONTRACT_GAPs: CategoryRow props and testids (#9) and the default
// currency select / rename-flow testids are fully specified in the Interface
// Contract (component: CategoryRow).

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Category } from '@/lib/domain'
import { CategoryRow } from '@/components/settings/CategoryRow'
import { updateCategory, updateIncomeCategory } from '@/lib/localDb'

vi.mock('@/lib/localDb', () => ({
  deleteCategory: vi.fn(),
  deleteIncomeCategory: vi.fn(),
  updateCategory: vi.fn(),
  updateIncomeCategory: vi.fn(),
}))

function openDeleteDialog(category: Category): string {
  render(
    <CategoryRow category={category} onMutate={vi.fn()} onError={vi.fn()} />,
  )
  fireEvent.click(screen.getByTestId('category-delete-btn'))
  return screen.getByTestId('category-delete-description').textContent
}

describe('CategoryRow delete dialog copy (#9)', () => {
  it('says a category in use cannot be deleted and no longer promises uncategorized', () => {
    const text = openDeleteDialog({ id: 'c1', name: 'Food', icon: null })

    expect(text).toContain('cannot be deleted')
    expect(text.toLowerCase()).not.toContain('uncategorized')
  })

  it('names the category being deleted', () => {
    const text = openDeleteDialog({ id: 'c1', name: 'Groceries', icon: null })

    expect(text).toContain('Groceries')
    expect(text).not.toContain('Food')
  })
})

describe('CategoryRow default currency', () => {
  const FOOD: Category = { id: 'c1', name: 'Food', icon: '🍔' }
  const SALARY: Category = { id: 'ic1', name: 'Salary', icon: '💼' }

  function renderRow(
    category: Category,
    kind?: 'expense' | 'income',
  ) {
    const onMutate = vi.fn()
    const onError = vi.fn<(message: string) => void>()
    render(
      <CategoryRow
        category={category}
        kind={kind}
        onMutate={onMutate}
        onError={onError}
      />,
    )
    return { onMutate, onError }
  }

  const select = (id: string) =>
    screen.getByTestId<HTMLSelectElement>(`category-default-currency-${id}`)

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(updateCategory).mockResolvedValue(FOOD)
    vi.mocked(updateIncomeCategory).mockResolvedValue(SALARY)
  })

  it('is a labelled native select with the main currency option first', () => {
    renderRow(FOOD)

    const el = select('c1')
    expect(el.tagName).toBe('SELECT')
    expect(el.getAttribute('aria-label')).toBe('Currency for Food')
    expect(Array.from(el.options).map((o) => o.value)).toEqual([
      '',
      'UAH',
      'USD',
      'EUR',
    ])
    expect(el.options[0].textContent).toBe('Main currency')
  })

  it('names the category in its label', () => {
    renderRow({ id: 'c2', name: 'Rent' })

    expect(select('c2').getAttribute('aria-label')).toBe('Currency for Rent')
  })

  it('shows "Main currency" for a category without a default', () => {
    renderRow(FOOD)

    expect(select('c1').value).toBe('')
  })

  it('shows the stored default currency', () => {
    renderRow({ ...FOOD, defaultCurrency: 'USD' })

    expect(select('c1').value).toBe('USD')
  })

  it('shows another stored default currency', () => {
    renderRow({ ...FOOD, defaultCurrency: 'EUR' })

    expect(select('c1').value).toBe('EUR')
  })

  it('choosing USD saves it with the name and icon of the row', async () => {
    const { onMutate, onError } = renderRow(FOOD)

    fireEvent.change(select('c1'), { target: { value: 'USD' } })

    await waitFor(() => expect(updateCategory).toHaveBeenCalledTimes(1))
    expect(updateCategory).toHaveBeenCalledWith({
      id: 'c1',
      name: 'Food',
      icon: '🍔',
      defaultCurrency: 'USD',
    })
    await waitFor(() => expect(onMutate).toHaveBeenCalledTimes(1))
    expect(onError).not.toHaveBeenCalled()
    expect(updateIncomeCategory).not.toHaveBeenCalled()
  })

  it('choosing EUR saves EUR', async () => {
    renderRow({ id: 'c9', name: 'Trips', icon: null })

    fireEvent.change(select('c9'), { target: { value: 'EUR' } })

    await waitFor(() => expect(updateCategory).toHaveBeenCalledTimes(1))
    expect(updateCategory).toHaveBeenCalledWith({
      id: 'c9',
      name: 'Trips',
      icon: null,
      defaultCurrency: 'EUR',
    })
  })

  it('a category without an icon is saved with icon null', async () => {
    renderRow({ id: 'c3', name: 'Misc' })

    fireEvent.change(select('c3'), { target: { value: 'UAH' } })

    await waitFor(() => expect(updateCategory).toHaveBeenCalledTimes(1))
    expect(vi.mocked(updateCategory).mock.calls[0][0]).toEqual({
      id: 'c3',
      name: 'Misc',
      icon: null,
      defaultCurrency: 'UAH',
    })
  })

  it('choosing "Main currency" clears the default with null', async () => {
    renderRow({ ...FOOD, defaultCurrency: 'USD' })

    fireEvent.change(select('c1'), { target: { value: '' } })

    await waitFor(() => expect(updateCategory).toHaveBeenCalledTimes(1))
    expect(updateCategory).toHaveBeenCalledWith({
      id: 'c1',
      name: 'Food',
      icon: '🍔',
      defaultCurrency: null,
    })
  })

  it('an income row saves through updateIncomeCategory', async () => {
    const { onMutate } = renderRow(SALARY, 'income')
    expect(select('ic1').value).toBe('')

    fireEvent.change(select('ic1'), { target: { value: 'USD' } })

    await waitFor(() => expect(updateIncomeCategory).toHaveBeenCalledTimes(1))
    expect(updateIncomeCategory).toHaveBeenCalledWith({
      id: 'ic1',
      name: 'Salary',
      icon: '💼',
      defaultCurrency: 'USD',
    })
    expect(updateCategory).not.toHaveBeenCalled()
    await waitFor(() => expect(onMutate).toHaveBeenCalledTimes(1))
  })

  it('reports a failed save through onError and does not call onMutate', async () => {
    vi.mocked(updateCategory).mockRejectedValue(new Error('disk full'))
    const { onMutate, onError } = renderRow(FOOD)

    fireEvent.change(select('c1'), { target: { value: 'USD' } })

    await waitFor(() => expect(onError).toHaveBeenCalledWith('disk full'))
    expect(onMutate).not.toHaveBeenCalled()
  })

  it('is disabled while the save is pending', async () => {
    let release: (category: Category) => void = () => {}
    vi.mocked(updateCategory).mockReturnValue(
      new Promise<Category>((resolve) => {
        release = resolve
      }),
    )
    renderRow(FOOD)

    fireEvent.change(select('c1'), { target: { value: 'USD' } })

    await waitFor(() => expect(select('c1').disabled).toBe(true))
    release(FOOD)
    await waitFor(() => expect(select('c1').disabled).toBe(false))
  })
})

describe('CategoryRow rename keeps the default currency', () => {
  const FOOD: Category = {
    id: 'c1',
    name: 'Food',
    icon: '🍔',
    defaultCurrency: 'USD',
  }

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(updateCategory).mockResolvedValue(FOOD)
    vi.mocked(updateIncomeCategory).mockResolvedValue(FOOD)
  })

  it('the rename button opens the name input with the current name', () => {
    render(<CategoryRow category={FOOD} onMutate={vi.fn()} onError={vi.fn()} />)

    fireEvent.click(screen.getByTestId('category-rename-btn'))

    expect(screen.getByTestId<HTMLInputElement>('category-edit-name').value).toBe(
      'Food',
    )
    expect(screen.getByTestId('category-edit-save')).toBeTruthy()
  })

  it('saves the new name without a defaultCurrency key', async () => {
    const onMutate = vi.fn()
    render(<CategoryRow category={FOOD} onMutate={onMutate} onError={vi.fn()} />)
    fireEvent.click(screen.getByTestId('category-rename-btn'))
    fireEvent.change(screen.getByTestId('category-edit-name'), {
      target: { value: 'Groceries' },
    })

    fireEvent.click(screen.getByTestId('category-edit-save'))

    await waitFor(() => expect(updateCategory).toHaveBeenCalledTimes(1))
    const input = vi.mocked(updateCategory).mock.calls[0][0]
    expect(input).toEqual({ id: 'c1', name: 'Groceries', icon: '🍔' })
    expect('defaultCurrency' in input).toBe(false)
    await waitFor(() => expect(onMutate).toHaveBeenCalledTimes(1))
  })

  it('an income row renames through updateIncomeCategory, also without the key', async () => {
    render(
      <CategoryRow
        category={{ id: 'ic1', name: 'Salary', icon: '💼', defaultCurrency: 'EUR' }}
        kind="income"
        onMutate={vi.fn()}
        onError={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('category-rename-btn'))
    fireEvent.change(screen.getByTestId('category-edit-name'), {
      target: { value: 'Wages' },
    })

    fireEvent.click(screen.getByTestId('category-edit-save'))

    await waitFor(() => expect(updateIncomeCategory).toHaveBeenCalledTimes(1))
    const input = vi.mocked(updateIncomeCategory).mock.calls[0][0]
    expect(input).toEqual({ id: 'ic1', name: 'Wages', icon: '💼' })
    expect('defaultCurrency' in input).toBe(false)
    expect(updateCategory).not.toHaveBeenCalled()
  })

  it('the currency select is hidden while renaming and comes back afterwards', async () => {
    render(<CategoryRow category={FOOD} onMutate={vi.fn()} onError={vi.fn()} />)
    expect(screen.getByTestId('category-default-currency-c1')).toBeTruthy()

    fireEvent.click(screen.getByTestId('category-rename-btn'))
    expect(screen.queryByTestId('category-default-currency-c1')).toBeNull()

    fireEvent.click(screen.getByTestId('category-edit-save'))

    await waitFor(() => {
      expect(screen.getByTestId('category-default-currency-c1')).toBeTruthy()
    })
  })
})
