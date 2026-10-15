// CONTRACT_GAP: the Save button, the limit input and the remove controls of a
// budget row have no data-testid in the Interface Contract; they are queried
// by role/name ("Save", "Remove budget", "Remove") and placeholder ("Limit"),
// one per category in the order of the categories prop.
// CONTRACT_GAP: the exact wording of the "saved in another currency" line is
// not fixed ("e.g." in the plan), so only "Saved in <currency>" and
// "converted to <main>" are asserted.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AppSettings from '@/lib/appSettings'
import type { CurrencySettings } from '@/lib/appSettings'
import type { BudgetEntry, Category } from '@/lib/domain'
import { BudgetTab } from '@/components/settings/BudgetTab'
import { getCurrencySettings } from '@/lib/appSettings'
import { deleteBudget, getAllBudgets, upsertBudget } from '@/lib/localDb'

vi.mock('@/lib/localDb', () => ({
  getAllBudgets: vi.fn(),
  upsertBudget: vi.fn(),
  deleteBudget: vi.fn(),
}))
vi.mock('@/lib/appSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof AppSettings>()),
  getCurrencySettings: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const FOOD: Category = { id: 'c1', name: 'Food', icon: '🍔' }
const FUN: Category = { id: 'c2', name: 'Fun', icon: null }

type StoredBudget = BudgetEntry & {
  categoryName: string
  categoryIcon: string | null
}

function stored(overrides: Partial<StoredBudget> = {}): StoredBudget {
  return {
    id: 'b1',
    categoryId: 'c1',
    monthlyLimit: 500,
    currency: 'UAH',
    categoryName: 'Food',
    categoryIcon: '🍔',
    ...overrides,
  }
}

function setSettings(settings: Partial<CurrencySettings> = {}) {
  vi.mocked(getCurrencySettings).mockResolvedValue({
    mainCurrency: 'UAH',
    fetchExchangeRates: true,
    ...settings,
  })
}

function renderTab(categories: Array<Category> = [FOOD, FUN]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <BudgetTab categories={categories} />
    </QueryClientProvider>,
  )
}

const limitInput = (index: number) =>
  screen.getAllByPlaceholderText<HTMLInputElement>('Limit')[index]

const saveButton = (index: number) =>
  screen.getAllByRole<HTMLButtonElement>('button', { name: 'Save' })[index]

async function settled(rows = 2) {
  await waitFor(() => {
    expect(screen.getAllByTestId('budget-row-currency')).toHaveLength(rows)
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getAllBudgets).mockResolvedValue([])
  vi.mocked(upsertBudget).mockResolvedValue(stored())
  vi.mocked(deleteBudget).mockResolvedValue(undefined)
  setSettings()
})

describe('BudgetTab shows the main currency instead of a currency select', () => {
  it('has no currency select on any row', async () => {
    renderTab()

    await settled()
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('USD')
    expect(document.body.textContent).not.toContain('EUR')
  })

  it('shows the main currency code next to every limit', async () => {
    renderTab()

    await settled()
    for (const el of screen.getAllByTestId('budget-row-currency')) {
      expect(el.textContent).toBe('UAH')
    }
  })

  it('follows the main currency from the settings', async () => {
    setSettings({ mainCurrency: 'EUR' })
    renderTab()

    await waitFor(() => {
      expect(screen.getAllByTestId('budget-row-currency')[0].textContent).toBe('EUR')
    })
    expect(screen.getAllByTestId('budget-row-currency')[1].textContent).toBe('EUR')
  })
})

