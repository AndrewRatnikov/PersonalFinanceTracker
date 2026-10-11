// CONTRACT_GAP: need data-testids for the CategoryRow edit mode (the save
// button and the name input) to test renaming through the UI. The rename
// invalidation (updateIncomeCategory -> ['incomeCategories'] + ['income']) is
// therefore not exercised here; add/delete and the kind routing are.
// CONTRACT_GAP: the expense add inputs are only identified by the element ids
// new-category-name / new-category-icon / add-category-btn (Approach section 8),
// not by testids, so they are queried with getElementById.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Category } from '@/lib/domain'
import { CategoriesTab } from '@/components/settings/CategoriesTab'
import {
  addCategory,
  addIncomeCategory,
  deleteCategory,
  deleteIncomeCategory,
  getAllCategories,
  getAllIncomeCategories,
  updateCategory,
  updateIncomeCategory,
} from '@/lib/localDb'

vi.mock('@/lib/localDb', () => ({
  getAllCategories: vi.fn(),
  getAllIncomeCategories: vi.fn(),
  addCategory: vi.fn(),
  addIncomeCategory: vi.fn(),
  updateCategory: vi.fn(),
  updateIncomeCategory: vi.fn(),
  deleteCategory: vi.fn(),
  deleteIncomeCategory: vi.fn(),
}))

const FOOD: Category = { id: 'c1', name: 'Food', icon: '🍔' }
const SALARY: Category = { id: 'ic1', name: 'Salary', icon: '💼' }
const GIFTS: Category = { id: 'ic2', name: 'Gifts', icon: null }

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  render(
    <QueryClientProvider client={client}>
      <CategoriesTab />
    </QueryClientProvider>,
  )
  return { client, invalidate }
}

function invalidatedKeys(invalidate: ReturnType<typeof renderTab>['invalidate']) {
  return invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))
}

async function incomeSection() {
  return within(await screen.findByTestId('income-categories-section'))
}

async function expenseSection() {
  return within(await screen.findByTestId('expense-categories-section'))
}

