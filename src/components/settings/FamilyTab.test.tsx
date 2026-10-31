// CONTRACT_GAP: how a member's Leave and the owner's Delete are reached is only
//   given by the testids family-leave-btn / family-leave-confirm /
//   family-delete-btn; the delete dialog's own controls (family-delete-*) are
//   covered in FamilyDeleteDialog.test.tsx.
// CONTRACT_GAP: the limit line uses `limits.max_members` of MySpace; the
//   disabled state of family-invite-btn at the limit is asserted through
//   `.disabled`.
//
// jsdom, mocked APIs: every state of the Family tab, in en and uk. The hooks,
// the runtime, the entitlements and the backup are fakes; there is no jest-dom.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { Lang } from '@/i18n/lang'
import type { MySpace, SpaceMember } from '@/lib/cloud/spacesApi'
import type { SyncStatus } from '@/lib/cloud/types'
import type { FamilySyncState, SyncState } from '@/lib/sync/types'
import { setLang, translate } from '@/i18n/core'
import { useAccountSession } from '@/lib/accountSession'
import { useSyncStatus } from '@/lib/cloud/entitlements'
import { OFF_FAMILY_STATE, useFamilySyncState, useSyncState } from '@/lib/sync/react'
import { getSyncRuntime } from '@/lib/sync/runtime'
import { safetyCode } from '@/lib/spaces/spaceCrypto'
import { FamilyTab } from '@/components/settings/FamilyTab'

vi.mock('@/lib/featureFlags', () => ({ ENABLE_ACCOUNTS: true, ENABLE_SYNC: true, ENABLE_SPACES: true }))
vi.mock('@/lib/accountSession', () => ({
  useAccountSession: vi.fn(),
  useAccountsVisible: () => true,
}))
vi.mock('@/lib/cloud/entitlements', () => ({
  useSyncStatus: vi.fn(),
  hasFeature: (status: { limits?: Record<string, unknown> } | null | undefined, feature: string) =>
    status?.limits?.[feature] === true,
  SYNC_STATUS_QUERY_KEY: ['sync-status'],
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
  useSyncState: vi.fn(),
  useFamilySyncState: vi.fn(),
  useFamilyAvailable: () => true,
}))
vi.mock('@/lib/sync/runtime', () => ({ getSyncRuntime: vi.fn() }))
vi.mock('@/lib/backup', () => ({ downloadBackup: vi.fn(() => Promise.resolve()) }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => (
    <a href={to} {...(rest as object)}>
      {children}
    </a>
  ),
}))

const SPACE = 'a1b2c3d4-0000-4000-8000-0000000000a1'
const ME = 'user-me'
const BOB = 'user-bob'
const CAROL = 'user-carol'
const NOW = '2026-10-30T10:00:00.000Z'

const familyActions = {
  createFamily: vi.fn(),
  createInvite: vi.fn(),
  revokeInvite: vi.fn(),
  approveMember: vi.fn(),
  rejectMember: vi.fn(),
  removeMember: vi.fn(),
  leaveFamily: vi.fn(),
  transferOwnership: vi.fn(),
  deleteFamily: vi.fn(),
  forgetFamily: vi.fn(),
  renameFamily: vi.fn(),
  setMyDisplayName: vi.fn(),
  refresh: vi.fn(),
  mySafetyCode: vi.fn(),
  getOverview: vi.fn(),
}

function member(userId: string, status: 'active' | 'pending', role: 'owner' | 'member' = 'member'): SpaceMember {
  return {
    user_id: userId,
    email: `${userId}@example.com`,
    role,
    status,
    public_key: { kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'BBBB' },
    requested_at: NOW,
    joined_at: status === 'active' ? NOW : null,
  }
}

