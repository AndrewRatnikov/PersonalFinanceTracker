// CONTRACT_GAP: the exact text of join-invite-info is checked as the catalog
//   string `join.info` with its three parameters ({email}, {members}, {when});
//   how `{when}` is formatted is not asserted.
// CONTRACT_GAP: the sign-in Link's search is asserted through the mocked Link
//   props (to, search), because the contract fixes `redirect: '/join'` only in
//   prose.
//
// jsdom, mocked APIs: the /join flow step by step. The hash is set on
// window.location with history.replaceState, the pending invite lives in the
// real sessionStorage helper, everything else is a fake.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { Lang } from '@/i18n/lang'
import type { FamilySyncState } from '@/lib/sync/types'
import { setLang, translate } from '@/i18n/core'
import { useAccountSession } from '@/lib/accountSession'
import { buildInviteUrl, createInviteSecret } from '@/lib/spaces/invite'
import { PENDING_INVITE_KEY, readPendingInvite, savePendingInvite } from '@/lib/spaces/pendingInvite'
import { requestSyncRestore } from '@/lib/sync/restoreRequest'
import { OFF_FAMILY_STATE, useFamilyAvailable, useFamilySyncState, useSyncState } from '@/lib/sync/react'
import { getSyncRuntime } from '@/lib/sync/runtime'
import { requestCreateVault, useVaultSession } from '@/lib/vaultSession'
import { JoinPage } from '@/components/JoinPage'

vi.mock('@/lib/featureFlags', () => ({ ENABLE_ACCOUNTS: true, ENABLE_SYNC: true, ENABLE_SPACES: true }))
vi.mock('@/lib/accountSession', () => ({
  useAccountSession: vi.fn(),
  useAccountsVisible: () => true,
}))
vi.mock('@/lib/vaultSession', () => ({
  useVaultSession: vi.fn(),
  requestCreateVault: vi.fn(),
}))
vi.mock('@/lib/sync/restoreRequest', () => ({ requestSyncRestore: vi.fn() }))
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
  useFamilyAvailable: vi.fn(),
  useFamilySyncState: vi.fn(),
  useSyncState: vi.fn(),
}))
vi.mock('@/lib/sync/runtime', () => ({ getSyncRuntime: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, children }: { to: string; search?: Record<string, string>; children?: ReactNode }) => (
    <a href={to} data-search={JSON.stringify(search ?? {})}>
      {children}
    </a>
  ),
}))

const INVITE_ID = '5f0f6c1e-0000-4000-8000-00000000abcd'
const SPACE = 'a1b2c3d4-0000-4000-8000-0000000000a1'

const familyActions = {
  previewInvite: vi.fn(),
  requestJoin: vi.fn(),
}
const turnOn = vi.fn()

function setHash(hash: string) {
  window.history.replaceState(null, '', `/join${hash}`)
}

function validHash(): { hash: string; secret: Uint8Array } {
  const secret = createInviteSecret()
  const url = buildInviteUrl('https://minima.example', INVITE_ID, secret)
  return { hash: new URL(url).hash, secret }
}

function sync(status: 'off' | 'synced' | 'syncing') {
  vi.mocked(useSyncState).mockReturnValue({
    status,
    lastSyncAt: null,
    progress: null,
    errorCode: null,
    lastError: null,
    deviceId: 'd',
  })
}

function fam(over: Partial<FamilySyncState> = {}) {
  vi.mocked(useFamilySyncState).mockReturnValue({ ...OFF_FAMILY_STATE, ...over })
}

function ready(options: { signedIn?: boolean; phase?: 'checking' | 'none' | 'locked' | 'unlocked'; sync?: 'off' | 'synced' } = {}) {
  vi.mocked(useFamilyAvailable).mockReturnValue(true)
  vi.mocked(useVaultSession).mockReturnValue({ phase: options.phase ?? 'unlocked', createRequested: false })
  vi.mocked(useAccountSession).mockReturnValue(options.signedIn === false ? null : { userId: 'user-1', email: 'b@example.com' })
  sync(options.sync ?? 'synced')
  fam()
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  setLang('en', { persist: false })
  vi.mocked(getSyncRuntime).mockReturnValue({ familyActions, actions: { turnOn }, family: {}, engine: {} } as never)
  familyActions.previewInvite.mockResolvedValue({
    space_id: SPACE,
    owner_email: 'owner@example.com',
    members_count: 2,
    expires_at: '2026-11-01T10:00:00.000Z',
  })
  familyActions.requestJoin.mockResolvedValue({ spaceId: SPACE, safetyCode: 'AB12-CD34-EF56' })
  turnOn.mockResolvedValue({ kind: 'linked' })
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
  window.history.replaceState(null, '', '/')
})

