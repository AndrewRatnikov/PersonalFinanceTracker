// CONTRACT_GAP: the section header's title level (h1 on the phone, h2 on
//   desktop) is in the contract, but only the testid and text are asserted here.
// CONTRACT_GAP: the accessible name of an item is asserted as "contains the
//   label and the description" (contract wording), not as an exact string.
//
// The phone and desktop layouts of the Settings route. The layout comes from a
// mutable mock of useIsDesktop; Route.useSearch and Route.useNavigate are
// spied (no router is mounted) and the search lives in a tiny external store
// that the spied useSearch subscribes to, so a navigate call re-renders the
// page the way the router would (same harness as transactions.test.tsx).
// The section bodies are light fakes. ENABLE_SYNC, ENABLE_SPACES and the
// accounts-visible hook are mutable.
// Page-width additions: PageContainer root and the max-w-2xl section column on
// desktop (classes and DOM order only; jsdom has no layout).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Switcher from '@/lib/spaces/switcher'

import type { MySpace, SpaceMember } from '@/lib/cloud/spacesApi'
import type { FamilySyncState } from '@/lib/sync/types'
import type { SettingsSearch } from '@/routes/settings'
import { setLang, translate } from '@/i18n/core'
import { useAccountsVisible } from '@/lib/accountSession'
import { getAllBudgets, getAllCategories } from '@/lib/localDb'
import { useSpaceSwitch } from '@/lib/spaces/switcher'
import { OFF_FAMILY_STATE, useFamilySyncState, useSyncState } from '@/lib/sync/react'
import { Route } from '@/routes/settings'