describe('BudgetTab saves in the main currency', () => {
  it('upserts the typed limit with currency = the main currency', async () => {
    setSettings({ mainCurrency: 'EUR' })
    renderTab()
    await waitFor(() => {
      expect(screen.getAllByTestId('budget-row-currency')[0].textContent).toBe('EUR')
    })

    fireEvent.change(limitInput(1), { target: { value: '150' } })
    fireEvent.click(saveButton(1))

    await waitFor(() => {
      expect(upsertBudget).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(upsertBudget).mock.calls[0][0]).toEqual({
      categoryId: 'c2',
      monthlyLimit: 150,
      currency: 'EUR',
    })
  })

  it('uses UAH when UAH is the main currency (a different value gives a different currency)', async () => {
    renderTab()
    await settled()

    fireEvent.change(limitInput(0), { target: { value: '70' } })
    fireEvent.click(saveButton(0))

    await waitFor(() => {
      expect(upsertBudget).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(upsertBudget).mock.calls[0][0]).toEqual({
      categoryId: 'c1',
      monthlyLimit: 70,
      currency: 'UAH',
    })
  })

  it('keeps Save disabled until the settings have loaded', async () => {
    let resolveSettings: ((value: CurrencySettings) => void) | undefined
    vi.mocked(getCurrencySettings).mockReturnValue(
      new Promise<CurrencySettings>((resolve) => {
        resolveSettings = resolve
      }),
    )
    renderTab()

    await waitFor(() => {
      expect(screen.getAllByPlaceholderText('Limit')).toHaveLength(2)
    })
    fireEvent.change(limitInput(0), { target: { value: '70' } })
    expect(saveButton(0).disabled).toBe(true)

    resolveSettings?.({ mainCurrency: 'UAH', fetchExchangeRates: true })

    await waitFor(() => {
      expect(saveButton(0).disabled).toBe(false)
    })
  })

  it('keeps Save disabled for an empty or non-positive limit', async () => {
    renderTab()
    await settled()

    expect(saveButton(0).disabled).toBe(true)
    fireEvent.change(limitInput(0), { target: { value: '0' } })
    expect(saveButton(0).disabled).toBe(true)
    fireEvent.change(limitInput(0), { target: { value: '5' } })
    expect(saveButton(0).disabled).toBe(false)
  })
})

describe('BudgetTab rows with a stored budget', () => {
  it('shows no extra line for a budget already in the main currency', async () => {
    vi.mocked(getAllBudgets).mockResolvedValue([stored()])
    renderTab([FOOD])

    await waitFor(() => {
      expect(limitInput(0).value).toBe('500')
    })
    await settled(1)
    expect(document.body.textContent).not.toContain('Saved in')
  })

  it('explains a budget stored in another currency, and still shows the main currency', async () => {
    vi.mocked(getAllBudgets).mockResolvedValue([
      stored({ currency: 'USD', monthlyLimit: 100 }),
    ])
    renderTab([FOOD])

    await waitFor(() => {
      expect(document.body.textContent).toContain('Saved in USD')
    })
    expect(document.body.textContent).toContain('converted to UAH')
    expect(screen.getByTestId('budget-row-currency').textContent).toBe('UAH')
  })

  it('names the stored currency of the row', async () => {
    vi.mocked(getAllBudgets).mockResolvedValue([
      stored({ currency: 'EUR', monthlyLimit: 100 }),
    ])
    renderTab([FOOD])

    await waitFor(() => {
      expect(document.body.textContent).toContain('Saved in EUR')
    })
    expect(document.body.textContent).not.toContain('Saved in USD')
  })

  it('saving such a row stores it in the main currency', async () => {
    vi.mocked(getAllBudgets).mockResolvedValue([
      stored({ currency: 'USD', monthlyLimit: 100 }),
    ])
    renderTab([FOOD])
    await waitFor(() => {
      expect(document.body.textContent).toContain('Saved in USD')
    })

    fireEvent.change(limitInput(0), { target: { value: '120' } })
    fireEvent.click(saveButton(0))

    await waitFor(() => {
      expect(upsertBudget).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(upsertBudget).mock.calls[0][0]).toEqual({
      categoryId: 'c1',
      monthlyLimit: 120,
      currency: 'UAH',
    })
  })

  it('removes the budget after confirmation', async () => {
    vi.mocked(getAllBudgets).mockResolvedValue([stored()])
    renderTab([FOOD])
    await waitFor(() => {
      expect(limitInput(0).value).toBe('500')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove budget' }))
    expect(deleteBudget).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(deleteBudget).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(deleteBudget).mock.calls[0][0]).toBe('b1')
  })
})

describe('BudgetTab empty state', () => {
  it('asks for categories first when there are none', async () => {
    renderTab([])

    const tab = await screen.findByTestId('budget-tab')
    expect(tab.textContent).toContain('No categories yet')
    expect(screen.queryAllByTestId('budget-row-currency')).toHaveLength(0)
  })
})
