// No CONTRACT_GAPs: DeleteAccountDialog props, testids and mocks (#4, #13) are
// fully specified in the Interface Contract.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DeleteAccountDialog } from '@/components/settings/DeleteAccountDialog'

const {
  navigate,
  toastSuccess,
  toastError,
  deleteCurrentUserAccount,
  signOut,
  clearLocalDb,
  wipeLocalDbKey,
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  deleteCurrentUserAccount: vi.fn(),
  signOut: vi.fn(),
  clearLocalDb: vi.fn(),
  wipeLocalDbKey: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
}))
vi.mock('@/lib/account', () => ({ deleteCurrentUserAccount }))
vi.mock('@/lib/supabase', () => ({
  createBrowserSupabaseClient: () => ({ auth: { signOut } }),
}))
vi.mock('@/lib/localDb', () => ({ clearLocalDb, wipeLocalDbKey }))

function renderDialog() {
  return render(
    <DeleteAccountDialog userId="u1" open onOpenChange={vi.fn()} />,
  )
}

describe('DeleteAccountDialog (#4, #13)', () => {
  beforeEach(() => {
    localStorage.clear()
    navigate.mockReset()
    toastSuccess.mockReset()
    toastError.mockReset()
    deleteCurrentUserAccount.mockReset().mockResolvedValue(undefined)
    signOut.mockReset().mockResolvedValue({ error: null })
    clearLocalDb.mockReset().mockResolvedValue(undefined)
    wipeLocalDbKey.mockReset()
  })

  it('still navigates to /login when clearLocalDb rejects after the server delete', async () => {
    clearLocalDb.mockRejectedValue(new Error('idb broke'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderDialog()

    fireEvent.click(screen.getByTestId('delete-account-confirm-btn'))

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ to: '/login' })
    })
    expect(toastSuccess).toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
    expect(screen.queryByTestId('delete-account-error')).toBeNull()
  })

  it('still navigates to /login when signOut rejects after the server delete', async () => {
    signOut.mockRejectedValue(new Error('auth down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderDialog()

    fireEvent.click(screen.getByTestId('delete-account-confirm-btn'))

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ to: '/login' })
    })
    expect(toastSuccess).toHaveBeenCalled()
  })

  it('shows the error and does not navigate when the server delete fails', async () => {
    deleteCurrentUserAccount.mockRejectedValue(new Error('boom'))
    renderDialog()

    fireEvent.click(screen.getByTestId('delete-account-confirm-btn'))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('boom')
    })
    expect(screen.getByTestId('delete-account-error').textContent).toBe('boom')
    expect(navigate).not.toHaveBeenCalled()
    expect(clearLocalDb).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('removes the per-user device salt, key verifier and offline user on success', async () => {
    localStorage.setItem('minima_device_salt_u1', 'salt')
    localStorage.setItem('minima_key_verify_u1', 'verify')
    localStorage.setItem('minima_offline_user', '{"id":"u1"}')
    localStorage.setItem('minima_device_salt_other', 'keep')
    renderDialog()

    fireEvent.click(screen.getByTestId('delete-account-confirm-btn'))

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ to: '/login' })
    })
    expect(localStorage.getItem('minima_device_salt_u1')).toBeNull()
    expect(localStorage.getItem('minima_key_verify_u1')).toBeNull()
    expect(localStorage.getItem('minima_offline_user')).toBeNull()
    // Another user's keys are untouched.
    expect(localStorage.getItem('minima_device_salt_other')).toBe('keep')
  })
})
