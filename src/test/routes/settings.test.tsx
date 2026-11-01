// No CONTRACT_GAPs: the settings navigation (items, sections, fallbacks) and
// its selectors are specified in the Interface Contract (Route: /settings).
// The tab bodies are replaced by light markers; fake-general-tab,
// fake-account-tab and fake-storage-status stand in for GeneralTab, AccountTab
// and the Data tab content. The featureFlags mock has ENABLE_SYNC and
// ENABLE_SPACES off, so Sync and Family never show here (the flag-on cases are
// in settings.sync.test.tsx and settings.family.test.tsx, the layouts in
// settings.layout.test.tsx).
// Settings is no longer a tab bar: the phone shows a list of items and opens a
// section from ?tab=; desktop shows a sidebar and General by default. The
// layout comes from a mutable useIsDesktop mock.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAccountsVisible } from '@/lib/accountSession'
import { getAllBudgets, getAllCategories } from '@/lib/localDb'
import { Route } from '@/routes/settings'

const layout = vi.hoisted(() => ({ desktop: false }))

vi.mock('@/lib/useIsDesktop', () => ({
  DESKTOP_QUERY: '(min-width: 768px)',
  useIsDesktop: () => layout.desktop,
}))
vi.mock('@/lib/localDb', () => ({
  getAllCategories: vi.fn(),
  getAllBudgets: vi.fn(),
}))
vi.mock('@/lib/accountSession', () => ({
  useAccountsVisible: vi.fn(),
  useAccountSession: vi.fn(),
}))
vi.mock('@/lib/featureFlags', () => ({
  ENABLE_ACCOUNTS: false,
  ENABLE_SYNC: false,
  ENABLE_SPACES: false,
}))
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

function itemIds() {
  return screen.getAllByRole('button').map((b) => b.getAttribute('data-testid'))
}

beforeEach(() => {
  vi.resetAllMocks()
  layout.desktop = false
  vi.mocked(getAllCategories).mockResolvedValue([])
  vi.mocked(getAllBudgets).mockResolvedValue([])
  vi.mocked(useAccountsVisible).mockReturnValue(false)
  vi.spyOn(Route, 'useSearch').mockReturnValue({})
  vi.spyOn(Route, 'useNavigate').mockReturnValue(vi.fn() as never)
})

afterEach(() => {
  cleanup()
})

describe('Settings items without accounts', () => {
  it('lists General, Categories, Budget, Security and Data, in that order', () => {
    renderSettings()

    expect(itemIds()).toEqual([
      'settings-item-general',
      'settings-item-categories',
      'settings-item-budget',
      'settings-item-security',
      'settings-item-data',
    ])
    expect(screen.queryByTestId('settings-item-account')).toBeNull()
  })

  it('labels the items with the tab names', () => {
    renderSettings()

    const text = itemIds().map((id) => screen.getByTestId(id ?? '').textContent)
    expect(text[0]).toContain('General')
    expect(text[1]).toContain('Categories')
    expect(text[2]).toContain('Budget')
    expect(text[3]).toContain('Security')
    expect(text[4]).toContain('Data')
    expect(text).toHaveLength(5)
  })

  it('opens on the list on a phone, with no section mounted', () => {
    renderSettings()

    expect(screen.getByTestId('settings-index')).toBeTruthy()
    expect(screen.queryByTestId('settings-section')).toBeNull()
    expect(screen.queryByTestId('fake-general-tab')).toBeNull()
    expect(screen.queryByTestId('categories-tab')).toBeNull()
  })

  it('opens on General by default on desktop', () => {
    layout.desktop = true
    renderSettings()

    expect(screen.getByTestId('fake-general-tab')).toBeTruthy()
    expect(screen.queryByTestId('categories-tab')).toBeNull()
    expect(screen.getByTestId('settings-item-general').getAttribute('aria-current')).toBe('page')
  })

  it('renames Data Tools to Data', () => {
    renderSettings()

    expect(document.body.textContent).not.toContain('Data Tools')
    expect(screen.getByTestId('settings-item-data').textContent).toContain('Data')
  })

  it('falls back to the list (phone) when the search asks for the hidden Account section', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'account' })
    renderSettings()

    expect(screen.getByTestId('settings-index')).toBeTruthy()
    expect(screen.queryByTestId('fake-account-tab')).toBeNull()
    expect(screen.queryByTestId('fake-general-tab')).toBeNull()
  })

  it('falls back to General (desktop) when the search asks for the hidden Account section', () => {
    layout.desktop = true
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'account' })
    renderSettings()

    expect(screen.getByTestId('fake-general-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-account-tab')).toBeNull()
    expect(screen.queryByTestId('categories-tab')).toBeNull()
  })

  it('falls back when the search asks for the hidden Sync section (flag off)', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'sync' })
    renderSettings()
    expect(screen.getByTestId('settings-index')).toBeTruthy()
    expect(screen.queryByTestId('fake-sync-tab')).toBeNull()
    cleanup()

    layout.desktop = true
    renderSettings()
    expect(screen.getByTestId('fake-general-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-sync-tab')).toBeNull()
  })

  it('has no Sync item with the flag off', () => {
    renderSettings()

    expect(screen.queryByTestId('settings-item-sync')).toBeNull()
    expect(itemIds()).not.toContain('settings-item-sync')
  })

  it('has no Family item with the flags off', () => {
    renderSettings()

    expect(screen.queryByTestId('settings-item-family')).toBeNull()
    expect(itemIds()).not.toContain('settings-item-family')
  })

  it('has no tab bar', () => {
    renderSettings()

    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryByRole('tablist')).toBeNull()
  })
})

