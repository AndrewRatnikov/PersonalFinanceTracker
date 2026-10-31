// CONTRACT_GAP: the exact average per month depends on the page's default range
//   (the normalized range of an empty search); only its presence and the
//   "/ month" suffix are asserted, the exact values are covered in
//   localAnalytics.members.test.ts.
// CONTRACT_GAP: bar widths and colours of MemberBreakdown are not asserted.
//
// Analytics page in a Family: By member and Received by sections with
// hand-computed totals and shares, the member filter on every number, pending
// entries excluded and counted, Personal unchanged.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'
import type * as AppSettings from '@/lib/appSettings'

import type { Expense, IncomeEntry } from '@/lib/domain'
import type { ActiveSpaceState } from '@/lib/spaces/switcher'
import { setLang, translate } from '@/i18n/core'
import { formatAmount, formatMoney } from '@/i18n/format'
import { getCurrencySettings } from '@/lib/appSettings'
import { buildMemberDirectory } from '@/lib/memberStats'
import { SpaceSwitchProvider } from '@/lib/spaces/switcher'
import { getAllBudgets, getAllIncome, getExpensesForRange } from '@/lib/localDb'
import { Route } from '@/routes/analytics'

const fam = vi.hoisted(() => ({
  getExpensesForRange: vi.fn(),
  getAllIncome: vi.fn(),
  getAllBudgets: vi.fn(),
}))

vi.mock('@/lib/localDb', () => ({
  getExpensesForRange: vi.fn(),
  getAllIncome: vi.fn(),
  getAllBudgets: vi.fn(),
  spaceDb: vi.fn(() => fam),
}))
vi.mock('@/lib/appSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof AppSettings>()),
  getCurrencySettings: vi.fn(),
}))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  Link: ({ to, search, children, ...rest }: { to: string; search?: unknown; children?: ReactNode } & Record<string, unknown>) => {
    void search
    return (
      <a href={to} {...rest}>
        {children}
      </a>
    )
  },
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
const FOOD = { id: 'cat-food', name: 'Food', icon: '🍔' }
const SALARY = { id: 'ic1', name: 'Salary', icon: '💼' }
const fmt2 = (n: number) => formatAmount(n, 'en')
const switchTo = vi.fn()

function exp(id: string, amount: number, paidBy?: string, extra: Partial<Expense> = {}): Expense {
  return {
    id,
    amount,
    currency: 'UAH',
    categoryId: FOOD.id,
    category: FOOD,
    createdAt: new Date().toISOString(),
    ...(paidBy === undefined ? {} : { paidBy }),
    ...extra,
  }
}

function inc(id: string, amount: number, paidBy?: string): IncomeEntry {
  return {
    id,
    amount,
    currency: 'UAH',
    categoryId: SALARY.id,
    category: SALARY,
    createdAt: new Date().toISOString(),
    ...(paidBy === undefined ? {} : { paidBy }),
  }
}

function familyValue(extra: Partial<ActiveSpaceState> = {}): Partial<ActiveSpaceState> {
  return { spaceId: 'fam-1', family: FAMILY, directory: DIR, memberId: 'u-me', switchTo, ...extra }
}

function tree(value: Partial<ActiveSpaceState>, client: QueryClient) {
  const Page = Route.options.component
  if (!Page) throw new Error('no component')
  return (
    <QueryClientProvider client={client}>
      <SpaceSwitchProvider value={{ switchTo, ...value }}>
        <Page />
      </SpaceSwitchProvider>
    </QueryClientProvider>
  )
}

function renderPage(value: Partial<ActiveSpaceState>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(tree(value, client))
  return { ...view, rerenderWith: (next: Partial<ActiveSpaceState>) => view.rerender(tree(next, client)) }
}