const flags = vi.hoisted(() => ({ sync: true, spaces: true }))
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
  useSyncAvailable: () => flags.sync,
  useSyncState: vi.fn(),
}))
vi.mock('@/lib/spaces/switcher', async (importOriginal) => ({
  ...(await importOriginal<typeof Switcher>()),
  useSpaceSwitch: vi.fn(),
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

type SettingsId =
  | 'general'
  | 'categories'
  | 'budget'
  | 'security'
  | 'data'
  | 'account'
  | 'sync'
  | 'family'

const IDS: Array<SettingsId> = [
  'general',
  'categories',
  'budget',
  'security',
  'data',
  'account',
  'sync',
  'family',
]

const CONTENT_TESTID: Record<SettingsId, string> = {
  general: 'fake-general-tab',
  categories: 'categories-tab',
  budget: 'budget-tab',
  security: 'security-tab',
  data: 'fake-storage-status',
  account: 'fake-account-tab',
  sync: 'fake-sync-tab',
  family: 'fake-family-tab',
}

const NOW = '2026-10-30T10:00:00.000Z'

function member(
  userId: string,
  status: 'active' | 'pending',
  role: 'owner' | 'member' = 'member',
): SpaceMember {
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
  const members = [
    member('me', 'active', role),
    ...Array.from({ length: pending }, (_, i) => member(`req-${i}`, 'pending')),
  ]
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

function spaceState(
  family: { id: string; name: string } | null,
  isFamily: boolean,
): ReturnType<typeof useSpaceSwitch> {
  return {
    spaceId: isFamily && family !== null ? family.id : 'personal',
    family: family === null ? null : { ...family, role: 'owner', readOnly: false },
    isFamily,
    readOnly: false,
    paused: false,
    familyStatus: null,
    ready: true,
    directory: null,
    memberId: null,
    switchTo: vi.fn(),
    registerGuard: () => () => undefined,
  } as ReturnType<typeof useSpaceSwitch>
}

// The search store that the spied Route.useSearch reads.
let search: SettingsSearch = {}
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function useFakeSearch() {
  return useSyncExternalStore(subscribe, () => search)
}

function setSearch(next: SettingsSearch) {
  search = next
  listeners.forEach((l) => l())
}

let navigate = vi.fn<(options: { search: SettingsSearch; replace?: boolean }) => void>()

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

function openAt(tab?: SettingsId) {
  search = tab === undefined ? {} : { tab }
  return renderSettings()
}

function itemIds(): Array<string | null> {
  return screen.getAllByRole('button').map((b) => b.getAttribute('data-testid'))
}

function expectOnlyContent(id: SettingsId) {
  for (const other of IDS) {
    if (other === id) {
      expect(screen.getByTestId(CONTENT_TESTID[other])).toBeTruthy()
    } else {
      expect(screen.queryByTestId(CONTENT_TESTID[other])).toBeNull()
    }
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  flags.sync = true
  flags.spaces = true
  layout.desktop = false
  search = {}
  listeners.clear()
  setLang('en', { persist: false })
  navigate = vi.fn((options: { search: SettingsSearch; replace?: boolean }) => {
    setSearch(options.search)
  })
  vi.mocked(getAllCategories).mockResolvedValue([])
  vi.mocked(getAllBudgets).mockResolvedValue([])
  vi.mocked(useAccountsVisible).mockReturnValue(true)
  vi.mocked(useFamilySyncState).mockReturnValue(OFF_FAMILY_STATE)
  vi.mocked(useSyncState).mockReturnValue({ status: 'synced' } as never)
  vi.mocked(useSpaceSwitch).mockReturnValue(spaceState(null, false))
  vi.spyOn(Route, 'useSearch').mockImplementation(useFakeSearch)
  vi.spyOn(Route, 'useNavigate').mockReturnValue(navigate as never)
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('phone: the index at /settings', () => {
  it('shows the grouped list, the page title and no section', () => {
    openAt()

    expect(screen.getByTestId('settings-page')).toBeTruthy()
    expect(screen.getByTestId('settings-index')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(translate('en', 'settings.title'))
    expect(screen.queryByTestId('settings-sidebar')).toBeNull()
    expect(screen.queryByTestId('settings-section')).toBeNull()
    expect(screen.queryByTestId('settings-back')).toBeNull()
    for (const id of IDS) expect(screen.queryByTestId(CONTENT_TESTID[id])).toBeNull()
  })

  it('lists the three groups in order with all eight items when every flag is on', () => {
    openAt()

    expect(itemIds()).toEqual(IDS.map((id) => `settings-item-${id}`))
    expect(screen.getByTestId('settings-group-budget-title').textContent.trim()).toBe('Budget')
    expect(screen.getByTestId('settings-group-device-title').textContent.trim()).toBe('This device')
    expect(screen.getByTestId('settings-group-cloud-title').textContent.trim()).toBe(
      'Account & cloud',
    )
    const within_ = (group: string) =>
      within(screen.getByTestId(`settings-group-${group}`))
        .getAllByRole('button')
        .map((b) => b.getAttribute('data-testid'))
    expect(within_('budget')).toEqual(
      ['general', 'categories', 'budget'].map((id) => `settings-item-${id}`),
    )
    expect(within_('device')).toEqual(['settings-item-security', 'settings-item-data'])
    expect(within_('cloud')).toEqual([
      'settings-item-account',
      'settings-item-sync',
      'settings-item-family',
    ])
  })

  it('hides Account, Sync, Family and the empty cloud group when accounts are hidden', () => {
    vi.mocked(useAccountsVisible).mockReturnValue(false)
    openAt()

    expect(itemIds()).toEqual(
      ['general', 'categories', 'budget', 'security', 'data'].map((id) => `settings-item-${id}`),
    )
    expect(screen.queryByTestId('settings-group-cloud')).toBeNull()
  })

  it('shows only Account when accounts are visible and the flags are off', () => {
    flags.sync = false
    flags.spaces = false
    openAt()

    expect(screen.getByTestId('settings-item-account')).toBeTruthy()
    expect(screen.queryByTestId('settings-item-sync')).toBeNull()
    expect(screen.queryByTestId('settings-item-family')).toBeNull()
    expect(screen.getByTestId('settings-group-cloud')).toBeTruthy()
  })

  it('shows Account and Sync but not Family while ENABLE_SPACES is off', () => {
    flags.spaces = false
    openAt()

    expect(screen.getByTestId('settings-item-sync')).toBeTruthy()
    expect(screen.queryByTestId('settings-item-family')).toBeNull()
  })

  it('hides Sync and Family while ENABLE_SYNC is off, even with ENABLE_SPACES on', () => {
    flags.sync = false
    openAt()

    expect(screen.queryByTestId('settings-item-sync')).toBeNull()
    expect(screen.queryByTestId('settings-item-family')).toBeNull()
    expect(screen.getByTestId('settings-item-account')).toBeTruthy()
  })

  it.each(IDS)('item %s has an accessible name with its label and description', (id) => {
    openAt()

    const label = translate('en', `settings.tabs.${id}`)
    const description = translate('en', `settings.descriptions.${id}`)
    const button = screen.getByRole('button', {
      name: (name) => name.includes(label) && name.includes(description),
    })
    expect(button.getAttribute('data-testid')).toBe(`settings-item-${id}`)
  })

  it('exposes a navigation landmark named "Settings sections"', () => {
    openAt()

    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBe(
      screen.getByTestId('settings-index'),
    )
  })

  it('has no tab bar any more', () => {
    openAt()

    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryByRole('tablist')).toBeNull()
    for (const id of ['settings-tab-general', 'settings-tab-account', 'settings-tab-sync', 'settings-tab-family', 'settings-tab-family-badge']) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
  })
})

describe('phone: the Budget group header', () => {
  it('is "Budget" outside a Family', () => {
    openAt()

    expect(screen.getByTestId('settings-group-budget-title').textContent.trim()).toBe('Budget')
  })

  it('names the Family when it is the active space', () => {
    vi.mocked(useSpaceSwitch).mockReturnValue(spaceState({ id: 'fam-1', name: 'Home' }, true))
    openAt()

    expect(screen.getByTestId('settings-group-budget-title').textContent.trim()).toBe('Budget · Home')
  })

  it('names Personal when a Family exists but Personal is active', () => {
    vi.mocked(useSpaceSwitch).mockReturnValue(spaceState({ id: 'fam-1', name: 'Home' }, false))
    openAt()

    expect(screen.getByTestId('settings-group-budget-title').textContent.trim()).toBe(
      `Budget · ${translate('en', 'space.personal')}`,
    )
  })

  it('follows the Family name', () => {
    vi.mocked(useSpaceSwitch).mockReturnValue(spaceState({ id: 'fam-2', name: 'Cabin' }, true))
    openAt()

    expect(screen.getByTestId('settings-group-budget-title').textContent.trim()).toBe('Budget · Cabin')
  })
})

describe('phone: indicators', () => {
  it('shows the pending-requests badge to an owner', () => {
    vi.mocked(useFamilySyncState).mockReturnValue(familyState('owner', 3))
    openAt()

    expect(
      within(screen.getByTestId('settings-item-family')).getByTestId('settings-item-family-badge')
        .textContent.trim(),
    ).toBe('3')
  })

  it('follows the count', () => {
    vi.mocked(useFamilySyncState).mockReturnValue(familyState('owner', 1))
    openAt()
    expect(screen.getByTestId('settings-item-family-badge').textContent.trim()).toBe('1')
    cleanup()

    vi.mocked(useFamilySyncState).mockReturnValue(familyState('owner', 4))
    openAt()
    expect(screen.getByTestId('settings-item-family-badge').textContent.trim()).toBe('4')
  })

  it('has no badge without requests, for a member, or outside a Family', () => {
    vi.mocked(useFamilySyncState).mockReturnValue(familyState('owner', 0))
    openAt()
    expect(screen.queryByTestId('settings-item-family-badge')).toBeNull()
    cleanup()

    vi.mocked(useFamilySyncState).mockReturnValue(familyState('member', 2))
    openAt()
    expect(screen.queryByTestId('settings-item-family-badge')).toBeNull()
    cleanup()

    vi.mocked(useFamilySyncState).mockReturnValue(OFF_FAMILY_STATE)
    openAt()
    expect(screen.queryByTestId('settings-item-family-badge')).toBeNull()
  })

  it.each([
    ['synced', 'synced'],
    ['syncing', 'syncing'],
    ['offline', 'offline'],
    ['error', 'problem'],
    ['paused', 'problem'],
    ['device-removed', 'problem'],
  ] as const)('maps the sync status %s to the dot "%s"', (status, expected) => {
    vi.mocked(useSyncState).mockReturnValue({ status } as never)
    openAt()

    const dot = within(screen.getByTestId('settings-item-sync')).getByTestId('settings-item-sync-status')
    expect(dot.getAttribute('data-sync-indicator')).toBe(expected)
  })

  it('has no dot while sync is off', () => {
    vi.mocked(useSyncState).mockReturnValue({ status: 'off' } as never)
    openAt()

    expect(screen.getByTestId('settings-item-sync')).toBeTruthy()
    expect(screen.queryByTestId('settings-item-sync-status')).toBeNull()
  })
})

describe('phone: opening a section', () => {
  it('pushes ?tab=<id> when an item is tapped', () => {
    openAt()

    fireEvent.click(screen.getByTestId('settings-item-security'))

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({ search: { tab: 'security' }, replace: false })
  })

  it('pushes the id of the tapped item, whichever it is', () => {
    openAt()

    fireEvent.click(screen.getByTestId('settings-item-data'))

    expect(navigate).toHaveBeenLastCalledWith({ search: { tab: 'data' }, replace: false })
  })

  it('then shows the section with a back arrow, its title and its content only', () => {
    openAt()

    fireEvent.click(screen.getByTestId('settings-item-security'))

    expect(screen.queryByTestId('settings-index')).toBeNull()
    expect(screen.getByTestId('settings-back')).toBeTruthy()
    expect(screen.getByTestId('settings-section-title').textContent.trim()).toBe(
      translate('en', 'settings.tabs.security'),
    )
    expect(screen.getByTestId('settings-section').getAttribute('data-section')).toBe('security')
    expectOnlyContent('security')
  })

  it('labels the back arrow "Back to settings"', () => {
    openAt('data')

    const back = screen.getByTestId('settings-back')
    expect(back.getAttribute('aria-label')).toBe('Back to settings')
    expect(screen.getByRole('button', { name: 'Back to settings' })).toBe(back)
  })

  it('puts the section content inside the section wrapper', () => {
    openAt('categories')

    expect(
      within(screen.getByTestId('settings-section')).getByTestId('categories-tab'),
    ).toBeTruthy()
  })

  it('goes back to the list with replace, wherever the section was opened from', () => {
    openAt()
    fireEvent.click(screen.getByTestId('settings-item-security'))

    fireEvent.click(screen.getByTestId('settings-back'))

    expect(navigate).toHaveBeenLastCalledWith({ search: {}, replace: true })
    expect(screen.getByTestId('settings-index')).toBeTruthy()
    expect(screen.queryByTestId('settings-section')).toBeNull()
    expect(screen.queryByTestId('security-tab')).toBeNull()
  })

  it('goes back from a direct deep link with no history', () => {
    openAt('sync')

    fireEvent.click(screen.getByTestId('settings-back'))

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({ search: {}, replace: true })
    expect(screen.getByTestId('settings-index')).toBeTruthy()
  })
})

describe('phone: deep links', () => {
  it.each(IDS)('?tab=%s shows that section with the back arrow', (id) => {
    openAt(id)

    expect(screen.getByTestId('settings-section').getAttribute('data-section')).toBe(id)
    expect(screen.getByTestId('settings-section-title').textContent.trim()).toBe(
      translate('en', `settings.tabs.${id}`),
    )
    expect(screen.getByTestId('settings-back')).toBeTruthy()
    expect(screen.queryByTestId('settings-index')).toBeNull()
    expectOnlyContent(id)
  })

  it('shows the Account section for the login redirect search { tab: "account" }', () => {
    openAt('account')

    expect(screen.getByTestId('fake-account-tab')).toBeTruthy()
    expect(screen.getByTestId('settings-back')).toBeTruthy()
    expect(screen.getByTestId('settings-section-title').textContent.trim()).toBe(
      translate('en', 'settings.tabs.account'),
    )
  })

  it('titles the section in Ukrainian', () => {
    setLang('uk', { persist: false })
    openAt('data')

    const title = screen.getByTestId('settings-section-title').textContent.trim()
    expect(title).toBe(translate('uk', 'settings.tabs.data'))
    expect(title).not.toBe(translate('en', 'settings.tabs.data'))
  })

  it.each([
    ['accounts hidden: ?tab=account', 'account', () => vi.mocked(useAccountsVisible).mockReturnValue(false)],
    ['accounts hidden: ?tab=sync', 'sync', () => vi.mocked(useAccountsVisible).mockReturnValue(false)],
    ['ENABLE_SYNC off: ?tab=sync', 'sync', () => { flags.sync = false }],
    ['ENABLE_SPACES off: ?tab=family', 'family', () => { flags.spaces = false }],
    ['ENABLE_SYNC off: ?tab=family', 'family', () => { flags.sync = false }],
  ] as const)('%s falls back to the list', (_name, tab, apply) => {
    apply()
    openAt(tab)

    expect(screen.getByTestId('settings-index')).toBeTruthy()
    expect(screen.queryByTestId('settings-section')).toBeNull()
    expect(screen.queryByTestId('settings-back')).toBeNull()
    for (const id of IDS) expect(screen.queryByTestId(CONTENT_TESTID[id])).toBeNull()
  })
})

describe('phone: Family can open Sync', () => {
  it('navigates to ?tab=sync as a push', () => {
    openAt('family')

    fireEvent.click(screen.getByLabelText('open-sync-from-family'))

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({ search: { tab: 'sync' }, replace: false })
    expect(screen.getByTestId('fake-sync-tab')).toBeTruthy()
    expect(screen.queryByTestId('fake-family-tab')).toBeNull()
  })
})

describe('desktop: the sidebar layout', () => {
  beforeEach(() => {
    layout.desktop = true
  })

  it('shows the sidebar and General at /settings, with no list and no back arrow', () => {
    openAt()

    expect(screen.getByTestId('settings-sidebar')).toBeTruthy()
    expect(screen.queryByTestId('settings-index')).toBeNull()
    expect(screen.queryByTestId('settings-back')).toBeNull()
    expect(screen.getByTestId('settings-section').getAttribute('data-section')).toBe('general')
    expectOnlyContent('general')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(translate('en', 'settings.title'))
    expect(screen.getByTestId('settings-section-title').textContent.trim()).toBe(
      translate('en', 'settings.tabs.general'),
    )
  })

  it('exposes a navigation landmark named "Settings sections"', () => {
    openAt()

    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBe(
      screen.getByTestId('settings-sidebar'),
    )
  })

  it('marks General current by default and nothing else', () => {
    openAt()

    expect(screen.getByTestId('settings-item-general').getAttribute('aria-current')).toBe('page')
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
  })

  it('lists the same groups and items as the phone', () => {
    openAt()

    expect(itemIds().filter((id) => id?.startsWith('settings-item-'))).toEqual(
      IDS.map((id) => `settings-item-${id}`),
    )
    expect(screen.getByTestId('settings-group-budget-title').textContent.trim()).toBe('Budget')
  })

  it('hides unavailable items like the phone does', () => {
    vi.mocked(useAccountsVisible).mockReturnValue(false)
    openAt()

    expect(screen.queryByTestId('settings-item-account')).toBeNull()
    expect(screen.queryByTestId('settings-item-sync')).toBeNull()
    expect(screen.queryByTestId('settings-item-family')).toBeNull()
    expect(screen.queryByTestId('settings-group-cloud')).toBeNull()
  })

  it('names the Family in the Budget header', () => {
    vi.mocked(useSpaceSwitch).mockReturnValue(spaceState({ id: 'fam-1', name: 'Home' }, true))
    openAt()

    expect(screen.getByTestId('settings-group-budget-title').textContent.trim()).toBe('Budget · Home')
  })

  it('shows the Family badge and the Sync dot in the sidebar', () => {
    vi.mocked(useFamilySyncState).mockReturnValue(familyState('owner', 2))
    vi.mocked(useSyncState).mockReturnValue({ status: 'syncing' } as never)
    openAt()

    expect(screen.getByTestId('settings-item-family-badge').textContent.trim()).toBe('2')
    expect(screen.getByTestId('settings-item-sync-status').getAttribute('data-sync-indicator')).toBe(
      'syncing',
    )
  })

  it.each(IDS)('?tab=%s shows that section and marks it current', (id) => {
    openAt(id)

    expect(screen.getByTestId('settings-section').getAttribute('data-section')).toBe(id)
    expect(screen.getByTestId(`settings-item-${id}`).getAttribute('aria-current')).toBe('page')
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
    expect(screen.queryByTestId('settings-back')).toBeNull()
    expectOnlyContent(id)
  })

  it('replaces ?tab=<id> when an item is clicked', () => {
    openAt()

    fireEvent.click(screen.getByTestId('settings-item-data'))

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({ search: { tab: 'data' }, replace: true })
  })

  it('switches the section and the current item after a click', () => {
    openAt()

    fireEvent.click(screen.getByTestId('settings-item-security'))

    expect(screen.getByTestId('settings-section').getAttribute('data-section')).toBe('security')
    expectOnlyContent('security')
    expect(screen.getByTestId('settings-item-security').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('settings-item-general').hasAttribute('aria-current')).toBe(false)
    expect(screen.getByTestId('settings-section-title').textContent.trim()).toBe(
      translate('en', 'settings.tabs.security'),
    )
  })

  it.each([
    ['accounts hidden: ?tab=account', 'account', () => vi.mocked(useAccountsVisible).mockReturnValue(false)],
    ['ENABLE_SYNC off: ?tab=sync', 'sync', () => { flags.sync = false }],
    ['ENABLE_SPACES off: ?tab=family', 'family', () => { flags.spaces = false }],
  ] as const)('%s falls back to General', (_name, tab, apply) => {
    apply()
    openAt(tab)

    expect(screen.getByTestId('settings-section').getAttribute('data-section')).toBe('general')
    expectOnlyContent('general')
    expect(screen.getByTestId('settings-item-general').getAttribute('aria-current')).toBe('page')
  })

  it('Family can open Sync as a replace', () => {
    openAt('family')

    fireEvent.click(screen.getByLabelText('open-sync-from-family'))

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({ search: { tab: 'sync' }, replace: true })
    expect(screen.getByTestId('fake-sync-tab')).toBeTruthy()
    expect(screen.getByTestId('settings-item-sync').getAttribute('aria-current')).toBe('page')
  })

  it('has no tab bar', () => {
    openAt()

    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryByRole('tablist')).toBeNull()
  })
})

describe('the Budget section error path', () => {
  it.each([false, true])('shows the retry state when the categories fail to load (desktop: %s)', async (desktop) => {
    layout.desktop = desktop
    vi.mocked(getAllCategories).mockRejectedValue(new Error('boom'))
    openAt('budget')

    await waitFor(() => {
      expect(screen.getByTestId('query-error')).toBeTruthy()
    })
    expect(screen.queryByTestId('budget-tab')).toBeNull()
  })

  it('mounts the Budget tab when the categories load', async () => {
    openAt('budget')

    await waitFor(() => {
      expect(screen.getByTestId('budget-tab')).toBeTruthy()
    })
    expect(screen.queryByTestId('query-error')).toBeNull()
  })
})

describe('page container and section column', () => {
  const classesOf = (el: Element) => el.className.split(/\s+/)

  it.each([false, true])('settings-page is a full-width PageContainer (desktop: %s)', (desktop) => {
    layout.desktop = desktop
    openAt()

    const page = screen.getByTestId('settings-page')
    expect(page.getAttribute('data-page-container')).toBe('full')
    const classes = classesOf(page)
    for (const token of ['max-w-6xl', 'mx-auto', 'px-4', 'md:px-8', 'flex', 'flex-col', 'gap-8']) {
      expect(classes, token).toContain(token)
    }
    expect(classes).not.toContain('md:max-w-5xl')
    expect(classes).not.toContain('max-w-xl')
    expect(classes).not.toContain('sm:px-6')
  })

  it('on desktop the section sits in a column capped at max-w-2xl next to the sidebar', () => {
    layout.desktop = true
    openAt('security')

    const content = screen.getByTestId('settings-content')
    const classes = classesOf(content)
    for (const token of ['max-w-2xl', 'min-w-0', 'flex', 'flex-col', 'gap-6']) {
      expect(classes, token).toContain(token)
    }
    expect(content.contains(screen.getByTestId('settings-section-title'))).toBe(true)
    expect(content.contains(screen.getByTestId('settings-section'))).toBe(true)
    expect(content.contains(screen.getByTestId('security-tab'))).toBe(true)
    expect(content.contains(screen.getByTestId('settings-sidebar'))).toBe(false)
    expect(
      screen.getByTestId('settings-sidebar').compareDocumentPosition(content) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.getByTestId('settings-page').contains(content)).toBe(true)
  })

  it('the section column follows the chosen section', () => {
    layout.desktop = true
    openAt('security')
    expect(within(screen.getByTestId('settings-content')).queryByTestId('categories-tab')).toBeNull()

    fireEvent.click(screen.getByTestId(`settings-item-${'categories'}`))

    expect(within(screen.getByTestId('settings-content')).getByTestId('categories-tab')).toBeTruthy()
    expect(within(screen.getByTestId('settings-content')).queryByTestId('security-tab')).toBeNull()
  })

  it('the phone layout has no section column', () => {
    layout.desktop = false
    openAt('security')

    expect(screen.queryByTestId('settings-content')).toBeNull()
    expect(screen.getByTestId('settings-section')).toBeTruthy()
  })

  it('the phone index has no section column either', () => {
    layout.desktop = false
    openAt()

    expect(screen.queryByTestId('settings-content')).toBeNull()
  })
})