function mySpace(over: Partial<MySpace> = {}): MySpace {
  return {
    space_id: SPACE,
    role: 'owner',
    status: 'active',
    key_version: 1,
    owner_id: ME,
    members: [member(ME, 'active', 'owner'), member(BOB, 'active')],
    my_keys: [],
    open_invites: [],
    paused: false,
    limits: { max_members: 5 },
    last_seq: 0,
    record_count: 0,
    total_bytes: 0,
    ...over,
  }
}

function family(over: Partial<FamilySyncState> = {}): FamilySyncState {
  return {
    ...OFF_FAMILY_STATE,
    status: 'synced',
    spaceId: SPACE,
    role: 'owner',
    name: 'Home',
    space: mySpace(),
    lastSyncAt: NOW,
    ...over,
  }
}

function personal(status: SyncState['status']): SyncState {
  return { status, lastSyncAt: null, progress: null, errorCode: null, lastError: null, deviceId: 'device-1' }
}

function planStatus(sharedSpaces: boolean): SyncStatus {
  return {
    plan_id: 'family',
    has_sync: true,
    free_for_all: false,
    granted_by: 'entitlement',
    beta_joined_at: null,
    entitlement_status: 'active',
    current_period_end: null,
    limits: { sync: true, shared_spaces: sharedSpaces, max_devices: 5, max_records: 1, max_bytes: 1 },
    vault: null,
    devices_count: 1,
  }
}

function renderTab(props: { onOpenSyncTab?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FamilyTab {...props} />
    </QueryClientProvider>,
  )
}

function use(options: { family?: FamilySyncState; personal?: SyncState['status']; signedIn?: boolean; plan?: SyncStatus | 'loading' } = {}) {
  vi.mocked(useAccountSession).mockReturnValue(options.signedIn === false ? null : { userId: ME, email: `${ME}@example.com` })
  vi.mocked(useSyncState).mockReturnValue(personal(options.personal ?? 'synced'))
  vi.mocked(useFamilySyncState).mockReturnValue(options.family ?? OFF_FAMILY_STATE)
  const plan = options.plan ?? planStatus(true)
  vi.mocked(useSyncStatus).mockReturnValue(
    plan === 'loading' ? { state: 'loading' } : { state: 'ready', status: plan },
  )
}

const LANGS: Array<Lang> = ['en', 'uk']

