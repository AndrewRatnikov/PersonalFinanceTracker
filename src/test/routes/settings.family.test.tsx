// CONTRACT_GAP: the Family trigger's position is asserted as "after Sync" (the
//   last trigger), the order given in plan section 7 (tabs gain 'family' last).
// CONTRACT_GAP: opening the Sync tab from the Family tab is driven by a fake
//   FamilyTab that calls its onOpenSyncTab prop; Radix triggers are activated
//   with mouseDown.
//
// The Family tab rules of the Settings route: flags, badge, controlled tabs.
// ENABLE_SPACES, ENABLE_SYNC and the accounts-visible hook are mutable.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Lang } from '@/i18n/lang'
import type { MySpace, SpaceMember } from '@/lib/cloud/spacesApi'
import type { FamilySyncState } from '@/lib/sync/types'
import { setLang, translate } from '@/i18n/core'
import { useAccountsVisible } from '@/lib/accountSession'
import { getAllBudgets, getAllCategories } from '@/lib/localDb'
import { OFF_FAMILY_STATE, useFamilySyncState } from '@/lib/sync/react'
import { Route } from '@/routes/settings'

const flags = vi.hoisted(() => ({ sync: true, spaces: true }))

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
  get ENABLE_SYNC() {
    return flags.sync
  },
  get ENABLE_SPACES() {
    return flags.spaces
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
  useFamilyAvailable: () => flags.sync && flags.spaces,
  useSyncState: vi.fn(() => ({ status: 'synced' })),
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
vi.mock('@/components/settings/FamilyTab', () => ({
  FamilyTab: ({ onOpenSyncTab }: { onOpenSyncTab?: () => void }) => (
    <div data-testid="fake-family-tab">
      <button type="button" aria-label="open-sync-from-family" onClick={() => onOpenSyncTab?.()} />
    </div>
  ),
}))

const NOW = '2026-10-30T10:00:00.000Z'

function member(userId: string, status: 'active' | 'pending', role: 'owner' | 'member' = 'member'): SpaceMember {
  return {
    user_id: userId,
    email: `${userId}@example.com`,
    role,
    status,
    public_key: { kty: 'EC', crv: 'P-256', x: 'A', y: 'B' },
    requested_at: NOW,
    joined_at: status === 'active' ? NOW : null,
  }
}

function familyState(role: 'owner' | 'member', pending: number): FamilySyncState {
  const members = [member('me', 'active', role), ...Array.from({ length: pending }, (_, i) => member(`req-${i}`, 'pending'))]
  const space = {
    space_id: 's1',
    role,
    status: 'active',
    key_version: 1,
    owner_id: 'me',
    members,
    my_keys: [],
    open_invites: [],
    paused: false,
    limits: null,
    last_seq: 0,
    record_count: 0,
    total_bytes: 0,
  } as MySpace
  return { ...OFF_FAMILY_STATE, status: 'synced', spaceId: 's1', role, name: 'Home', space }
}

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
  flags.spaces = true
  setLang('en', { persist: false })
  vi.mocked(getAllCategories).mockResolvedValue([])
  vi.mocked(getAllBudgets).mockResolvedValue([])
  vi.mocked(useAccountsVisible).mockReturnValue(true)
  vi.mocked(useFamilySyncState).mockReturnValue(OFF_FAMILY_STATE)
  vi.spyOn(Route, 'useSearch').mockReturnValue({})
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('the Family trigger', () => {
  it('is the last of eight tabs with an eight-column grid when all flags are on', () => {
    renderSettings()

    expect(tabIds().at(-1)).toBe('settings-tab-family')
    expect(tabIds().at(-2)).toBe('settings-tab-sync')
    expect(screen.getAllByRole('tab')).toHaveLength(8)
    expect(screen.getAllByRole('tablist')[0].className.includes('grid-cols-8')).toBe(true)
  })

  it.each<Lang>(['en', 'uk'])('is labelled in %s', (lang) => {
    setLang(lang, { persist: false })
    renderSettings()

    expect(screen.getByTestId('settings-tab-family').textContent.replace(/\d+$/, '').trim()).toBe(translate(lang, 'settings.tabs.family'))
  })

  it('the English and Ukrainian labels differ', () => {
    expect(translate('uk', 'settings.tabs.family')).not.toBe(translate('en', 'settings.tabs.family'))
  })

  it.each([
    ['ENABLE_SPACES off', () => { flags.spaces = false }],
    ['ENABLE_SYNC off', () => { flags.sync = false }],
    ['accounts hidden', () => { vi.mocked(useAccountsVisible).mockReturnValue(false) }],
  ])('is absent with %s, and ?tab=family falls back to General', (_name, apply) => {
    apply()
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'family' })
    renderSettings()

    expect(screen.queryByTestId('settings-tab-family')).toBeNull()
    expect(screen.queryByTestId('fake-family-tab')).toBeNull()
    expect(screen.getByTestId('fake-general-tab')).toBeTruthy()
  })

  it('renders the Family tab for ?tab=family and nothing else', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'family' })
    renderSettings()

    expect(screen.getByTestId('fake-family-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-general-tab')).toBeNull()
    expect(screen.getByTestId('settings-tab-family').getAttribute('data-state')).toBe('active')
  })

  it('keeps General as the default tab', () => {
    renderSettings()

    expect(screen.getByTestId('fake-general-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-family-tab')).toBeNull()
  })
})

describe('the pending-requests badge', () => {
  it('shows the number of requests to the owner', () => {
    vi.mocked(useFamilySyncState).mockReturnValue(familyState('owner', 3))
    renderSettings()

    expect(screen.getByTestId('settings-tab-family-badge').textContent.trim()).toBe('3')
  })

  it('follows the count', () => {
    vi.mocked(useFamilySyncState).mockReturnValue(familyState('owner', 1))
    renderSettings()
    expect(screen.getByTestId('settings-tab-family-badge').textContent.trim()).toBe('1')
    cleanup()

    vi.mocked(useFamilySyncState).mockReturnValue(familyState('owner', 4))
    renderSettings()
    expect(screen.getByTestId('settings-tab-family-badge').textContent.trim()).toBe('4')
  })

  it('is absent when there are no requests', () => {
    vi.mocked(useFamilySyncState).mockReturnValue(familyState('owner', 0))
    renderSettings()

    expect(screen.queryByTestId('settings-tab-family-badge')).toBeNull()
  })

  it('is absent for a member even when the snapshot lists pending users', () => {
    vi.mocked(useFamilySyncState).mockReturnValue(familyState('member', 2))
    renderSettings()

    expect(screen.queryByTestId('settings-tab-family-badge')).toBeNull()
  })

  it('is absent outside a Family', () => {
    renderSettings()

    expect(screen.queryByTestId('settings-tab-family-badge')).toBeNull()
  })
})

describe('controlled tabs', () => {
  it('the Family tab can switch to the Sync tab', () => {
    vi.spyOn(Route, 'useSearch').mockReturnValue({ tab: 'family' })
    renderSettings()

    fireEvent.click(screen.getByLabelText('open-sync-from-family'))

    expect(screen.getByTestId('fake-sync-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-family-tab')).toBeNull()
    expect(screen.getByTestId('settings-tab-sync').getAttribute('data-state')).toBe('active')
  })

  it('clicking a trigger still switches tabs', () => {
    renderSettings()

    fireEvent.mouseDown(screen.getByTestId('settings-tab-family'), { button: 0, ctrlKey: false })

    expect(screen.getByTestId('fake-family-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-general-tab')).toBeNull()
  })
})
