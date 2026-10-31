// CONTRACT_GAP: the recurring form is submitted by clicking
//   recurring-form-submit after filling recurring-form-amount; the category and
//   start date keep their defaults.
// CONTRACT_GAP: generated entries inheriting paidBy are tested at the localDb
//   level (localDb.recurringPaidBy.test.ts); this file covers the UI side.
//
// Recurring page in a Family: Paid by in the form (add and edit), per-item
// move with the confirm, read-only controls, and no change without a Family.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'
import type * as AppSettings from '@/lib/appSettings'

import type { Category, RecurringItem } from '@/lib/domain'
import type { ActiveSpaceState } from '@/lib/spaces/switcher'
import { plural, setLang, translate } from '@/i18n/core'
import { getCurrencySettings } from '@/lib/appSettings'
import { buildMemberDirectory } from '@/lib/memberStats'
import { SpaceSwitchProvider } from '@/lib/spaces/switcher'
import { addRecurring, moveRecords } from '@/lib/localDb'
import { Route } from '@/routes/recurring'

const h = vi.hoisted(() => ({ personal: [] as Array<unknown>, family: [] as Array<unknown> }))
const fam = vi.hoisted(() => ({
  getAllRecurring: vi.fn(),
  getAllCategories: vi.fn(),
  getAllIncomeCategories: vi.fn(),
  addRecurring: vi.fn(),
  updateRecurring: vi.fn(),
  setRecurringPaused: vi.fn(),
  deleteRecurring: vi.fn(),
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
  getAllRecurring: vi.fn(() => Promise.resolve([...h.personal])),
  getAllCategories: vi.fn(() => Promise.resolve([{ id: 'c1', name: 'Food', icon: '🍔' }])),
  getAllIncomeCategories: vi.fn(() => Promise.resolve([{ id: 'ic1', name: 'Salary', icon: '💼' }])),
  addRecurring: vi.fn(),
  updateRecurring: vi.fn(),
  setRecurringPaused: vi.fn(),
  deleteRecurring: vi.fn(),
  moveRecords: vi.fn(),
  spaceDb: vi.fn(() => fam),
}))
vi.mock('@/lib/appSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof AppSettings>()),
  getCurrencySettings: vi.fn(),
}))
vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))
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
const switchTo = vi.fn()

function item(id: string, description: string, extra: Partial<RecurringItem> = {}): RecurringItem {
  return {
    id,
    kind: 'expense',
    amount: 100,
    currency: 'UAH',
    categoryId: 'c1',
    description,
    frequency: { unit: 'month', interval: 1 },
    startDate: '2026-01-15',
    end: { type: 'never' },
    mode: 'auto',
    paused: false,
    handledThrough: null,
    handledAhead: [],
    occurrenceCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  }
}

function familyValue(extra: Partial<ActiveSpaceState> = {}): Partial<ActiveSpaceState> {
  return { spaceId: 'fam-1', family: FAMILY, directory: DIR, memberId: 'u-me', switchTo, ...extra }
}

function renderPage(value: Partial<ActiveSpaceState>) {
  const Page = Route.options.component
  if (!Page) throw new Error('no component')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SpaceSwitchProvider value={{ switchTo, ...value }}>
        <Page />
      </SpaceSwitchProvider>
    </QueryClientProvider>,
  )
}

function rowFor(name: string) {
  const row = screen
    .getAllByTestId('recurring-row')
    .find((r) => within(r).getByTestId('recurring-row-name').textContent === name)
  if (!row) throw new Error(`no row ${name}`)
  return row
}

