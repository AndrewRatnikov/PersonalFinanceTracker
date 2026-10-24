// No CONTRACT_GAPs: settings tab structure, selectors and test notes are fully
// specified in the Interface Contract (route: settings). The tab bodies are
// replaced by light markers; fake-general-tab, fake-account-tab and
// fake-storage-status stand in for GeneralTab, AccountTab and the Data tab
// content. Run 3: the featureFlags mock gains ENABLE_SYNC: false (the route now
// imports it) and SyncTab is replaced by fake-sync-tab; with the flag off the
// tab list is unchanged. The flag-on cases are in settings.sync.test.tsx.

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
vi.mock('@/lib/featureFlags', () => ({ ENABLE_ACCOUNTS: false, ENABLE_SYNC: false }))
vi.mock('@/components/settings/GeneralTab', () => ({
  GeneralTab: () => <div data-testid="fake-general-tab" />,
}))
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
vi.mock('@/components/settings/SyncTab', () => ({
  SyncTab: () => <div data-testid="fake-sync-tab" />,
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
  it('shows General first, then Categories, Budget, Security and Data', () => {
    renderSettings()

    expect(tabLabels()).toEqual([
      'General',
      'Categories',
      'Budget',
      'Security',
      'Data',
    ])
    expect(screen.queryByTestId('settings-tab-account')).toBeNull()
    expect(
      screen.getAllByRole('tablist')[0].className.includes('grid-cols-5'),
    ).toBe(true)
  })

  it('marks the General trigger with settings-tab-general', () => {
    renderSettings()

    const trigger = screen.getByTestId('settings-tab-general')
    expect(trigger.textContent.trim()).toBe('General')
    expect(screen.getAllByRole('tab')[0]).toBe(trigger)
  })

  it('opens on General by default', () => {
    renderSettings()

    expect(screen.getByTestId('fake-general-tab')).toBeTruthy()
    expect(screen.queryByTestId('categories-tab')).toBeNull()
    expect(
      screen.getByTestId('settings-tab-general').getAttribute('data-state'),
    ).toBe('active')
  })

  it('renames Data Tools to Data', () => {
    renderSettings()

    expect(document.body.textContent).not.toContain('Data Tools')
  })

  it('falls back to General when the search asks for the hidden Account tab', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'account' })
    renderSettings()

    expect(screen.getByTestId('fake-general-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-account-tab')).toBeNull()
    expect(screen.queryByTestId('categories-tab')).toBeNull()
  })

  it('falls back to General when the search asks for the hidden Sync tab (flag off)', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'sync' })
    renderSettings()

    expect(screen.getByTestId('fake-general-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-sync-tab')).toBeNull()
  })

  it('has no Sync trigger with the flag off', () => {
    renderSettings()

    expect(screen.queryByTestId('settings-tab-sync')).toBeNull()
    expect(tabLabels()).not.toContain('Sync')
  })
})

describe('Settings tabs with accounts visible', () => {
  beforeEach(() => {
    vi.mocked(useAccountsVisible).mockReturnValue(true)
  })

  it('adds the Account tab last', () => {
    renderSettings()

    expect(tabLabels()).toEqual([
      'General',
      'Categories',
      'Budget',
      'Security',
      'Data',
      'Account',
    ])
    expect(screen.getByTestId('settings-tab-account')).toBeTruthy()
    expect(
      screen.getAllByRole('tablist')[0].className.includes('grid-cols-6'),
    ).toBe(true)
  })

  it('renders the Account tab content for ?tab=account', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'account' })
    renderSettings()

    expect(screen.getByTestId('fake-account-tab')).toBeTruthy()
    expect(screen.queryByTestId('categories-tab')).toBeNull()
    expect(screen.queryByTestId('fake-general-tab')).toBeNull()
  })

  it('still hides the Sync tab when only accounts are visible (flag off)', () => {
    renderSettings()
    expect(screen.queryByTestId('settings-tab-sync')).toBeNull()
  })
})

describe('Settings tab selection', () => {
  it('renders General for ?tab=general', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'general' })
    renderSettings()

    expect(screen.getByTestId('fake-general-tab')).toBeTruthy()
    expect(screen.queryByTestId('security-tab')).toBeNull()
  })

  it('renders Categories for ?tab=categories (no longer the default)', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'categories' })
    renderSettings()

    expect(screen.getByTestId('categories-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-general-tab')).toBeNull()
  })

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

  it.each(['general', 'categories', 'budget', 'security', 'data', 'account', 'sync'])(
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