function t(lang: Lang, key: string, params?: Record<string, string | number>): string {
  return translate(lang, key as never, params as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  setLang('en', { persist: false })
  vi.mocked(getSyncRuntime).mockReturnValue({ familyActions, family: {}, actions: {}, engine: {} } as never)
  familyActions.getOverview.mockResolvedValue({
    info: { id: 'space', name: 'Home', createdAt: NOW, updatedAt: NOW },
    profiles: [{ id: ME, displayName: 'Me', color: 'var(--chart-1)', updatedAt: NOW }],
    entryCount: 12,
  })
  familyActions.mySafetyCode.mockResolvedValue('AAAA-BBBB-CCCC')
  familyActions.createFamily.mockResolvedValue({ kind: 'created', spaceId: SPACE })
  for (const fn of ['revokeInvite', 'approveMember', 'rejectMember', 'removeMember', 'leaveFamily', 'transferOwnership', 'deleteFamily', 'forgetFamily', 'renameFamily', 'setMyDisplayName']) {
    familyActions[fn as keyof typeof familyActions].mockResolvedValue(undefined)
  }
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe.each(LANGS)('the plain states (%s)', (lang) => {
  beforeEach(() => setLang(lang, { persist: false }))

  it('not signed in shows the sign-in card with a link', () => {
    use({ signedIn: false })
    renderTab()

    expect(screen.getByTestId('family-tab')).toBeTruthy()
    expect(screen.getByTestId('family-sign-in-card').textContent).toContain(t(lang, 'family.signIn.body'))
    expect(screen.getByTestId('family-sign-in-link')).toBeTruthy()
    expect(screen.queryByTestId('family-create-form')).toBeNull()
  })

  it('sync off asks to turn sync on and the button opens the Sync tab', () => {
    use({ personal: 'off' })
    const onOpenSyncTab = vi.fn()
    renderTab({ onOpenSyncTab })

    expect(screen.getByTestId('family-sync-off').textContent).toContain(t(lang, 'family.syncOff.body'))
    fireEvent.click(screen.getByTestId('family-sync-settings-btn'))
    expect(onOpenSyncTab).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('family-create-form')).toBeNull()
  })

  it('a plan without shared_spaces shows the not-in-plan text', () => {
    use({ plan: planStatus(false) })
    renderTab()

    expect(screen.getByTestId('family-not-in-plan').textContent).toContain(t(lang, 'family.notInPlan'))
    expect(screen.queryByTestId('family-create-form')).toBeNull()
  })

  it('shows loading while the plan is being fetched', () => {
    use({ plan: 'loading' })
    renderTab()

    expect(screen.getByTestId('family-loading')).toBeTruthy()
    expect(screen.queryByTestId('family-not-in-plan')).toBeNull()
    expect(screen.queryByTestId('family-create-form')).toBeNull()
  })

  it('the create form defaults the name to "Family" in the current language', () => {
    use({})
    renderTab()

    expect(screen.getByTestId('family-create-form')).toBeTruthy()
    expect(screen.getByTestId<HTMLInputElement>('family-create-name').value).toBe(t(lang, 'family.defaultName'))
  })
})

describe('the default names differ per language', () => {
  it('Family in English and Сім\'я in Ukrainian', () => {
    expect(t('en', 'family.defaultName')).toBe('Family')
    expect(t('uk', 'family.defaultName')).not.toBe('Family')
  })
})

describe('creating a Family', () => {
  it('submits the typed name', async () => {
    use({})
    renderTab()

    fireEvent.change(screen.getByTestId('family-create-name'), { target: { value: 'Our Home' } })
    fireEvent.click(screen.getByTestId('family-create-submit'))

    await waitFor(() => expect(familyActions.createFamily).toHaveBeenCalledWith({ name: 'Our Home' }))
  })

  it('shows an action error in family-action-error', async () => {
    use({})
    familyActions.createFamily.mockRejectedValue(Object.assign(new Error('x'), { name: 'CloudError', code: 'member_limit' }))
    renderTab()

    fireEvent.click(screen.getByTestId('family-create-submit'))

    const box = await screen.findByTestId('family-action-error')
    expect(box.textContent).toContain(t('en', 'family.errors.memberLimit'))
  })
})

describe.each(LANGS)('pending approval (%s)', (lang) => {
  beforeEach(() => setLang(lang, { persist: false }))

  it('names the owner and shows my safety code', async () => {
    use({ family: family({ status: 'pending-approval', role: 'member', space: null, spaceId: SPACE, pendingOwnerEmail: 'owner@example.com' }) })
    renderTab()

    const pending = screen.getByTestId('family-pending')
    expect(pending.textContent).toContain(t(lang, 'family.pending.waiting', { email: 'owner@example.com' }))
    await waitFor(() => expect(screen.getByTestId('family-my-safety-code').textContent).toContain('AAAA-BBBB-CCCC'))
    expect(screen.queryByTestId('family-overview')).toBeNull()
  })

  it('uses the generic text on a device that did not ask', () => {
    use({ family: family({ status: 'pending-approval', role: 'member', space: null, pendingOwnerEmail: null }) })
    renderTab()

    expect(screen.getByTestId('family-pending').textContent).toContain(t(lang, 'family.pending.waitingOwner'))
  })
})

describe.each(LANGS)('read-only states (%s)', (lang) => {
  beforeEach(() => setLang(lang, { persist: false }))

  it.each(['removed', 'space-gone'] as const)('%s shows the read-only text and Remove from this device', async (status) => {
    use({ family: family({ status, readOnly: true, space: null, name: 'Home' }) })
    renderTab()

    const box = screen.getByTestId('family-read-only')
    expect(box.textContent).toContain(t(lang, 'family.readOnly.body', { name: 'Home' }))
    expect(screen.queryByTestId('family-invite-btn')).toBeNull()
    fireEvent.click(screen.getByTestId('family-forget-btn'))
    await waitFor(() => expect(familyActions.forgetFamily).toHaveBeenCalledWith(SPACE))
  })
})

describe.each(LANGS)('the owner overview (%s)', (lang) => {
  beforeEach(() => setLang(lang, { persist: false }))

  it('shows the state, last sync, plan line and the entry count', async () => {
    use({ family: family() })
    renderTab()

    expect(screen.getByTestId('family-overview')).toBeTruthy()
    expect(screen.getByTestId('family-sync-state').textContent).toContain(t(lang, 'family.state.synced'))
    expect(screen.getByTestId('family-last-sync').textContent).toContain(t(lang, 'family.lastSync', { when: '' }).split('{')[0].trim())
    expect(screen.getByTestId('family-plan-line').textContent).toBe(t(lang, 'family.planLine', { count: 2, max: 5 }))
    await waitFor(() => expect(screen.getByTestId('family-entry-count').textContent).toContain('12'))
  })

  it('each state shows its own line', () => {
    use({ family: family({ status: 'syncing' }) })
    renderTab()
    expect(screen.getByTestId('family-sync-state').textContent).toContain(t(lang, 'family.state.syncing'))
    cleanup()

    use({ family: family({ status: 'offline' }) })
    renderTab()
    expect(screen.getByTestId('family-sync-state').textContent).toContain(t(lang, 'family.state.offline'))
  })

  it('paused shows the paused banner', () => {
    use({ family: family({ status: 'paused', space: mySpace({ paused: true }) }) })
    renderTab()

    expect(screen.getByTestId('family-paused').textContent).toContain(t(lang, 'family.state.paused'))
    expect(screen.queryByTestId('family-rotation-pending')).toBeNull()
  })

  it('rotation-pending shows its banner', () => {
    use({ family: family({ status: 'rotation-pending' }) })
    renderTab()

    expect(screen.getByTestId('family-rotation-pending').textContent).toContain(t(lang, 'family.state.rotationPending'))
    expect(screen.queryByTestId('family-paused')).toBeNull()
  })

  it('error shows the banner with the code', () => {
    use({ family: family({ status: 'error', errorCode: 'quota_exceeded' }) })
    renderTab()

    expect(screen.getByTestId('family-error').textContent).toContain(t(lang, 'family.state.error', { code: 'quota_exceeded' }))
  })

  it('no banner while synced', () => {
    use({ family: family() })
    renderTab()

    expect(screen.queryByTestId('family-paused')).toBeNull()
    expect(screen.queryByTestId('family-rotation-pending')).toBeNull()
    expect(screen.queryByTestId('family-error')).toBeNull()
  })

  it('shows progress while syncing', () => {
    use({ family: family({ status: 'syncing', progress: { phase: 'reencrypt', done: 5, total: 10 } }) })
    renderTab()

    expect(screen.getByTestId('family-progress').textContent).toContain(t(lang, 'family.progress.reencrypt', { done: 5, total: 10 }))
  })

  it('lists the active members, and the pending requests separately', () => {
    use({ family: family({ space: mySpace({ members: [member(ME, 'active', 'owner'), member(BOB, 'active'), member(CAROL, 'pending')] }) }) })
    renderTab()

    expect(screen.getAllByTestId('family-member-row')).toHaveLength(2)
    expect(screen.getAllByTestId('family-request-row')).toHaveLength(1)
    expect(screen.getByTestId('family-request-email').textContent).toContain(`${CAROL}@example.com`)
  })

  it('shows the open invites with their expiry and Revoke', async () => {
    use({ family: family({ space: mySpace({ open_invites: [{ id: 'inv-1', expires_at: '2026-11-01T10:00:00.000Z' }, { id: 'inv-2', expires_at: '2026-11-02T10:00:00.000Z' }] }) }) })
    renderTab()

    expect(screen.getAllByTestId('family-invite-row')).toHaveLength(2)
    expect(screen.getAllByTestId('family-invite-expiry')).toHaveLength(2)
    fireEvent.click(screen.getAllByTestId('family-invite-revoke-btn')[1])
    await waitFor(() => expect(familyActions.revokeInvite).toHaveBeenCalledWith('inv-2'))
  })

  it('Invite is enabled below the limit and disabled at it', () => {
    use({ family: family({ space: mySpace({ limits: { max_members: 5 } }) }) })
    renderTab()
    expect(screen.getByTestId<HTMLButtonElement>('family-invite-btn').disabled).toBe(false)
    cleanup()

    use({ family: family({ space: mySpace({ limits: { max_members: 2 } }) }) })
    renderTab()
    expect(screen.getByTestId<HTMLButtonElement>('family-invite-btn').disabled).toBe(true)
  })

  it('Invite creates the invite and opens the dialog with the link', async () => {
    familyActions.createInvite.mockResolvedValue({ url: 'https://minima.example/join#abc.def', inviteId: 'inv-9', expiresAt: '2026-11-01T10:00:00.000Z' })
    use({ family: family() })
    renderTab()

    fireEvent.click(screen.getByTestId('family-invite-btn'))

    await waitFor(() => expect(screen.getByTestId('family-invite-dialog')).toBeTruthy())
    expect(screen.getByTestId<HTMLInputElement>('family-invite-link').value).toBe('https://minima.example/join#abc.def')
  })

  it('renames the Family and saves my display name', async () => {
    use({ family: family() })
    renderTab()

    await waitFor(() => expect(screen.getByTestId<HTMLInputElement>('family-space-name-input').value).toBe('Home'))
    fireEvent.change(screen.getByTestId('family-space-name-input'), { target: { value: 'Our place' } })
    fireEvent.click(screen.getByTestId('family-space-name-save'))
    await waitFor(() => expect(familyActions.renameFamily).toHaveBeenCalledWith('Our place'))

    await waitFor(() => expect(screen.getByTestId<HTMLInputElement>('family-my-name-input').value).toBe('Me'))
    fireEvent.change(screen.getByTestId('family-my-name-input'), { target: { value: 'Mum' } })
    fireEvent.click(screen.getByTestId('family-my-name-save'))
    await waitFor(() => expect(familyActions.setMyDisplayName).toHaveBeenCalledWith('Mum'))
  })

  it('Approve and Reject call the actions for that request', async () => {
    use({ family: family({ space: mySpace({ members: [member(ME, 'active', 'owner'), member(CAROL, 'pending'), member(BOB, 'pending')] }) }) })
    renderTab()

    fireEvent.click(screen.getAllByTestId('family-request-approve-btn')[0])
    await waitFor(() => expect(familyActions.approveMember).toHaveBeenCalledWith(CAROL))
    fireEvent.click(screen.getAllByTestId('family-request-reject-btn')[1])
    await waitFor(() => expect(familyActions.rejectMember).toHaveBeenCalledWith(BOB))
  })

  it('the owner has Delete Family and no Leave', () => {
    use({ family: family() })
    renderTab()

    expect(screen.getByTestId('family-delete-btn')).toBeTruthy()
    expect(screen.queryByTestId('family-leave-btn')).toBeNull()
  })
})

const DAVE = 'user-dave'
const EVE = 'user-eve'

function rowOf(userId: string): HTMLElement {
  const row = screen
    .getAllByTestId('family-member-row')
    .find((r) => within(r).getByTestId('family-member-email').textContent.includes(`${userId}@example.com`))
  if (!row) throw new Error(`no member row for ${userId}`)
  return row
}

function requestRowOf(userId: string): HTMLElement {
  const row = screen
    .getAllByTestId('family-request-row')
    .find((r) => within(r).getByTestId('family-request-email').textContent.includes(`${userId}@example.com`))
  if (!row) throw new Error(`no request row for ${userId}`)
  return row
}

describe.each(LANGS)('the members list as the owner (%s)', (lang) => {
  beforeEach(() => {
    setLang(lang, { persist: false })
    familyActions.getOverview.mockResolvedValue({
      info: { id: 'space', name: 'Home', createdAt: NOW, updatedAt: NOW },
      profiles: [
        { id: ME, displayName: 'Me', color: 'var(--chart-1)', updatedAt: NOW },
        { id: BOB, displayName: 'Bobby', color: 'var(--chart-2)', updatedAt: NOW },
      ],
      entryCount: 3,
    })
  })

  function asOwner() {
    use({
      family: family({
        space: mySpace({ members: [member(ME, 'active', 'owner'), member(BOB, 'active'), member(DAVE, 'active')] }),
      }),
    })
  }

  it('shows the profile name, or the email when there is no profile, with email, role and joined', async () => {
    asOwner()
    renderTab()

    await waitFor(() => expect(within(rowOf(BOB)).getByTestId('family-member-name').textContent).toBe('Bobby'))
    expect(within(rowOf(ME)).getByTestId('family-member-name').textContent).toBe('Me')
    expect(within(rowOf(DAVE)).getByTestId('family-member-name').textContent).toBe(`${DAVE}@example.com`)
    expect(within(rowOf(BOB)).getByTestId('family-member-email').textContent).toBe(`${BOB}@example.com`)
    expect(within(rowOf(ME)).getByTestId('family-member-role').textContent).toBe(t(lang, 'family.members.owner'))
    expect(within(rowOf(BOB)).getByTestId('family-member-role').textContent).toBe(t(lang, 'family.members.member'))
    const joinedPrefix = t(lang, 'family.members.joined', { date: '' }).trim()
    expect(within(rowOf(BOB)).getByTestId('family-member-joined').textContent).toContain(joinedPrefix)
  })

  it('marks only the own row with You', () => {
    asOwner()
    renderTab()

    expect(within(rowOf(ME)).getByTestId('family-member-you').textContent).toContain(t(lang, 'family.members.you'))
    expect(within(rowOf(BOB)).queryByTestId('family-member-you')).toBeNull()
    expect(within(rowOf(DAVE)).queryByTestId('family-member-you')).toBeNull()
    expect(screen.getAllByTestId('family-member-you')).toHaveLength(1)
  })

  it('other rows have Remove and Transfer, the own row has neither', () => {
    asOwner()
    renderTab()

    expect(within(rowOf(ME)).queryByTestId('family-member-remove-btn')).toBeNull()
    expect(within(rowOf(ME)).queryByTestId('family-member-transfer-btn')).toBeNull()
    expect(within(rowOf(BOB)).getByTestId('family-member-remove-btn')).toBeTruthy()
    expect(within(rowOf(DAVE)).getByTestId('family-member-transfer-btn')).toBeTruthy()
  })

  it('Remove opens the dialog with the body text and calls removeMember only after confirming', async () => {
    asOwner()
    renderTab()

    fireEvent.click(within(rowOf(DAVE)).getByTestId('family-member-remove-btn'))

    expect(screen.getByTestId('family-remove-dialog').textContent).toContain(t(lang, 'family.remove.body'))
    expect(familyActions.removeMember).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('family-remove-confirm'))

    await waitFor(() => expect(familyActions.removeMember).toHaveBeenCalledWith(DAVE))
    expect(familyActions.removeMember).toHaveBeenCalledTimes(1)
    expect(familyActions.transferOwnership).not.toHaveBeenCalled()
  })

  it('Transfer opens the dialog and calls transferOwnership only after confirming', async () => {
    asOwner()
    renderTab()

    fireEvent.click(within(rowOf(BOB)).getByTestId('family-member-transfer-btn'))

    expect(screen.getByTestId('family-transfer-dialog').textContent).toContain(t(lang, 'family.transfer.body'))
    expect(familyActions.transferOwnership).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('family-transfer-confirm'))

    await waitFor(() => expect(familyActions.transferOwnership).toHaveBeenCalledWith(BOB))
    expect(familyActions.transferOwnership).toHaveBeenCalledTimes(1)
    expect(familyActions.removeMember).not.toHaveBeenCalled()
  })
})

