// No CONTRACT_GAPs: the Sync item rules are specified in the Interface Contract
// (Route: /settings and Module: settingsSections). The flag is a mutable getter
// so every combination of ENABLE_SYNC and accounts-visible runs here; SyncTab
// and the other section bodies are light fakes. The route now calls
// useSyncState(), so '@/lib/sync/react' is mocked (the real one would build the
// sync runtime with the flag on). ENABLE_SPACES is off, so there is no Family
// item and these counts are unchanged. The layout comes from a mutable
// useIsDesktop mock (phone by default).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setLang, translate } from '@/i18n/core'
import { useAccountsVisible } from '@/lib/accountSession'
import { getAllBudgets, getAllCategories } from '@/lib/localDb'
import { OFF_FAMILY_STATE, useFamilySyncState, useSyncState } from '@/lib/sync/react'
import { Route } from '@/routes/settings'

const flags = vi.hoisted(() => ({ sync: true }))
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
  ENABLE_ACCOUNTS: true,
  ENABLE_SPACES: false,
  get ENABLE_SYNC() {
    return flags.sync
  },
}))
vi.mock('@/lib/sync/react', () => ({
  OFF_FAMILY_STATE: {
    status: 'none',
    spaceId: null,
    role: null,
    name: null,
    readOnly: false,
    space: null,
    lastSyncAt: null,
    progress: null,
    errorCode: null,
    lastError: null,
    pendingOwnerEmail: null,
  },
  useFamilySyncState: vi.fn(),
  useFamilyAvailable: () => false,
  useSyncAvailable: () => flags.sync,
  useSyncState: vi.fn(),
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

function itemIds() {
  return screen.getAllByRole('button').map((b) => b.getAttribute('data-testid'))
}

beforeEach(() => {
  vi.resetAllMocks()
  flags.sync = true
  layout.desktop = false
  setLang('en', { persist: false })
  vi.mocked(getAllCategories).mockResolvedValue([])
  vi.mocked(getAllBudgets).mockResolvedValue([])
  vi.mocked(useAccountsVisible).mockReturnValue(true)
  vi.mocked(useFamilySyncState).mockReturnValue(OFF_FAMILY_STATE)
  vi.mocked(useSyncState).mockReturnValue({ status: 'synced' } as never)
  vi.spyOn(Route, 'useSearch').mockReturnValue({})
  vi.spyOn(Route, 'useNavigate').mockReturnValue(vi.fn() as never)
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('Sync item with ENABLE_SYNC and visible accounts', () => {
  it('adds the Sync item after Account, seven items in all', () => {
    renderSettings()

    const ids = itemIds()
    expect(ids.at(-1)).toBe('settings-item-sync')
    expect(ids.at(-2)).toBe('settings-item-account')
    expect(ids).toHaveLength(7)
  })

  it('puts Sync in the cloud group with Account', () => {
    renderSettings()

    const group = screen.getByTestId('settings-group-cloud')
    expect(group.contains(screen.getByTestId('settings-item-sync'))).toBe(true)
    expect(group.contains(screen.getByTestId('settings-item-account'))).toBe(true)
    expect(group.contains(screen.getByTestId('settings-item-general'))).toBe(false)
  })

  it('labels the item in English and in Ukrainian', () => {
    renderSettings()
    expect(screen.getByTestId('settings-item-sync').textContent).toContain(
      translate('en', 'settings.tabs.sync'),
    )
    cleanup()

    setLang('uk', { persist: false })
    renderSettings()
    const text = screen.getByTestId('settings-item-sync').textContent
    expect(text).toContain(translate('uk', 'settings.tabs.sync'))
    expect(translate('uk', 'settings.tabs.sync')).not.toBe(translate('en', 'settings.tabs.sync'))
  })

  it('renders SyncTab for ?tab=sync and nothing else', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'sync' })
    renderSettings()

    expect(screen.getByTestId('fake-sync-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-general-tab')).toBeNull()
    expect(screen.queryByTestId('fake-account-tab')).toBeNull()
    expect(screen.getByTestId('settings-section').getAttribute('data-section')).toBe('sync')
  })

  it('on desktop marks the Sync item current for ?tab=sync', () => {
    layout.desktop = true
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'sync' })
    renderSettings()

    expect(screen.getByTestId('fake-sync-tab')).toBeTruthy()
    expect(screen.getByTestId('settings-item-sync').getAttribute('aria-current')).toBe('page')
  })

  it('keeps General as the default section on desktop', () => {
    layout.desktop = true
    renderSettings()

    expect(screen.getByTestId('fake-general-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-sync-tab')).toBeNull()
  })

  it('the Account section is unchanged', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'account' })
    renderSettings()
    expect(screen.getByTestId('fake-account-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-sync-tab')).toBeNull()
  })

  it('has no Family item while ENABLE_SPACES is off', () => {
    renderSettings()
    expect(screen.queryByTestId('settings-item-family')).toBeNull()
  })

  it('shows the sync state dot from useSyncState', () => {
    vi.mocked(useSyncState).mockReturnValue({ status: 'offline' } as never)
    renderSettings()
    expect(screen.getByTestId('settings-item-sync-status').getAttribute('data-sync-indicator')).toBe(
      'offline',
    )
    cleanup()

    vi.mocked(useSyncState).mockReturnValue({ status: 'syncing' } as never)
    renderSettings()
    expect(screen.getByTestId('settings-item-sync-status').getAttribute('data-sync-indicator')).toBe(
      'syncing',
    )
  })
})

describe('Sync item hidden', () => {
  it('flag on but accounts hidden: no item, ?tab=sync falls back to the list (phone)', () => {
    vi.mocked(useAccountsVisible).mockReturnValue(false)
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'sync' })
    renderSettings()

    expect(screen.queryByTestId('settings-item-sync')).toBeNull()
    expect(screen.getByTestId('settings-index')).toBeTruthy()
    expect(screen.queryByTestId('fake-sync-tab')).toBeNull()
    expect(itemIds()).toHaveLength(5)
  })

  it('flag on but accounts hidden: ?tab=sync falls back to General (desktop)', () => {
    layout.desktop = true
    vi.mocked(useAccountsVisible).mockReturnValue(false)
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'sync' })
    renderSettings()

    expect(screen.queryByTestId('settings-item-sync')).toBeNull()
    expect(screen.getByTestId('fake-general-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-sync-tab')).toBeNull()
  })

  it('flag off but accounts visible: Account only, six items', () => {
    flags.sync = false
    renderSettings()

    expect(screen.queryByTestId('settings-item-sync')).toBeNull()
    expect(screen.getByTestId('settings-item-account')).toBeTruthy()
    expect(itemIds()).toHaveLength(6)
  })

  it('flag off: ?tab=sync falls back to the list (phone) and to General (desktop)', () => {
    flags.sync = false
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
})
