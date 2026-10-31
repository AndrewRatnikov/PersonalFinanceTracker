// CONTRACT_GAP: income has no edit mode (plan section 5 gap), so there is no
//   authorship line to test; only Received by on add.
// CONTRACT_GAP: IncomeTable's required props (isLoading, isError, isDeleting,
//   mainCurrency, onDelete) are the existing ones; only the optional new props
//   come from the contract.
//
// Income page, AddIncomeForm and IncomeTable in a Family: Received by, chips,
// member filter, bulk move, read-only, and no change without a Family.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps, ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'

import type { Category, IncomeEntry } from '@/lib/domain'
import type { ActiveSpaceState } from '@/lib/spaces/switcher'
import { plural, setLang, translate } from '@/i18n/core'
import { buildMemberDirectory } from '@/lib/memberStats'
import { SpaceSwitchProvider } from '@/lib/spaces/switcher'
import { addIncome, moveRecords } from '@/lib/localDb'
import { AddIncomeForm } from '@/components/income/AddIncomeForm'
import { IncomeTable } from '@/components/income/IncomeTable'
import { Route } from '@/routes/income'

const h = vi.hoisted(() => ({
  personal: [] as Array<unknown>,
  family: [] as Array<unknown>,
}))
const fam = vi.hoisted(() => ({
  getAllIncome: vi.fn(),
  getAllIncomeCategories: vi.fn(),
  addIncome: vi.fn(),
  deleteIncome: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactRouter>()
  return {
    ...actual,
    Link: ({ to, children, ...rest }: { to: string; children?: ReactNode; [key: string]: unknown }) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  }
})
vi.mock('@/lib/localDb', () => ({
  getAllIncome: vi.fn(() => Promise.resolve([...h.personal])),
  getAllIncomeCategories: vi.fn(() => Promise.resolve([{ id: 'ic1', name: 'Salary', icon: '💼' }])),
  addIncome: vi.fn(),
  deleteIncome: vi.fn(),
  moveRecords: vi.fn(),
  spaceDb: vi.fn(() => fam),
}))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

const FAMILY = { id: 'fam-1', name: 'Our home', role: 'owner' as const, readOnly: false }
const DIR = buildMemberDirectory(
  [
    { id: 'u-me', displayName: 'Andrii', color: 'var(--chart-1)' },
    { id: 'u-olena', displayName: 'Olena', color: 'var(--chart-2)' },
    { id: 'u-left', displayName: 'Maksym', color: 'var(--chart-3)' },
  ],
  ['u-me', 'u-olena'],
  'u-me',
)
const CATEGORIES: Array<Category> = [{ id: 'ic1', name: 'Salary', icon: '💼' }]
const switchTo = vi.fn()

function inc(id: string, amount: number, paidBy?: string): IncomeEntry {
  return {
    id,
    categoryId: 'ic1',
    amount,
    currency: 'UAH',
    createdAt: new Date(Date.UTC(2026, 9, 20, 12, 0, 0) - amount * 60_000).toISOString(),
    ...(paidBy === undefined ? {} : { paidBy }),
  }
}

function familyValue(extra: Partial<ActiveSpaceState> = {}): Partial<ActiveSpaceState> {
  return { spaceId: 'fam-1', family: FAMILY, directory: DIR, memberId: 'u-me', switchTo, ...extra }
}

function renderPage(value: Partial<ActiveSpaceState>) {
  const Page = Route.options.component
  if (!Page) throw new Error('no component')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SpaceSwitchProvider value={{ switchTo, ...value }}>
        <Page />
      </SpaceSwitchProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  setLang('en', { persist: false })
  h.personal = [inc('pi1', 10), inc('pi2', 20)]
  h.family = [inc('fi1', 100, 'u-me'), inc('fi2', 200, 'u-olena'), inc('fi3', 300, 'u-left')]
  fam.getAllIncome.mockImplementation(() => Promise.resolve([...h.family]))
  fam.getAllIncomeCategories.mockResolvedValue(CATEGORIES)
  fam.addIncome.mockResolvedValue(inc('new', 1, 'u-me'))
  vi.mocked(moveRecords).mockResolvedValue({ moved: 1, createdCategories: 0, skipped: 0 })
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('Family income list', () => {
  it('shows chips with the payer and a member filter including a (left) member', async () => {
    renderPage(familyValue())

    await waitFor(() => expect(screen.getAllByTestId('income-row')).toHaveLength(3))
    expect(screen.getAllByTestId('member-chip').map((c) => c.getAttribute('data-member-id')).sort()).toEqual([
      'u-left',
      'u-me',
      'u-olena',
    ])
    const options = Array.from(screen.getByTestId<HTMLSelectElement>('member-filter').options).map((o) => o.textContent)
    expect(options).toContain(translate('en', 'members.left', { name: 'Maksym' }))
    expect(options[0]).toBe(translate('en', 'members.all'))
  })

  it('the member filter narrows the rows', async () => {
    renderPage(familyValue())
    await waitFor(() => expect(screen.getAllByTestId('income-row')).toHaveLength(3))

    fireEvent.change(screen.getByTestId('member-filter'), { target: { value: 'u-me' } })
    expect(screen.getAllByTestId('income-row')).toHaveLength(1)
    fireEvent.change(screen.getByTestId('member-filter'), { target: { value: 'u-left' } })
    expect(screen.getAllByTestId('income-row')).toHaveLength(1)
    expect(screen.getByTestId('member-chip').getAttribute('aria-label')).toBe('Maksym')
  })

  it('Personal (with a Family held) shows move controls but no chips or filter', async () => {
    renderPage({ spaceId: 'personal', family: FAMILY })

    await waitFor(() => expect(screen.getAllByTestId('income-row')).toHaveLength(2))
    expect(screen.queryByTestId('member-chip')).toBeNull()
    expect(screen.queryByTestId('member-filter')).toBeNull()
    expect(screen.getAllByTestId('income-move-button')).toHaveLength(2)
  })

  it('without a Family there is no selection or move UI', async () => {
    renderPage({ spaceId: 'personal', family: null })

    await waitFor(() => expect(screen.getAllByTestId('income-row')).toHaveLength(2))
    expect(screen.queryByTestId('income-select')).toBeNull()
    expect(screen.queryByTestId('income-select-all')).toBeNull()
    expect(screen.queryByTestId('income-move-button')).toBeNull()
    expect(screen.queryByTestId('income-bulk-bar')).toBeNull()
  })
})

describe('bulk move of income', () => {
  it('Personal to Family: select all, confirm, moveRecords with type income', async () => {
    renderPage({ spaceId: 'personal', family: FAMILY })
    await waitFor(() => expect(screen.getAllByTestId('income-row')).toHaveLength(2))

    fireEvent.click(screen.getByTestId('income-select-all'))
    expect(screen.getByTestId('income-bulk-bar').textContent).toContain(plural('move.selected', 2))
    fireEvent.click(screen.getByTestId('income-bulk-move'))
    expect(screen.getByTestId('move-confirm-title').textContent).toBe(
      plural('move.titleToFamily', 2, { name: 'Our home' }),
    )
    fireEvent.click(screen.getByTestId('move-confirm-btn'))

    await waitFor(() => expect(moveRecords).toHaveBeenCalledTimes(1))
    const input = vi.mocked(moveRecords).mock.calls[0][0]
    expect(input).toMatchObject({ from: 'personal', to: 'fam-1', type: 'income' })
    expect([...input.ids].sort()).toEqual(['pi1', 'pi2'])
    await waitFor(() => expect(screen.queryByTestId('income-bulk-bar')).toBeNull())
    expect(toast.success).toHaveBeenCalled()
  })

  it('Family to Personal moves one row from its action', async () => {
    renderPage(familyValue())
    await waitFor(() => expect(screen.getAllByTestId('income-row')).toHaveLength(3))

    fireEvent.click(screen.getAllByTestId('income-move-button')[0])
    expect(screen.getByTestId('move-confirm-text').textContent).toBe(
      translate('en', 'move.bodyToPersonal', { name: 'Our home' }),
    )
    fireEvent.click(screen.getByTestId('move-confirm-btn'))

    await waitFor(() => expect(moveRecords).toHaveBeenCalledTimes(1))
    expect(vi.mocked(moveRecords).mock.calls[0][0]).toMatchObject({ from: 'fam-1', to: 'personal', type: 'income' })
    expect(vi.mocked(moveRecords).mock.calls[0][0].ids).toHaveLength(1)
  })

  it('a failed move toasts the error and moves nothing else', async () => {
    vi.mocked(moveRecords).mockRejectedValue(new Error('refused'))
    renderPage({ spaceId: 'personal', family: FAMILY })
    await waitFor(() => expect(screen.getAllByTestId('income-row')).toHaveLength(2))
    fireEvent.click(screen.getAllByTestId('income-select')[0])
    fireEvent.click(screen.getByTestId('income-bulk-move'))

    fireEvent.click(screen.getByTestId('move-confirm-btn'))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain('refused')
  })
})

describe('read-only Family income', () => {
  it('disables the form, delete, select and move', async () => {
    renderPage(familyValue({ readOnly: true }))

    await waitFor(() => expect(screen.getAllByTestId('income-row')).toHaveLength(3))
    expect(screen.getByTestId('space-readonly-banner')).toBeTruthy()
    expect(screen.getByTestId<HTMLButtonElement>('income-form-submit').disabled).toBe(true)
    for (const id of ['income-delete-button', 'income-move-button']) {
      for (const el of screen.getAllByTestId<HTMLButtonElement>(id)) expect(el.disabled, id).toBe(true)
    }
    for (const el of screen.getAllByTestId<HTMLInputElement>('income-select')) expect(el.disabled).toBe(true)
  })

  it('a healthy Family keeps them enabled', async () => {
    renderPage(familyValue())

    await waitFor(() => expect(screen.getAllByTestId('income-row')).toHaveLength(3))
    expect(screen.getByTestId<HTMLButtonElement>('income-form-submit').disabled).toBe(false)
    expect(screen.getAllByTestId<HTMLButtonElement>('income-delete-button')[0].disabled).toBe(false)
  })
})

describe('AddIncomeForm: Received by', () => {
  function renderForm(value: Partial<ActiveSpaceState>) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    return render(
      <QueryClientProvider client={client}>
        <SpaceSwitchProvider value={{ switchTo, ...value }}>
          <AddIncomeForm categories={CATEGORIES} onSuccess={() => undefined} />
        </SpaceSwitchProvider>
      </QueryClientProvider>,
    )
  }

  it('shows a Received by select defaulting to me and saves the chosen member', async () => {
    renderForm(familyValue())
    const select = screen.getByTestId<HTMLSelectElement>('paid-by-select')
    expect(select.value).toBe('u-me')
    expect(screen.getByLabelText(translate('en', 'members.receivedBy'))).toBe(select)
    fireEvent.change(screen.getByTestId('income-form-amount'), { target: { value: '500' } })
    fireEvent.change(select, { target: { value: 'u-olena' } })

    fireEvent.submit(screen.getByTestId('add-income-form'))

    await waitFor(() => expect(fam.addIncome).toHaveBeenCalledTimes(1))
    expect(fam.addIncome.mock.calls[0][0]).toMatchObject({ paidBy: 'u-olena', amount: 500 })
  })

  it('stores me when Received by is left alone', async () => {
    renderForm(familyValue())
    fireEvent.change(screen.getByTestId('income-form-amount'), { target: { value: '70' } })

    fireEvent.submit(screen.getByTestId('add-income-form'))

    await waitFor(() => expect(fam.addIncome).toHaveBeenCalledTimes(1))
    expect(fam.addIncome.mock.calls[0][0].paidBy).toBe('u-me')
  })

  it('Personal has no select and sends no paidBy key', async () => {
    vi.mocked(addIncome).mockResolvedValue(inc('x', 1))
    renderForm({ spaceId: 'personal', family: FAMILY })
    expect(screen.queryByTestId('paid-by-select')).toBeNull()
    fireEvent.change(screen.getByTestId('income-form-amount'), { target: { value: '70' } })

    fireEvent.submit(screen.getByTestId('add-income-form'))

    await waitFor(() => expect(addIncome).toHaveBeenCalledTimes(1))
    expect('paidBy' in vi.mocked(addIncome).mock.calls[0][0]).toBe(false)
  })
})

describe('IncomeTable optional props', () => {
  function renderTable(extra: Partial<ComponentProps<typeof IncomeTable>> = {}) {
    const onToggle = vi.fn()
    const onToggleAll = vi.fn()
    const onMove = vi.fn()
    render(
      <IncomeTable
        income={[inc('fi1', 100, 'u-me'), inc('fi2', 200, 'u-olena')]}
        isLoading={false}
        isError={false}
        isDeleting={false}
        mainCurrency="UAH"
        onDelete={() => undefined}
        members={DIR}
        selection={{ selected: new Set(['fi1']), onToggle, onToggleAll }}
        onMove={onMove}
        moveLabel="Move to Personal"
        {...extra}
      />,
    )
    return { onToggle, onToggleAll, onMove }
  }

  it('toggles rows and calls onMove with the entry', () => {
    const { onToggle, onToggleAll, onMove } = renderTable()

    const boxes = screen.getAllByTestId<HTMLInputElement>('income-select')
    expect(boxes.map((b) => b.checked)).toEqual([true, false])
    fireEvent.click(boxes[1])
    expect(onToggle).toHaveBeenCalledWith('fi2')
    fireEvent.click(screen.getByTestId('income-select-all'))
    expect(onToggleAll).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getAllByTestId('income-move-button')[0])
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: 'fi1' }))
  })

  it('shows a chip per row that has a payer', () => {
    render(
      <IncomeTable
        income={[inc('fi1', 100, 'u-me'), inc('fi2', 200)]}
        isLoading={false}
        isError={false}
        isDeleting={false}
        mainCurrency="UAH"
        onDelete={() => undefined}
        members={DIR}
      />,
    )

    expect(screen.getAllByTestId('member-chip')).toHaveLength(1)
  })

  it('without the optional props nothing extra renders, and delete still reports the id', () => {
    const onDelete = vi.fn()
    render(
      <IncomeTable
        income={[inc('fi1', 100, 'u-me')]}
        isLoading={false}
        isError={false}
        isDeleting={false}
        mainCurrency="UAH"
        onDelete={onDelete}
      />,
    )

    expect(screen.queryByTestId('member-chip')).toBeNull()
    expect(screen.queryByTestId('income-select')).toBeNull()
    expect(screen.queryByTestId('income-move-button')).toBeNull()
    expect(screen.getByTestId('income-delete-button')).toBeTruthy()
  })
})