describe('CategoriesTab sections', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getAllCategories).mockResolvedValue([FOOD])
    vi.mocked(getAllIncomeCategories).mockResolvedValue([SALARY, GIFTS])
  })

  it('shows the expense and income categories in separate sections', async () => {
    renderTab()

    const expenses = await expenseSection()
    const income = await incomeSection()
    await waitFor(() => {
      expect(income.getAllByTestId('category-row')).toHaveLength(2)
    })
    expect(
      expenses.getAllByTestId('category-row-name').map((n) => n.textContent),
    ).toEqual(['Food'])
    expect(
      income.getAllByTestId('category-row-name').map((n) => n.textContent),
    ).toEqual(['Salary', 'Gifts'])
    expect(expenses.queryByText('Salary')).toBeNull()
    expect(income.queryByText('Food')).toBeNull()
    expect(screen.getByTestId('categories-tab')).toBeTruthy()
  })

  it('has the headings Expense categories and Income categories, expense first', async () => {
    renderTab()

    const expenseEl = await screen.findByTestId('expense-categories-section')
    const incomeEl = await screen.findByTestId('income-categories-section')
    expect(expenseEl.textContent).toContain('Expense categories')
    expect(incomeEl.textContent).toContain('Income categories')
    expect(
      expenseEl.compareDocumentPosition(incomeEl) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('shows the empty text for an empty income list', async () => {
    vi.mocked(getAllIncomeCategories).mockResolvedValue([])

    renderTab()

    const empty = await screen.findByTestId('income-categories-empty')
    expect(empty.textContent).toBe('No income categories yet.')
    expect(
      (await incomeSection()).queryAllByTestId('category-row'),
    ).toHaveLength(0)
  })

  it('does not show the empty text when income categories exist', async () => {
    renderTab()

    await screen.findByTestId('income-categories-section')
    await waitFor(() => {
      expect(screen.getAllByTestId('category-row').length).toBeGreaterThan(1)
    })
    expect(screen.queryByTestId('income-categories-empty')).toBeNull()
  })
})

describe('CategoriesTab income: add', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getAllCategories).mockResolvedValue([FOOD])
    vi.mocked(getAllIncomeCategories).mockResolvedValue([SALARY])
    vi.mocked(addIncomeCategory).mockResolvedValue({
      id: 'ic9',
      name: 'Freelance',
      icon: null,
    })
  })

  it('the add button is disabled until a name is typed', async () => {
    renderTab()

    const btn = await screen.findByTestId<HTMLButtonElement>(
      'income-category-add-btn',
    )
    const input = screen.getByTestId<HTMLInputElement>('income-category-add-input')
    expect(btn.disabled).toBe(true)

    fireEvent.change(input, { target: { value: '   ' } })
    expect(btn.disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'Freelance' } })
    expect(btn.disabled).toBe(false)
  })

  it('calls addIncomeCategory (not addCategory) with the name and a null icon', async () => {
    renderTab()

    const input = await screen.findByTestId<HTMLInputElement>(
      'income-category-add-input',
    )
    fireEvent.change(input, { target: { value: 'Freelance' } })
    fireEvent.click(screen.getByTestId('income-category-add-btn'))

    await waitFor(() => {
      expect(addIncomeCategory).toHaveBeenCalledTimes(1)
    })
    expect(addIncomeCategory).toHaveBeenCalledWith({
      name: 'Freelance',
      icon: null,
    })
    expect(addCategory).not.toHaveBeenCalled()
  })

  it('passes the icon when one is typed', async () => {
    renderTab()

    fireEvent.change(await screen.findByTestId('income-category-add-input'), {
      target: { value: 'Bonus' },
    })
    fireEvent.change(screen.getByTestId('income-category-add-icon'), {
      target: { value: '🎯' },
    })
    fireEvent.click(screen.getByTestId('income-category-add-btn'))

    await waitFor(() => {
      expect(addIncomeCategory).toHaveBeenCalledWith({
        name: 'Bonus',
        icon: '🎯',
      })
    })
  })

  it('invalidates incomeCategories and income, not categories, then clears the inputs', async () => {
    const { invalidate } = renderTab()

    const input = await screen.findByTestId<HTMLInputElement>(
      'income-category-add-input',
    )
    fireEvent.change(input, { target: { value: 'Freelance' } })
    fireEvent.click(screen.getByTestId('income-category-add-btn'))

    await waitFor(() => {
      expect(invalidatedKeys(invalidate)).toContain(
        JSON.stringify(['incomeCategories']),
      )
    })
    const keys = invalidatedKeys(invalidate)
    expect(keys).toContain(JSON.stringify(['income']))
    expect(keys).not.toContain(JSON.stringify(['categories']))
    await waitFor(() => {
      expect(input.value).toBe('')
    })
  })

  it('shows the error from a refused add in categories-error and keeps the input', async () => {
    vi.mocked(addIncomeCategory).mockRejectedValue(
      new Error('Category "salary" already exists'),
    )
    renderTab()

    const input = await screen.findByTestId<HTMLInputElement>(
      'income-category-add-input',
    )
    fireEvent.change(input, { target: { value: 'salary' } })
    fireEvent.click(screen.getByTestId('income-category-add-btn'))

    const error = await screen.findByTestId('categories-error')
    expect(error.textContent).toContain('Category "salary" already exists')
    expect(input.value).toBe('salary')
  })

  it('there is no error alert before anything goes wrong', async () => {
    renderTab()

    await screen.findByTestId('income-categories-section')
    expect(screen.queryByTestId('categories-error')).toBeNull()
  })
})

describe('CategoriesTab expense: add keeps working', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getAllCategories).mockResolvedValue([FOOD])
    vi.mocked(getAllIncomeCategories).mockResolvedValue([SALARY])
    vi.mocked(addCategory).mockResolvedValue({
      id: 'c9',
      name: 'Coffee',
      icon: null,
    })
  })

  it('calls addCategory (not addIncomeCategory) and invalidates only categories', async () => {
    const { invalidate } = renderTab()

    await screen.findByTestId('expense-categories-section')
    const nameInput = document.getElementById(
      'new-category-name',
    ) as HTMLInputElement | null
    const addBtn = document.getElementById('add-category-btn')
    if (!nameInput || !addBtn) throw new Error('expense add card not found')
    fireEvent.change(nameInput, { target: { value: 'Coffee' } })
    fireEvent.click(addBtn)

    await waitFor(() => {
      expect(addCategory).toHaveBeenCalledWith({ name: 'Coffee', icon: null })
    })
    expect(addIncomeCategory).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(invalidatedKeys(invalidate)).toContain(JSON.stringify(['categories']))
    })
    const keys = invalidatedKeys(invalidate)
    expect(keys).not.toContain(JSON.stringify(['incomeCategories']))
    expect(keys).not.toContain(JSON.stringify(['income']))
  })
})

