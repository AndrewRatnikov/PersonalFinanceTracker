// No CONTRACT_GAPs: AccountTab selectors and dependencies are fully specified
// in the Interface Contract (component: AccountTab). DeleteAccountDialog is
// replaced by a fake that renders fake-delete-account-dialog when open.
// The sign-in link now carries a typed `search`, so the Link mock serialises it
// into the href; the original "Sign in link goes to /login" case checks the
// path and the redirect parameter separately.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as Entitlements from '@/lib/cloud/entitlements'

import type { SyncStatus } from '@/lib/cloud/types'
import { signOutAccount, useAccountSession } from '@/lib/accountSession'
import { useSyncStatus } from '@/lib/cloud/entitlements'
import { AccountTab } from '@/components/settings/AccountTab'

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...rest
  }: {
    to: string
    search?: Record<string, string>
    children?: ReactNode
    'data-testid'?: string
  }) => (
    <a
      href={search ? `${to}?${new URLSearchParams(search).toString()}` : to}
      data-testid={rest['data-testid']}
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}))
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
}))
vi.mock('@/lib/accountSession', () => ({
  ACCOUNT_SESSION_QUERY_KEY: ['account-session'],
  useAccountSession: vi.fn(),
  signOutAccount: vi.fn(),
}))
vi.mock('@/lib/cloud/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof Entitlements>()),
  useSyncStatus: vi.fn(),
}))
vi.mock('@/components/settings/DeleteAccountDialog', () => ({
  DeleteAccountDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="fake-delete-account-dialog" /> : null,
}))

let client = new QueryClient()

function renderTab() {
  return render(
    <QueryClientProvider client={client}>
      <AccountTab />
    </QueryClientProvider>,
  )
}

function syncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    plan_id: 'beta',
    has_sync: true,
    free_for_all: true,
    granted_by: 'free_for_all',
    beta_joined_at: null,
    entitlement_status: null,
    current_period_end: null,
    limits: { sync: true, max_devices: 5, max_records: 100000, max_bytes: 104857600 },
    vault: null,
    devices_count: 0,
    ...overrides,
  }
}

const FREE_STATUS = syncStatus({
  plan_id: 'free',
  has_sync: false,
  free_for_all: false,
  granted_by: 'default',
  limits: { sync: false, max_devices: 0, max_records: 0, max_bytes: 0 },
})

beforeEach(() => {
  vi.resetAllMocks()
  client = new QueryClient()
  vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined)
  vi.mocked(signOutAccount).mockResolvedValue(undefined)
  vi.mocked(useSyncStatus).mockReturnValue({ state: 'loading' })
})

afterEach(() => {
  cleanup()
})

describe('AccountTab with a session', () => {
  beforeEach(() => {
    vi.mocked(useAccountSession).mockReturnValue({
      userId: 'user-1',
      email: 'ann@example.com',
    })
  })

  it('shows the email, Sign out and Delete account', () => {
    renderTab()

    expect(screen.getByTestId('account-tab')).toBeTruthy()
    expect(screen.getByTestId('account-email').textContent).toContain(
      'ann@example.com',
    )
    expect(screen.getByTestId('account-sign-out-btn')).toBeTruthy()
    expect(screen.getByTestId('delete-account-btn')).toBeTruthy()
    expect(screen.queryByTestId('account-sign-in-link')).toBeNull()
  })

  it('shows a different email for a different session', () => {
    vi.mocked(useAccountSession).mockReturnValue({
      userId: 'user-2',
      email: 'bob@example.com',
    })
    renderTab()

    expect(screen.getByTestId('account-email').textContent).toContain(
      'bob@example.com',
    )
    expect(screen.getByTestId('account-email').textContent).not.toContain(
      'ann@example.com',
    )
  })

  it('Sign out ends the session, refreshes it and shows a toast', async () => {
    renderTab()

    fireEvent.click(screen.getByTestId('account-sign-out-btn'))

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('Signed out')
    })
    expect(signOutAccount).toHaveBeenCalledTimes(1)
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['account-session'],
    })
    expect(
      vi.mocked(signOutAccount).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(client.invalidateQueries).mock.invocationCallOrder[0])
  })

  it('shows an error toast and no success toast when Sign out fails', async () => {
    vi.mocked(signOutAccount).mockRejectedValue(new Error('auth down'))
    renderTab()

    fireEvent.click(screen.getByTestId('account-sign-out-btn'))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled()
    })
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('Delete account opens the delete dialog', () => {
    renderTab()
    expect(screen.queryByTestId('fake-delete-account-dialog')).toBeNull()

    fireEvent.click(screen.getByTestId('delete-account-btn'))

    expect(screen.getByTestId('fake-delete-account-dialog')).toBeTruthy()
  })

  it('shows the legal links at the bottom of the account card', () => {
    renderTab()

    const legal = screen.getByTestId('account-legal-links')
    expect(
      within(legal).getByTestId('legal-terms-link').getAttribute('href'),
    ).toBe('/terms')
    expect(
      within(legal).getByTestId('legal-privacy-link').getAttribute('href'),
    ).toBe('/privacy')
    expect(screen.queryByTestId('account-optional-card')).toBeNull()
  })
})

