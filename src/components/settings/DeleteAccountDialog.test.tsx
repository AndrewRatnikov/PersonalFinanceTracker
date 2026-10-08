// No CONTRACT_GAPs: DeleteAccountDialog props, selectors and mocks are fully
// specified in the Interface Contract (component: DeleteAccountDialog). The
// original cases are kept in adapted form: the dialog no longer takes userId,
// no longer touches localStorage or clearLocalDb itself, and navigates to '/'
// instead of '/login'. Local data is wiped only through wipeLocalData when the
// checkbox is ticked.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DeleteAccountDialog } from '@/components/settings/DeleteAccountDialog'

const {
  navigate,
  toastSuccess,
  toastError,
  deleteCurrentUserAccount,
  signOutAccount,
  wipeLocalData,
  reloadToHome,
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  deleteCurrentUserAccount: vi.fn(),
  signOutAccount: vi.fn(),
  wipeLocalData: vi.fn(),
  reloadToHome: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
}))
vi.mock('@/lib/account', () => ({ deleteCurrentUserAccount }))
vi.mock('@/lib/accountSession', () => ({
  ACCOUNT_SESSION_QUERY_KEY: ['account-session'],
  signOutAccount,
}))
vi.mock('@/lib/localWipe', () => ({ wipeLocalData, reloadToHome }))

let client = new QueryClient()

function renderDialog() {
  return render(
    <QueryClientProvider client={client}>
      <DeleteAccountDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  )
}

function tickRemoveLocal() {
  fireEvent.click(
    screen.getByTestId<HTMLInputElement>('delete-account-remove-local'),
  )
}

describe('DeleteAccountDialog (#4, #12, #13)', () => {
  beforeEach(() => {
    localStorage.clear()
    client = new QueryClient()
    vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined)
    navigate.mockReset()
    toastSuccess.mockReset()
    toastError.mockReset()
    deleteCurrentUserAccount.mockReset().mockResolvedValue(undefined)
    signOutAccount.mockReset().mockResolvedValue(undefined)
    wipeLocalData.mockReset().mockResolvedValue(undefined)
    reloadToHome.mockReset()
  })

  it('offers an unticked "Also remove data from this device" checkbox', () => {
    renderDialog()

    const box = screen.getByTestId<HTMLInputElement>(
      'delete-account-remove-local',
    )
    expect(box.type).toBe('checkbox')
    expect(box.checked).toBe(false)
    expect(screen.getByTestId('delete-account-dialog').textContent).toContain(
      'Also remove data from this device',
    )
  })

  it('unticked: deletes the account, signs out, keeps local data and navigates to /', async () => {
    renderDialog()

    fireEvent.click(screen.getByTestId('delete-account-confirm-btn'))

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ to: '/' })
    })
    expect(deleteCurrentUserAccount).toHaveBeenCalledTimes(1)
    expect(signOutAccount).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith('Account deleted')
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['account-session'],
    })
    expect(wipeLocalData).not.toHaveBeenCalled()
    expect(reloadToHome).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalledWith({ to: '/login' })
  })

  it('unticked: leaves the minima_ localStorage keys alone', async () => {
    localStorage.setItem('minima_device_salt_u1', 'salt')
    localStorage.setItem('minima_offline_user', '{"id":"u1"}')
    renderDialog()

    fireEvent.click(screen.getByTestId('delete-account-confirm-btn'))

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ to: '/' })
    })
    expect(localStorage.getItem('minima_device_salt_u1')).toBe('salt')
    expect(localStorage.getItem('minima_offline_user')).toBe('{"id":"u1"}')
  })

  it('ticked: wipes local data after the server delete, then reloads instead of navigating', async () => {
    renderDialog()
    tickRemoveLocal()

    fireEvent.click(screen.getByTestId('delete-account-confirm-btn'))

    await waitFor(() => {
      expect(reloadToHome).toHaveBeenCalledTimes(1)
    })
    expect(wipeLocalData).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()
    const deleted = deleteCurrentUserAccount.mock.invocationCallOrder[0]
    const wiped = wipeLocalData.mock.invocationCallOrder[0]
    const reloaded = reloadToHome.mock.invocationCallOrder[0]
    expect(deleted).toBeLessThan(wiped)
    expect(wiped).toBeLessThan(reloaded)
  })

  it('ticked: still reloads when the local wipe rejects after the server delete', async () => {
    wipeLocalData.mockRejectedValue(new Error('idb broke'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderDialog()
    tickRemoveLocal()

    fireEvent.click(screen.getByTestId('delete-account-confirm-btn'))

    await waitFor(() => {
      expect(reloadToHome).toHaveBeenCalledTimes(1)
    })
    expect(toastSuccess).toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
    expect(screen.queryByTestId('delete-account-error')).toBeNull()
  })

  it('still navigates to / when signOutAccount rejects after the server delete', async () => {
    signOutAccount.mockRejectedValue(new Error('auth down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderDialog()

    fireEvent.click(screen.getByTestId('delete-account-confirm-btn'))

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ to: '/' })
    })
    expect(toastSuccess).toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('shows the error and does nothing else when the server delete fails', async () => {
    deleteCurrentUserAccount.mockRejectedValue(new Error('boom'))
    renderDialog()

    fireEvent.click(screen.getByTestId('delete-account-confirm-btn'))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('boom')
    })
    expect(screen.getByTestId('delete-account-error').textContent).toBe('boom')
    expect(navigate).not.toHaveBeenCalled()
    expect(signOutAccount).not.toHaveBeenCalled()
    expect(wipeLocalData).not.toHaveBeenCalled()
    expect(reloadToHome).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('does not wipe local data when the box is ticked but the server delete fails', async () => {
    deleteCurrentUserAccount.mockRejectedValue(new Error('boom'))
    renderDialog()
    tickRemoveLocal()

    fireEvent.click(screen.getByTestId('delete-account-confirm-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('delete-account-error')).toBeTruthy()
    })
    expect(wipeLocalData).not.toHaveBeenCalled()
    expect(reloadToHome).not.toHaveBeenCalled()
  })
})