describe('CategoriesTab delete', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getAllCategories).mockResolvedValue([FOOD])
    vi.mocked(getAllIncomeCategories).mockResolvedValue([SALARY, GIFTS])
    vi.mocked(deleteIncomeCategory).mockResolvedValue(undefined)
    vi.mocked(deleteCategory).mockResolvedValue(undefined)
  })

  it('deleting an income row calls deleteIncomeCategory with that row id and invalidates income keys', async () => {
    const { invalidate } = renderTab()

    const income = await incomeSection()
    await waitFor(() => {
      expect(income.getAllByTestId('category-row')).toHaveLength(2)
    })
    // Second income row: Gifts.
    fireEvent.click(income.getAllByTestId('category-delete-btn')[1])
    expect(screen.getByTestId('category-delete-description').textContent).toContain(
      'Gifts',
    )
    fireEvent.click(screen.getByTestId('category-delete-confirm'))

    await waitFor(() => {
      expect(deleteIncomeCategory).toHaveBeenCalledWith('ic2')
    })
    expect(deleteCategory).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(invalidatedKeys(invalidate)).toContain(
        JSON.stringify(['incomeCategories']),
      )
    })
    expect(invalidatedKeys(invalidate)).toContain(JSON.stringify(['income']))
  })

  it('the income delete dialog speaks about income entries', async () => {
    renderTab()

    const income = await incomeSection()
    await waitFor(() => {
      expect(income.getAllByTestId('category-row')).toHaveLength(2)
    })
    fireEvent.click(income.getAllByTestId('category-delete-btn')[0])

    const text = screen.getByTestId('category-delete-description').textContent
    expect(text).toContain('cannot be deleted')
    expect(text).toContain('Salary')
    expect(text).toContain('income')
  })

  it('deleting an expense row calls deleteCategory and invalidates only categories', async () => {
    const { invalidate } = renderTab()

    const expenses = await expenseSection()
    await waitFor(() => {
      expect(expenses.getAllByTestId('category-row')).toHaveLength(1)
    })
    fireEvent.click(expenses.getByTestId('category-delete-btn'))
    fireEvent.click(screen.getByTestId('category-delete-confirm'))

    await waitFor(() => {
      expect(deleteCategory).toHaveBeenCalledWith('c1')
    })
    expect(deleteIncomeCategory).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(invalidatedKeys(invalidate)).toContain(JSON.stringify(['categories']))
    })
    expect(invalidatedKeys(invalidate)).not.toContain(
      JSON.stringify(['incomeCategories']),
    )
  })

  it('shows the refusal for a category an income entry still uses', async () => {
    vi.mocked(deleteIncomeCategory).mockRejectedValue(
      new Error('2 income entries use this category'),
    )
    renderTab()

    const income = await incomeSection()
    await waitFor(() => {
      expect(income.getAllByTestId('category-row')).toHaveLength(2)
    })
    fireEvent.click(income.getAllByTestId('category-delete-btn')[0])
    fireEvent.click(screen.getByTestId('category-delete-confirm'))

    const error = await screen.findByTestId('categories-error')
    expect(error.textContent).toContain('2 income entries use this category')
  })

  it('never calls the rename functions while only deleting', async () => {
    renderTab()

    const income = await incomeSection()
    await waitFor(() => {
      expect(income.getAllByTestId('category-row')).toHaveLength(2)
    })
    fireEvent.click(income.getAllByTestId('category-delete-btn')[0])
    fireEvent.click(screen.getByTestId('category-delete-confirm'))

    await waitFor(() => {
      expect(deleteIncomeCategory).toHaveBeenCalledTimes(1)
    })
    expect(updateIncomeCategory).not.toHaveBeenCalled()
    expect(updateCategory).not.toHaveBeenCalled()
  })
})

describe('CategoriesTab query errors', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getAllCategories).mockResolvedValue([FOOD])
    vi.mocked(getAllIncomeCategories).mockResolvedValue([SALARY])
  })

  it('an income query failure shows a retryable error in the income section only', async () => {
    vi.mocked(getAllIncomeCategories).mockRejectedValue(new Error('read failed'))

    renderTab()

    const income = await incomeSection()
    await waitFor(() => {
      expect(income.getByTestId('query-error')).toBeTruthy()
    })
    expect(income.queryAllByTestId('category-row')).toHaveLength(0)
    const expenses = await expenseSection()
    await waitFor(() => {
      expect(expenses.getAllByTestId('category-row')).toHaveLength(1)
    })
    expect(expenses.queryByTestId('query-error')).toBeNull()

    vi.mocked(getAllIncomeCategories).mockResolvedValue([SALARY])
    fireEvent.click(income.getByTestId('query-error-retry'))
    await waitFor(() => {
      expect(income.getAllByTestId('category-row')).toHaveLength(1)
    })
    expect(income.queryByTestId('query-error')).toBeNull()
  })

  it('an expense query failure replaces the whole tab content with the error state', async () => {
    vi.mocked(getAllCategories).mockRejectedValue(new Error('read failed'))

    renderTab()

    await waitFor(() => {
      expect(screen.getByTestId('query-error')).toBeTruthy()
    })
    expect(screen.getByTestId('categories-tab')).toBeTruthy()
    expect(screen.queryByTestId('income-categories-section')).toBeNull()
  })
})
