// No CONTRACT_GAPs: AccountTab selectors and dependencies are fully specified
// in the Interface Contract (component: AccountTab). DeleteAccountDialog is
// replaced by a fake that renders fake-delete-account-dialog when open.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { signOutAccount, useAccountSession } from '@/lib/accountSession'
import { AccountTab } from '@/components/settings/AccountTab'

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string
    children?: ReactNode
    'data-testid'?: string
  }) => (
    <a href={to} data-testid={rest['data-testid']}>
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

beforeEach(() => {
  vi.resetAllMocks()
  client = new QueryClient()
  vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined)
  vi.mocked(signOutAccount).mockResolvedValue(undefined)
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
})

describe('AccountTab without a session', () => {
  beforeEach(() => {
    vi.mocked(useAccountSession).mockReturnValue(null)
  })

  it('shows only a Sign in link to /login', () => {
    renderTab()

    expect(screen.getByTestId('account-tab')).toBeTruthy()
    expect(screen.getByTestId('account-sign-in-link').getAttribute('href')).toBe(
      '/login',
    )
    expect(screen.queryByTestId('account-email')).toBeNull()
    expect(screen.queryByTestId('account-sign-out-btn')).toBeNull()
    expect(screen.queryByTestId('delete-account-btn')).toBeNull()
  })
})