describe.each(LANGS)('the pending request rows (%s)', (lang) => {
  beforeEach(() => setLang(lang, { persist: false }))

  it('show the time, the compare hint with the email, and the safety code of the key', async () => {
    const carolKey = { kty: 'EC', crv: 'P-256', x: 'Q2Fyb2wtWC1jb29yZA', y: 'Q2Fyb2wtWS1jb29yZA' }
    const eveKey = { kty: 'EC', crv: 'P-256', x: 'RXZlLVgtY29vcmQ', y: 'RXZlLVktY29vcmQ' }
    use({
      family: family({
        space: mySpace({
          members: [
            member(ME, 'active', 'owner'),
            { ...member(CAROL, 'pending'), public_key: carolKey },
            { ...member(EVE, 'pending'), public_key: eveKey },
          ],
        }),
      }),
    })
    renderTab()

    const carolCode = await safetyCode(carolKey)
    const eveCode = await safetyCode(eveKey)
    expect(carolCode).not.toBe(eveCode)

    await waitFor(() => expect(within(requestRowOf(CAROL)).getByTestId('family-request-safety-code').textContent).toContain(carolCode))
    await waitFor(() => expect(within(requestRowOf(EVE)).getByTestId('family-request-safety-code').textContent).toContain(eveCode))
    expect(within(requestRowOf(CAROL)).getByTestId('family-request-safety-code').textContent).not.toContain(eveCode)
    expect(within(requestRowOf(CAROL)).getByTestId('family-request-hint').textContent).toContain(
      t(lang, 'family.requests.hint', { email: `${CAROL}@example.com` }),
    )
    expect(within(requestRowOf(EVE)).getByTestId('family-request-hint').textContent).toContain(
      t(lang, 'family.requests.hint', { email: `${EVE}@example.com` }),
    )
    const askedPrefix = t(lang, 'family.requests.asked', { when: '' }).trim()
    expect(within(requestRowOf(CAROL)).getByTestId('family-request-time').textContent).toContain(askedPrefix)
  })
})