beforeEach(() => {
  vi.resetAllMocks()
  setLang('en', { persist: false })
  vi.spyOn(Route, 'useSearch').mockReturnValue({})
  vi.mocked(getCurrencySettings).mockResolvedValue({ mainCurrency: 'UAH', fetchExchangeRates: true })
  fam.getExpensesForRange.mockResolvedValue([
    exp('e1', 100, 'u-me'),
    exp('e2', 300, 'u-olena'),
    exp('e3', 100, 'u-left'),
    exp('e4', 50),
    exp('e5', 25, 'u-olena', { currency: 'USD' }),
  ])
  fam.getAllIncome.mockResolvedValue([inc('i1', 4000, 'u-olena'), inc('i2', 1000, 'u-me')])
  fam.getAllBudgets.mockResolvedValue([])
  vi.mocked(getExpensesForRange).mockResolvedValue([exp('p1', 40)])
  vi.mocked(getAllIncome).mockResolvedValue([inc('pi1', 900)])
  vi.mocked(getAllBudgets).mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('By member sections (hand-computed)', () => {
  it('lists each payer with total and share of the spending', async () => {
    renderPage(familyValue())

    await screen.findByTestId('analytics-members-expense')
    expect(screen.getByTestId('analytics-member-total-expense-u-olena').textContent).toBe(formatMoney(300, 'UAH'))
    expect(screen.getByTestId('analytics-member-share-expense-u-olena').textContent).toBe('55%')
    expect(screen.getByTestId('analytics-member-total-expense-u-me').textContent).toBe(formatMoney(100, 'UAH'))
    expect(screen.getByTestId('analytics-member-share-expense-u-me').textContent).toBe('18%')
    expect(screen.getByTestId('analytics-member-share-expense-u-left').textContent).toBe('18%')
    expect(screen.getByTestId('analytics-member-total-expense-unknown').textContent).toBe(formatMoney(50, 'UAH'))
    expect(screen.getByTestId('analytics-member-share-expense-unknown').textContent).toBe('9%')
    expect(screen.getByTestId('analytics-member-expense-u-left').textContent).toContain('Maksym')
  })

  it('shows an average per month for each member', async () => {
    renderPage(familyValue())

    await screen.findByTestId('analytics-members-expense')
    const average = screen.getByTestId('analytics-member-average-expense-u-olena').textContent
    expect(average).toContain('/ month')
    expect(average).not.toBe(screen.getByTestId('analytics-member-average-expense-unknown').textContent)
  })

  it('the Received by section covers income', async () => {
    renderPage(familyValue())

    await screen.findByTestId('analytics-members-income')
    expect(screen.getByTestId('analytics-member-total-income-u-olena').textContent).toBe(formatMoney(4000, 'UAH'))
    expect(screen.getByTestId('analytics-member-share-income-u-olena').textContent).toBe('80%')
    expect(screen.getByTestId('analytics-member-share-income-u-me').textContent).toBe('20%')
  })

  it('leaves the pending USD entry out of the member totals and counts it as today', async () => {
    renderPage(familyValue())

    await screen.findByTestId('analytics-members-expense')
    expect(screen.getByTestId('analytics-member-total-expense-u-olena').textContent).toBe(formatMoney(300, 'UAH'))
    expect(document.body.textContent).toContain('1 entry waiting for exchange rates')
  })

  it('has no member sections or filter in Personal, and Personal totals are the personal ones', async () => {
    renderPage({ spaceId: 'personal', family: FAMILY })

    const total = await screen.findByTestId('analytics-total-spent')
    expect(total.textContent).toContain(`${fmt2(40)} UAH`)
    expect(screen.queryByTestId('analytics-members-expense')).toBeNull()
    expect(screen.queryByTestId('analytics-members-income')).toBeNull()
    expect(screen.queryByTestId('member-filter')).toBeNull()
    expect(fam.getExpensesForRange).not.toHaveBeenCalled()
  })

  it('has no member sections without a Family', async () => {
    renderPage({ spaceId: 'personal', family: null })

    await screen.findByTestId('analytics-total-spent')
    expect(screen.queryByTestId('analytics-members-expense')).toBeNull()
    expect(screen.queryByTestId('member-filter')).toBeNull()
  })
})

describe('member filter on every number', () => {
  it('narrows totals, income and the member sections to one member', async () => {
    renderPage(familyValue())
    await screen.findByTestId('analytics-members-expense')
    expect(screen.getByTestId('analytics-total-spent').textContent).toContain(`${fmt2(550)} UAH`)

    fireEvent.change(screen.getByTestId('member-filter'), { target: { value: 'u-olena' } })

    await waitFor(() => expect(screen.getByTestId('analytics-total-spent').textContent).toContain(`${fmt2(300)} UAH`))
    expect(screen.getByTestId('analytics-total-income').textContent).toContain(`${fmt2(4000)} UAH`)
    expect(screen.queryByTestId('analytics-member-expense-u-me')).toBeNull()
    expect(screen.getByTestId('analytics-member-share-expense-u-olena').textContent).toBe('100%')
  })

  it('a different member gives different numbers', async () => {
    renderPage(familyValue())
    await screen.findByTestId('analytics-members-expense')

    fireEvent.change(screen.getByTestId('member-filter'), { target: { value: 'u-me' } })

    await waitFor(() => expect(screen.getByTestId('analytics-total-spent').textContent).toContain(`${fmt2(100)} UAH`))
    expect(screen.getByTestId('analytics-total-income').textContent).toContain(`${fmt2(1000)} UAH`)
    expect(document.body.textContent).not.toContain('waiting for exchange rates')
  })

  it('the filter lists the (left) member and All restores everything', async () => {
    renderPage(familyValue())
    await screen.findByTestId('analytics-members-expense')
    const select = screen.getByTestId<HTMLSelectElement>('member-filter')
    expect(Array.from(select.options).map((o) => o.textContent)).toContain(
      translate('en', 'members.left', { name: 'Maksym' }),
    )

    fireEvent.change(select, { target: { value: 'u-left' } })
    await waitFor(() => expect(screen.getByTestId('analytics-total-spent').textContent).toContain(`${fmt2(100)} UAH`))
    fireEvent.change(select, { target: { value: 'all' } })

    await waitFor(() => expect(screen.getByTestId('analytics-total-spent').textContent).toContain(`${fmt2(550)} UAH`))
  })
})

describe('switching space', () => {
  it('shows the other space’s numbers without a reload', async () => {
    const view = renderPage(familyValue())
    await screen.findByTestId('analytics-members-expense')
    expect(screen.getByTestId('analytics-total-spent').textContent).toContain(`${fmt2(550)} UAH`)

    view.rerenderWith({ spaceId: 'personal', family: FAMILY })

    await waitFor(() => expect(screen.getByTestId('analytics-total-spent').textContent).toContain(`${fmt2(40)} UAH`))
    expect(screen.queryByTestId('analytics-members-expense')).toBeNull()

    view.rerenderWith(familyValue())

    await waitFor(() => expect(screen.getByTestId('analytics-total-spent').textContent).toContain(`${fmt2(550)} UAH`))
    expect(screen.getByTestId('analytics-members-expense')).toBeTruthy()
  })
})