describe('Settings items with accounts visible', () => {
  beforeEach(() => {
    vi.mocked(useAccountsVisible).mockReturnValue(true)
  })

  it('adds the Account item last', () => {
    renderSettings()

    expect(itemIds()).toEqual([
      'settings-item-general',
      'settings-item-categories',
      'settings-item-budget',
      'settings-item-security',
      'settings-item-data',
      'settings-item-account',
    ])
    expect(screen.getByTestId('settings-item-account').textContent).toContain('Account')
  })

  it('renders the Account section for ?tab=account', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'account' })
    renderSettings()

    expect(screen.getByTestId('fake-account-tab')).toBeTruthy()
    expect(screen.queryByTestId('categories-tab')).toBeNull()
    expect(screen.queryByTestId('fake-general-tab')).toBeNull()
  })

  it('still hides the Sync item when only accounts are visible (flag off)', () => {
    renderSettings()
    expect(screen.queryByTestId('settings-item-sync')).toBeNull()
  })
})

describe('Settings section selection', () => {
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

  it('renders Budget for ?tab=budget', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'budget' })
    renderSettings()

    expect(screen.getByTestId('budget-tab')).toBeTruthy()
    expect(screen.queryByTestId('categories-tab')).toBeNull()
  })

  it('renders Security for ?tab=security', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'security' })
    renderSettings()

    expect(screen.getByTestId('security-tab')).toBeTruthy()
    expect(screen.queryByTestId('categories-tab')).toBeNull()
  })

  it('renders the Data section for ?tab=data', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'data' })
    renderSettings()

    expect(screen.getByTestId('fake-storage-status')).toBeTruthy()
    expect(screen.queryByTestId('security-tab')).toBeNull()
  })

  it('mounts only the selected section on desktop too', () => {
    layout.desktop = true
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'data' })
    renderSettings()

    expect(screen.getByTestId('fake-storage-status')).toBeTruthy()
    for (const other of ['fake-general-tab', 'categories-tab', 'budget-tab', 'security-tab']) {
      expect(screen.queryByTestId(other)).toBeNull()
    }
  })
})

describe('Settings validateSearch', () => {
  const validate = Route.options.validateSearch as unknown as (
    search: Record<string, unknown>,
  ) => { tab?: string }

  it.each(['general', 'categories', 'budget', 'security', 'data', 'account', 'sync', 'family'])(
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
