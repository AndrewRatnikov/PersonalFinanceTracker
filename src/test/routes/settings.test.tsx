// No CONTRACT_GAPs: settings tab structure, selectors and test notes are fully
// specified in the Interface Contract (route: settings). The tab bodies are
// replaced by light markers; fake-account-tab and fake-storage-status stand in
// for AccountTab and the Data tab content.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAccountsVisible } from '@/lib/accountSession'
import { getAllBudgets, getAllCategories } from '@/lib/localDb'
import { Route } from '@/routes/settings'

vi.mock('@/lib/localDb', () => ({
  getAllCategories: vi.fn(),
  getAllBudgets: vi.fn(),
}))
vi.mock('@/lib/accountSession', () => ({
  useAccountsVisible: vi.fn(),
  useAccountSession: vi.fn(),
}))
vi.mock('@/lib/featureFlags', () => ({ ENABLE_ACCOUNTS: false }))
vi.mock('@/components/settings/CategoriesTab', () => ({
  CategoriesTab: () => <div data-testid="categories-tab" />,
}))
vi.mock('@/components/settings/BudgetTab', () => ({
  BudgetTab: () => <div data-testid="budget-tab" />,
}))
vi.mock('@/components/settings/SecurityTab', () => ({
  SecurityTab: () => <div data-testid="security-tab" />,
}))
vi.mock('@/components/settings/DataToolsTab', () => ({
  DataToolsTab: () => <div data-testid="fake-storage-status" />,
}))
vi.mock('@/components/settings/AccountTab', () => ({
  AccountTab: () => <div data-testid="fake-account-tab" />,
}))

function renderSettings() {
  const Page = Route.options.component as React.ComponentType | undefined
  if (!Page) throw new Error('route has no component')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  )
}

function tabLabels() {
  return screen.getAllByRole('tab').map((t) => t.textContent.trim())
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getAllCategories).mockResolvedValue([])
  vi.mocked(getAllBudgets).mockResolvedValue([])
  vi.mocked(useAccountsVisible).mockReturnValue(false)
  vi.spyOn(Route, 'useSearch').mockReturnValue({})
})

afterEach(() => {
  cleanup()
})

describe('Settings tabs without accounts', () => {
  it('shows Categories, Budget, Security and Data only', () => {
    renderSettings()

    expect(tabLabels()).toEqual(['Categories', 'Budget', 'Security', 'Data'])
    expect(screen.queryByTestId('settings-tab-account')).toBeNull()
    expect(
      screen.getAllByRole('tablist')[0].className.includes('grid-cols-4'),
    ).toBe(true)
  })

  it('renames Data Tools to Data', () => {
    renderSettings()

    expect(document.body.textContent).not.toContain('Data Tools')
  })

  it('falls back to Categories when the search asks for the hidden Account tab', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'account' })
    renderSettings()

    expect(screen.getByTestId('categories-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-account-tab')).toBeNull()
  })
})

describe('Settings tabs with accounts visible', () => {
  beforeEach(() => {
    vi.mocked(useAccountsVisible).mockReturnValue(true)
  })

  it('adds the Account tab last', () => {
    renderSettings()

    expect(tabLabels()).toEqual([
      'Categories',
      'Budget',
      'Security',
      'Data',
      'Account',
    ])
    expect(screen.getByTestId('settings-tab-account')).toBeTruthy()
    expect(
      screen.getAllByRole('tablist')[0].className.includes('grid-cols-5'),
    ).toBe(true)
  })

  it('renders the Account tab content for ?tab=account', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'account' })
    renderSettings()

    expect(screen.getByTestId('fake-account-tab')).toBeTruthy()
    expect(screen.queryByTestId('categories-tab')).toBeNull()
  })
})

describe('Settings tab selection', () => {
  it('renders Security for ?tab=security', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'security' })
    renderSettings()

    expect(screen.getByTestId('security-tab')).toBeTruthy()
    expect(screen.queryByTestId('categories-tab')).toBeNull()
  })

  it('renders the Data tab for ?tab=data', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'data' })
    renderSettings()

    expect(screen.getByTestId('fake-storage-status')).toBeTruthy()
    expect(screen.queryByTestId('security-tab')).toBeNull()
  })
})

describe('Settings validateSearch', () => {
  const validate = Route.options.validateSearch as unknown as (
    search: Record<string, unknown>,
  ) => { tab?: string }

  it.each(['categories', 'budget', 'security', 'data', 'account'])(
    'accepts tab=%s',
    (tab) => {
      expect(validate({ tab })).toEqual({ tab })
    },
  )

  it('drops an unknown tab', () => {
    expect(validate({ tab: 'bogus' })).toEqual({})
    expect(validate({})).toEqual({})
  })
})