describe.each(LANGS)('the member view (%s)', (lang) => {
  beforeEach(() => setLang(lang, { persist: false }))

  function asMember() {
    use({
      family: family({
        role: 'member',
        space: mySpace({ role: 'member', owner_id: BOB, members: [member(BOB, 'active', 'owner'), member(ME, 'active')] }),
      }),
    })
  }

  it('has Leave but no Invite, requests, delete or member actions', () => {
    asMember()
    renderTab()

    expect(screen.getByTestId('family-overview')).toBeTruthy()
    expect(screen.getByTestId('family-leave-btn')).toBeTruthy()
    expect(screen.queryByTestId('family-invite-btn')).toBeNull()
    expect(screen.queryByTestId('family-requests')).toBeNull()
    expect(screen.queryByTestId('family-delete-btn')).toBeNull()
    expect(screen.queryByTestId('family-member-remove-btn')).toBeNull()
    expect(screen.getByTestId('family-member-you').textContent).toContain(t(lang, 'family.members.you'))
  })

  it('Leave asks to confirm and then calls leaveFamily', async () => {
    asMember()
    renderTab()

    fireEvent.click(screen.getByTestId('family-leave-btn'))
    expect(screen.getByTestId('family-leave-dialog')).toBeTruthy()
    expect(familyActions.leaveFamily).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('family-leave-confirm'))

    await waitFor(() => expect(familyActions.leaveFamily).toHaveBeenCalledTimes(1))
  })
})