describe('flags off', () => {
  it('shows only "Not available" and does not touch the hash or the runtime', () => {
    vi.mocked(useFamilyAvailable).mockReturnValue(false)
    vi.mocked(useVaultSession).mockReturnValue({ phase: 'unlocked', createRequested: false })
    vi.mocked(useAccountSession).mockReturnValue({ userId: 'u', email: null })
    sync('synced')
    fam()
    const { hash } = validHash()
    setHash(hash)

    render(<JoinPage />)

    expect(screen.getByTestId('join-not-available').textContent).toContain(translate('en', 'join.notAvailable'))
    expect(screen.queryByTestId('join-invite-info')).toBeNull()
    expect(screen.queryByTestId('join-invalid')).toBeNull()
    expect(screen.queryByTestId('join-error')).toBeNull()
    expect(window.location.hash).toBe(hash)
    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull()
    expect(getSyncRuntime).not.toHaveBeenCalled()
    expect(familyActions.previewInvite).not.toHaveBeenCalled()
  })
})

describe('reading the link', () => {
  it('stores the invite in sessionStorage and removes the fragment from the address bar', async () => {
    ready()
    const { hash, secret } = validHash()
    setHash(hash)

    render(<JoinPage />)

    await waitFor(() => expect(window.location.hash).toBe(''))
    expect(window.location.pathname).toBe('/join')
    const stored = readPendingInvite()
    expect(stored?.inviteId).toBe(INVITE_ID)
    expect(Array.from(stored?.secret ?? [])).toEqual(Array.from(secret))
  })

  it('a malformed fragment shows "This invite link is invalid" and stores nothing', async () => {
    ready()
    setHash('#not-a-valid-invite')

    render(<JoinPage />)

    await waitFor(() => expect(screen.getByTestId('join-invalid')).toBeTruthy())
    expect(screen.getByTestId('join-invalid').textContent).toContain(translate('en', 'join.invalid'))
    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull()
    expect(familyActions.previewInvite).not.toHaveBeenCalled()
  })

  it('without a hash and nothing stored it is invalid', async () => {
    ready()
    setHash('')

    render(<JoinPage />)

    await waitFor(() => expect(screen.getByTestId('join-invalid')).toBeTruthy())
  })

  it('without a hash it resumes from the stored invite (after a login redirect)', async () => {
    ready()
    setHash('')
    savePendingInvite({ inviteId: INVITE_ID, secret: createInviteSecret() })

    render(<JoinPage />)

    await waitFor(() => expect(familyActions.previewInvite).toHaveBeenCalledTimes(1))
    expect(familyActions.previewInvite.mock.calls[0][0]).toMatchObject({ inviteId: INVITE_ID })
  })

  it('without a hash and with a pending request it shows the pending state', async () => {
    ready()
    fam({ status: 'pending-approval', role: 'member', pendingOwnerEmail: 'owner@example.com' })
    setHash('')

    render(<JoinPage />)

    await waitFor(() => expect(screen.getByTestId('join-pending')).toBeTruthy())
    expect(screen.queryByTestId('join-invalid')).toBeNull()
  })
})

describe('the steps before the invite', () => {
  async function renderWithLink(lang: Lang = 'en') {
    setLang(lang, { persist: false })
    setHash(validHash().hash)
    render(<JoinPage />)
    await waitFor(() => expect(window.location.hash).toBe(''))
  }

  it('shows loading while the vault is being checked', async () => {
    ready({ phase: 'checking' })
    await renderWithLink()

    expect(screen.getByTestId('join-loading')).toBeTruthy()
    expect(familyActions.previewInvite).not.toHaveBeenCalled()
  })

  it('offers to create the vault, or to restore with sync, when there is none', async () => {
    ready({ phase: 'none', signedIn: true })
    await renderWithLink()

    expect(screen.getByTestId('join-no-vault')).toBeTruthy()
    fireEvent.click(screen.getByTestId('join-create-vault-btn'))
    expect(requestCreateVault).toHaveBeenCalledTimes(1)
    expect(requestSyncRestore).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('join-restore-btn'))
    expect(requestSyncRestore).toHaveBeenCalledTimes(1)
    expect(requestCreateVault).toHaveBeenCalledTimes(2)
  })

  it('restore with sync goes through login first when signed out', async () => {
    ready({ phase: 'none', signedIn: false })
    await renderWithLink()

    const restore = screen.getByTestId('join-restore-btn')
    expect(restore.tagName).toBe('A')
    expect(restore.getAttribute('href')).toBe('/login')
    expect(JSON.parse(restore.getAttribute('data-search') ?? '{}')).toEqual({ redirect: '/join' })
    expect(requestSyncRestore).not.toHaveBeenCalled()
  })

  it('shows the locked note while the vault is locked', async () => {
    ready({ phase: 'locked' })
    await renderWithLink()

    expect(screen.getByTestId('join-locked').textContent).toContain(translate('en', 'join.locked'))
  })

  it('asks to sign in with a link back to /join', async () => {
    ready({ signedIn: false })
    await renderWithLink()

    const link = screen.getByTestId('join-sign-in-link')
    expect(screen.getByTestId('join-sign-in')).toBeTruthy()
    expect(link.getAttribute('href')).toBe('/login')
    expect(JSON.parse(link.getAttribute('data-search') ?? '{}')).toEqual({ redirect: '/join' })
    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).not.toBeNull()
  })

  it('asks to turn sync on, and the button turns it on in place', async () => {
    ready({ sync: 'off' })
    await renderWithLink()

    expect(screen.getByTestId('join-sync-off')).toBeTruthy()
    fireEvent.click(screen.getByTestId('join-turn-on-sync-btn'))
    await waitFor(() => expect(turnOn).toHaveBeenCalledTimes(1))
  })

  it('needs-link after turning sync on is shown as an error', async () => {
    ready({ sync: 'off' })
    turnOn.mockResolvedValue({ kind: 'needs-link', cloud: {} })
    await renderWithLink()

    fireEvent.click(screen.getByTestId('join-turn-on-sync-btn'))

    await waitFor(() => expect(screen.getByTestId('join-error')).toBeTruthy())
  })

  it('a member of a Family already sees the already-member text', async () => {
    ready()
    fam({ status: 'synced', spaceId: SPACE, role: 'member', space: { space_id: SPACE } as never })
    await renderWithLink()

    expect(screen.getByTestId('join-already-member').textContent).toContain(translate('en', 'join.alreadyMember'))
    expect(familyActions.requestJoin).not.toHaveBeenCalled()
  })
})