describe('AccountTab Plan card', () => {
  beforeEach(() => {
    vi.mocked(useAccountSession).mockReturnValue({
      userId: 'user-1',
      email: 'ann@example.com',
    })
  })

  it('shows the Beta message when sync comes from the free-for-all switch', () => {
    vi.mocked(useSyncStatus).mockReturnValue({
      state: 'ready',
      status: syncStatus(),
    })
    renderTab()

    const card = screen.getByTestId('account-plan-card')
    expect(within(card).getByTestId('account-plan-name').textContent).toBe('Beta')
    expect(within(card).getByTestId('account-plan-beta').textContent).toContain(
      'free during the beta',
    )
    expect(screen.queryByTestId('account-plan-included')).toBeNull()
    expect(screen.queryByTestId('account-plan-free')).toBeNull()
    expect(screen.queryByTestId('account-plan-loading')).toBeNull()
  })

  it('shows "included" for a plan that has sync by entitlement', () => {
    vi.mocked(useSyncStatus).mockReturnValue({
      state: 'ready',
      status: syncStatus({ plan_id: 'sync', granted_by: 'entitlement', free_for_all: false }),
    })
    renderTab()

    expect(screen.getByTestId('account-plan-name').textContent).toBe('Sync')
    expect(screen.getByTestId('account-plan-included').textContent).toContain(
      'included in your plan',
    )
    expect(screen.queryByTestId('account-plan-beta')).toBeNull()
    expect(screen.queryByTestId('account-plan-free')).toBeNull()
  })

  it('shows "included", not Beta, when sync comes from the default grant', () => {
    vi.mocked(useSyncStatus).mockReturnValue({
      state: 'ready',
      status: syncStatus({ granted_by: 'default' }),
    })
    renderTab()

    expect(screen.getByTestId('account-plan-included')).toBeTruthy()
    expect(screen.queryByTestId('account-plan-beta')).toBeNull()
  })

  it('shows "not included" for a plan without sync', () => {
    vi.mocked(useSyncStatus).mockReturnValue({ state: 'ready', status: FREE_STATUS })
    renderTab()

    expect(screen.getByTestId('account-plan-name').textContent).toBe('Free')
    const freeText = screen.getByTestId('account-plan-free').textContent
    expect(freeText).toContain('included')
    expect(freeText).not.toContain('across devices')
    expect(screen.queryByTestId('account-plan-beta')).toBeNull()
    expect(screen.queryByTestId('account-plan-included')).toBeNull()
  })

  it('decides from the sync feature, not from granted_by alone', () => {
    vi.mocked(useSyncStatus).mockReturnValue({
      state: 'ready',
      status: syncStatus({
        granted_by: 'free_for_all',
        limits: { sync: false, max_devices: 0, max_records: 0, max_bytes: 0 },
      }),
    })
    renderTab()

    expect(screen.getByTestId('account-plan-free')).toBeTruthy()
    expect(screen.queryByTestId('account-plan-beta')).toBeNull()
  })

  it('falls back to the raw plan id for an unknown plan', () => {
    vi.mocked(useSyncStatus).mockReturnValue({
      state: 'ready',
      status: syncStatus({ plan_id: 'enterprise-x', granted_by: 'entitlement' }),
    })
    renderTab()

    expect(screen.getByTestId('account-plan-name').textContent).toBe('enterprise-x')
  })

  it('has no sync controls in the ready state', () => {
    vi.mocked(useSyncStatus).mockReturnValue({
      state: 'ready',
      status: syncStatus(),
    })
    renderTab()

    const card = screen.getByTestId('account-plan-card')
    expect(within(card).queryAllByRole('button')).toHaveLength(0)
    expect(within(card).queryAllByRole('switch')).toHaveLength(0)
    expect(within(card).queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('shows the loading state', () => {
    vi.mocked(useSyncStatus).mockReturnValue({ state: 'loading' })
    renderTab()

    const card = screen.getByTestId('account-plan-card')
    expect(within(card).getByTestId('account-plan-loading')).toBeTruthy()
    expect(screen.queryByTestId('account-plan-name')).toBeNull()
    expect(screen.queryByTestId('account-plan-beta')).toBeNull()
  })

  it('shows the offline state', () => {
    vi.mocked(useSyncStatus).mockReturnValue({ state: 'offline' })
    renderTab()

    expect(screen.getByTestId('account-plan-offline').textContent).toContain(
      'offline',
    )
    expect(screen.queryByTestId('account-plan-loading')).toBeNull()
    expect(screen.queryByTestId('account-plan-name')).toBeNull()
  })

  it('shows the error state and Retry calls retry()', () => {
    const retry = vi.fn()
    vi.mocked(useSyncStatus).mockReturnValue({
      state: 'error',
      error: new Error('x') as never,
      retry,
    })
    renderTab()

    expect(screen.getByTestId('account-plan-error')).toBeTruthy()
    expect(retry).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('account-plan-retry-btn'))

    expect(retry).toHaveBeenCalledTimes(1)
    const card = screen.getByTestId('account-plan-card')
    expect(within(card).queryAllByRole('button')).toHaveLength(1)
  })

  it('does not show the Plan card when signed out', () => {
    vi.mocked(useAccountSession).mockReturnValue(null)
    vi.mocked(useSyncStatus).mockReturnValue({ state: 'signed-out' })
    renderTab()

    expect(screen.queryByTestId('account-plan-card')).toBeNull()
  })
})

describe('AccountTab without a session', () => {
  beforeEach(() => {
    vi.mocked(useAccountSession).mockReturnValue(null)
    vi.mocked(useSyncStatus).mockReturnValue({ state: 'signed-out' })
  })

  it('shows a Sign in link to /login and no account actions', () => {
    renderTab()

    expect(screen.getByTestId('account-tab')).toBeTruthy()
    const href = screen.getByTestId('account-sign-in-link').getAttribute('href')
    expect(new URL(href ?? '', 'http://x').pathname).toBe('/login')
    expect(screen.queryByTestId('account-email')).toBeNull()
    expect(screen.queryByTestId('account-sign-out-btn')).toBeNull()
    expect(screen.queryByTestId('delete-account-btn')).toBeNull()
  })

  it('sends the user back to Settings, Account after signing in', () => {
    renderTab()

    const href = screen.getByTestId('account-sign-in-link').getAttribute('href')
    const url = new URL(href ?? '', 'http://x')
    expect(url.searchParams.get('redirect')).toBe('/settings?tab=account')
    expect(url.searchParams.get('redirect')).not.toBe('/settings')
  })

  it('shows the Account (optional) card with the sign-in link inside', () => {
    renderTab()

    const card = screen.getByTestId('account-optional-card')
    expect(card.textContent).toContain('Account (optional)')
    expect(card.textContent).toContain('sync across devices')
    expect(
      within(card).getByTestId('account-sign-in-link').textContent,
    ).toContain('Sign in with Google')
  })

  it('links to the Terms and Privacy pages', () => {
    renderTab()

    const legal = screen.getByTestId('account-legal-links')
    expect(
      within(legal).getByTestId('legal-terms-link').getAttribute('href'),
    ).toBe('/terms')
    expect(
      within(legal).getByTestId('legal-privacy-link').getAttribute('href'),
    ).toBe('/privacy')
  })

  it('has no Plan card', () => {
    renderTab()

    expect(screen.queryByTestId('account-plan-card')).toBeNull()
  })
})
