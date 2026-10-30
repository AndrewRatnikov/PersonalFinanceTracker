// No CONTRACT_GAPs: the Sync tab rules are specified in plan section 10
// (Settings route) and the Interface Contract (route: settings). The flag is a
// mutable getter so every combination of ENABLE_SYNC and accounts-visible runs
// here; SyncTab and the other tab bodies are light fakes. Family run: the
// featureFlags mock gains ENABLE_SPACES: false, so these counts are unchanged.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setLang, translate } from '@/i18n/core'
import { useAccountsVisible } from '@/lib/accountSession'
import { getAllBudgets, getAllCategories } from '@/lib/localDb'
import { Route } from '@/routes/settings'

const flags = vi.hoisted(() => ({ sync: true }))

vi.mock('@/lib/localDb', () => ({
  getAllCategories: vi.fn(),
  getAllBudgets: vi.fn(),
}))
vi.mock('@/lib/accountSession', () => ({
  useAccountsVisible: vi.fn(),
  useAccountSession: vi.fn(),
}))
vi.mock('@/lib/featureFlags', () => ({
  ENABLE_ACCOUNTS: true,
  ENABLE_SPACES: false,
  get ENABLE_SYNC() {
    return flags.sync
  },
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  )
}

function tabIds() {
  return screen.getAllByRole('tab').map((t) => t.getAttribute('data-testid'))
}

beforeEach(() => {
  vi.resetAllMocks()
  flags.sync = true
  setLang('en', { persist: false })
  vi.mocked(getAllCategories).mockResolvedValue([])
  vi.mocked(getAllBudgets).mockResolvedValue([])
  vi.mocked(useAccountsVisible).mockReturnValue(true)
  vi.spyOn(Route, 'useSearch').mockReturnValue({})
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('Sync tab with ENABLE_SYNC and visible accounts', () => {
  it('adds the Sync trigger after Account with a seven-column grid', () => {
    renderSettings()

    const ids = tabIds()
    expect(ids.at(-1)).toBe('settings-tab-sync')
    expect(ids.at(-2)).toBe('settings-tab-account')
    expect(screen.getAllByRole('tab')).toHaveLength(7)
    expect(screen.getAllByRole('tablist')[0].className.includes('grid-cols-7')).toBe(true)
  })

  it('labels the trigger in English and in Ukrainian', () => {
    renderSettings()
    expect(screen.getByTestId('settings-tab-sync').textContent.trim()).toBe(
      translate('en', 'settings.tabs.sync'),
    )
    cleanup()

    setLang('uk', { persist: false })
    renderSettings()
    const label = screen.getByTestId('settings-tab-sync').textContent.trim()
    expect(label).toBe(translate('uk', 'settings.tabs.sync'))
    expect(label).not.toBe(translate('en', 'settings.tabs.sync'))
  })

  it('renders SyncTab for ?tab=sync and nothing else', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'sync' })
    renderSettings()

    expect(screen.getByTestId('fake-sync-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-general-tab')).toBeNull()
    expect(screen.queryByTestId('fake-account-tab')).toBeNull()
    expect(screen.getByTestId('settings-tab-sync').getAttribute('data-state')).toBe('active')
  })

  it('keeps General as the default tab', () => {
    renderSettings()
    expect(screen.getByTestId('fake-general-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-sync-tab')).toBeNull()
  })

  it('the Account tab is unchanged', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'account' })
    renderSettings()
    expect(screen.getByTestId('fake-account-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-sync-tab')).toBeNull()
  })

  it('has no Family trigger while ENABLE_SPACES is off', () => {
    renderSettings()
    expect(screen.queryByTestId('settings-tab-family')).toBeNull()
  })
})

describe('Sync tab hidden', () => {
  it('flag on but accounts hidden: no trigger, ?tab=sync falls back to General', () => {
    vi.mocked(useAccountsVisible).mockReturnValue(false)
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'sync' })
    renderSettings()

    expect(screen.queryByTestId('settings-tab-sync')).toBeNull()
    expect(screen.getByTestId('fake-general-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-sync-tab')).toBeNull()
    expect(screen.getAllByRole('tablist')[0].className.includes('grid-cols-5')).toBe(true)
  })

  it('flag off but accounts visible: Account only, six columns', () => {
    flags.sync = false
    renderSettings()

    expect(screen.queryByTestId('settings-tab-sync')).toBeNull()
    expect(screen.getByTestId('settings-tab-account')).toBeTruthy()
    expect(screen.getAllByRole('tablist')[0].className.includes('grid-cols-6')).toBe(true)
  })

  it('flag off: ?tab=sync falls back to General', () => {
    flags.sync = false
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'sync' })
    renderSettings()
    expect(screen.getByTestId('fake-general-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-sync-tab')).toBeNull()
  })
})