beforeEach(() => {
  vi.clearAllMocks()
  setLang('en', { persist: false })
  h.personal = [item('r1', 'Gym')]
  h.family = [
    item('f1', 'Rent', { paidBy: 'u-olena', createdBy: 'u-me' }),
    item('f2', 'Internet', { paidBy: 'u-me' }),
  ]
  const categories = [{ id: 'c1', name: 'Food', icon: '🍔' } as Category]
  fam.getAllRecurring.mockImplementation(() => Promise.resolve([...h.family]))
  fam.getAllCategories.mockResolvedValue(categories)
  fam.getAllIncomeCategories.mockResolvedValue([{ id: 'ic1', name: 'Salary', icon: '💼' }])
  fam.addRecurring.mockResolvedValue(item('new', 'x'))
  fam.updateRecurring.mockResolvedValue(item('f1', 'Rent'))
  vi.mocked(addRecurring).mockResolvedValue(item('new', 'x'))
  vi.mocked(moveRecords).mockResolvedValue({ moved: 1, createdCategories: 0, skipped: 0 })
  vi.mocked(getCurrencySettings).mockResolvedValue({ mainCurrency: 'UAH', fetchExchangeRates: true })
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('Paid by in the recurring form', () => {
  it('Family add: the select defaults to me and the chosen payer is saved', async () => {
    renderPage(familyValue())
    await waitFor(() => expect(screen.getAllByTestId('recurring-row')).toHaveLength(2))

    fireEvent.click(screen.getByTestId('recurring-add-btn'))
    const form = await screen.findByTestId('recurring-form')
    const select = within(form).getByTestId<HTMLSelectElement>('paid-by-select')
    expect(select.value).toBe('u-me')
    expect(within(form).getByLabelText(translate('en', 'members.paidBy'))).toBe(select)
    fireEvent.change(within(form).getByTestId('recurring-form-amount'), { target: { value: '250' } })
    fireEvent.change(select, { target: { value: 'u-olena' } })
    fireEvent.click(within(form).getByTestId('recurring-form-submit'))

    await waitFor(() => expect(fam.addRecurring).toHaveBeenCalledTimes(1))
    expect(fam.addRecurring.mock.calls[0][0]).toMatchObject({ paidBy: 'u-olena', amount: 250 })
    expect(addRecurring).not.toHaveBeenCalled()
  })

  it('Family edit: the select shows the stored payer and a change is saved', async () => {
    renderPage(familyValue())
    await waitFor(() => expect(screen.getAllByTestId('recurring-row')).toHaveLength(2))

    fireEvent.click(within(rowFor('Rent')).getByTestId('recurring-edit-btn'))
    const form = await screen.findByTestId('recurring-form')
    const select = within(form).getByTestId<HTMLSelectElement>('paid-by-select')
    expect(select.value).toBe('u-olena')
    fireEvent.change(select, { target: { value: 'u-me' } })
    fireEvent.click(within(form).getByTestId('recurring-form-submit'))

    await waitFor(() => expect(fam.updateRecurring).toHaveBeenCalledTimes(1))
    expect(fam.updateRecurring.mock.calls[0][0]).toBe('f1')
    expect(fam.updateRecurring.mock.calls[0][1]).toMatchObject({ paidBy: 'u-me' })
  })

  it('Personal has no select and the saved input has no paidBy key', async () => {
    renderPage({ spaceId: 'personal', family: FAMILY })
    await waitFor(() => expect(screen.getAllByTestId('recurring-row')).toHaveLength(1))

    fireEvent.click(screen.getByTestId('recurring-add-btn'))
    const form = await screen.findByTestId('recurring-form')
    expect(within(form).queryByTestId('paid-by-select')).toBeNull()
    fireEvent.change(within(form).getByTestId('recurring-form-amount'), { target: { value: '50' } })
    fireEvent.click(within(form).getByTestId('recurring-form-submit'))

    await waitFor(() => expect(addRecurring).toHaveBeenCalledTimes(1))
    expect('paidBy' in vi.mocked(addRecurring).mock.calls[0][0]).toBe(false)
  })
})

describe('per-item move', () => {
  it('Personal to Family: confirm for one item, then moveRecords with type recurring', async () => {
    renderPage({ spaceId: 'personal', family: FAMILY })
    await waitFor(() => expect(screen.getAllByTestId('recurring-row')).toHaveLength(1))

    fireEvent.click(within(rowFor('Gym')).getByTestId('recurring-move-btn'))
    expect(screen.getByTestId('move-confirm-title').textContent).toBe(
      plural('move.titleToFamily', 1, { name: 'Our home' }),
    )
    expect(moveRecords).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('move-confirm-btn'))

    await waitFor(() => expect(moveRecords).toHaveBeenCalledTimes(1))
    expect(vi.mocked(moveRecords).mock.calls[0][0]).toEqual({
      from: 'personal',
      to: 'fam-1',
      type: 'recurring',
      ids: ['r1'],
    })
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it('Family to Personal uses the other wording and direction', async () => {
    renderPage(familyValue())
    await waitFor(() => expect(screen.getAllByTestId('recurring-row')).toHaveLength(2))

    fireEvent.click(within(rowFor('Internet')).getByTestId('recurring-move-btn'))
    expect(screen.getByTestId('move-confirm-text').textContent).toBe(
      translate('en', 'move.bodyToPersonal', { name: 'Our home' }),
    )
    fireEvent.click(screen.getByTestId('move-confirm-btn'))

    await waitFor(() => expect(moveRecords).toHaveBeenCalledTimes(1))
    expect(vi.mocked(moveRecords).mock.calls[0][0]).toEqual({
      from: 'fam-1',
      to: 'personal',
      type: 'recurring',
      ids: ['f2'],
    })
  })

  it('cancel moves nothing', async () => {
    renderPage({ spaceId: 'personal', family: FAMILY })
    await waitFor(() => expect(screen.getAllByTestId('recurring-row')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('recurring-move-btn'))

    fireEvent.click(screen.getByTestId('move-cancel-btn'))

    expect(moveRecords).not.toHaveBeenCalled()
  })

  it('a refused move shows an error toast', async () => {
    vi.mocked(moveRecords).mockRejectedValue(new Error('read-only'))
    renderPage({ spaceId: 'personal', family: FAMILY })
    await waitFor(() => expect(screen.getAllByTestId('recurring-row')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('recurring-move-btn'))

    fireEvent.click(screen.getByTestId('move-confirm-btn'))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('without a Family there is no move button', async () => {
    renderPage({ spaceId: 'personal', family: null })
    await waitFor(() => expect(screen.getAllByTestId('recurring-row')).toHaveLength(1))

    expect(screen.queryByTestId('recurring-move-btn')).toBeNull()
  })
})

describe('read-only Family', () => {
  it('disables add, edit, pause, delete and move', async () => {
    renderPage(familyValue({ readOnly: true }))

    await waitFor(() => expect(screen.getAllByTestId('recurring-row')).toHaveLength(2))
    expect(screen.getByTestId('space-readonly-banner')).toBeTruthy()
    expect(screen.getByTestId<HTMLButtonElement>('recurring-add-btn').disabled).toBe(true)
    for (const id of ['recurring-edit-btn', 'recurring-pause-btn', 'recurring-delete-btn', 'recurring-move-btn']) {
      for (const el of screen.getAllByTestId<HTMLButtonElement>(id)) expect(el.disabled, id).toBe(true)
    }
  })

  it('a healthy Family has them enabled', async () => {
    renderPage(familyValue())

    await waitFor(() => expect(screen.getAllByTestId('recurring-row')).toHaveLength(2))
    expect(screen.getByTestId<HTMLButtonElement>('recurring-add-btn').disabled).toBe(false)
    expect(screen.getAllByTestId<HTMLButtonElement>('recurring-move-btn')[0].disabled).toBe(false)
  })

  it('a paused Family still allows editing', async () => {
    renderPage(familyValue({ paused: true }))

    await waitFor(() => expect(screen.getAllByTestId('recurring-row')).toHaveLength(2))
    expect(screen.getByTestId('space-paused-banner')).toBeTruthy()
    expect(screen.getByTestId<HTMLButtonElement>('recurring-add-btn').disabled).toBe(false)
  })
})

describe('the list follows the active space', () => {
  it('shows only the Family items in the Family and only the personal ones in Personal', async () => {
    const view = renderPage(familyValue())
    await waitFor(() => expect(screen.getAllByTestId('recurring-row')).toHaveLength(2))
    expect(screen.queryByText('Gym')).toBeNull()
    view.unmount()

    renderPage({ spaceId: 'personal', family: FAMILY })
    await waitFor(() => expect(screen.getAllByTestId('recurring-row')).toHaveLength(1))
    expect(screen.queryByText('Rent')).toBeNull()
  })
})