describe.each<Lang>(['en', 'uk'])('the invite (%s)', (lang) => {
  beforeEach(() => setLang(lang, { persist: false }))

  async function openInvite() {
    ready()
    setHash(validHash().hash)
    render(<JoinPage />)
    await waitFor(() => expect(screen.getByTestId('join-invite-info')).toBeTruthy())
  }

  it('shows the owner email and the member count', async () => {
    await openInvite()

    const text = screen.getByTestId('join-invite-info').textContent
    expect(text).toContain('owner@example.com')
    expect(text).toContain(translate(lang, 'join.members', { count: 2 } as never))
  })

  it('Ask to join requests with the previewed owner email and shows the safety code', async () => {
    await openInvite()

    fireEvent.click(screen.getByTestId('join-ask-btn'))

    await waitFor(() => expect(screen.getByTestId('join-pending')).toBeTruthy())
    expect(familyActions.requestJoin).toHaveBeenCalledTimes(1)
    expect(familyActions.requestJoin.mock.calls[0][0]).toMatchObject({ inviteId: INVITE_ID })
    expect(familyActions.requestJoin.mock.calls[0][1]).toBe('owner@example.com')
    expect(screen.getByTestId('join-safety-code').textContent).toContain('AB12-CD34-EF56')
    expect(screen.getByTestId('join-safety-code').textContent).toContain(translate(lang, 'family.safetyCode.mine', { code: 'AB12-CD34-EF56' }))
    expect(screen.getByTestId('join-safety-hint').textContent).toContain(translate(lang, 'family.safetyCode.hint'))
  })

  it('Cancel clears the stored invite', async () => {
    await openInvite()
    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).not.toBeNull()

    fireEvent.click(screen.getByTestId('join-cancel-btn'))

    await waitFor(() => expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull())
    expect(familyActions.requestJoin).not.toHaveBeenCalled()
  })
})

describe('invite problems', () => {
  async function render404(error: unknown) {
    ready()
    familyActions.previewInvite.mockRejectedValue(error)
    setHash(validHash().hash)
    render(<JoinPage />)
  }

  it('a used / expired / revoked / wrong link all show the same expired message and clear the invite', async () => {
    await render404(Object.assign(new Error('x'), { name: 'CloudError', code: 'invite_invalid' }))

    await waitFor(() => expect(screen.getByTestId('join-invite-expired')).toBeTruthy())
    expect(screen.getByTestId('join-invite-expired').textContent).toContain(translate('en', 'family.errors.inviteInvalid'))
    expect(screen.queryByTestId('join-ask-btn')).toBeNull()
    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull()
  })

  it.each([
    ['already_in_space', 'family.errors.alreadyInSpace'],
    ['member_limit', 'family.errors.memberLimit'],
    ['space_paused', 'family.errors.paused'],
  ])('%s shows plain text and keeps the invite', async (code, key) => {
    await render404(Object.assign(new Error('x'), { name: 'CloudError', code }))

    await waitFor(() => expect(screen.getByTestId('join-error')).toBeTruthy())
    expect(screen.getByTestId('join-error').textContent).toContain(translate('en', key as never))
    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).not.toBeNull()
  })

  it('an error while asking to join shows join-error and stays on the invite', async () => {
    ready()
    familyActions.requestJoin.mockRejectedValue(Object.assign(new Error('x'), { name: 'CloudError', code: 'network' }))
    setHash(validHash().hash)
    render(<JoinPage />)
    await waitFor(() => expect(screen.getByTestId('join-ask-btn')).toBeTruthy())

    fireEvent.click(screen.getByTestId('join-ask-btn'))

    await waitFor(() => expect(screen.getByTestId('join-error').textContent).toContain(translate('en', 'family.errors.offline')))
    expect(screen.queryByTestId('join-pending')).toBeNull()
  })
})
