// No CONTRACT_GAPs: SignOutDialog props and testid (#13) are fully specified
// in the Interface Contract.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SignOutDialog } from '@/components/SignOutDialog'

const { navigate, signOut, clearLocalDb, wipeLocalDbKey } = vi.hoisted(() => ({
  navigate: vi.fn(),
  signOut: vi.fn(),
  clearLocalDb: vi.fn(),
  wipeLocalDbKey: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/supabase', () => ({
  createBrowserSupabaseClient: () => ({ auth: { signOut } }),
}))
vi.mock('@/lib/localDb', () => ({ clearLocalDb, wipeLocalDbKey }))
vi.mock('@/lib/localExport', () => ({ exportAllLocalData: vi.fn() }))

describe('SignOutDialog cleans per-user state (#13)', () => {
  beforeEach(() => {
    localStorage.clear()
    navigate.mockReset()
    signOut.mockReset().mockResolvedValue({ error: null })
    clearLocalDb.mockReset().mockResolvedValue(undefined)
    wipeLocalDbKey.mockReset()
  })

  it('removes the device salt, key verifier and offline user for that user', async () => {
    localStorage.setItem('minima_device_salt_u1', 'salt')
    localStorage.setItem('minima_key_verify_u1', 'verify')
    localStorage.setItem('minima_offline_user', '{"id":"u1"}')
    localStorage.setItem('minima_key_verify_other', 'keep')
    render(<SignOutDialog userId="u1" open onOpenChange={vi.fn()} />)

    fireEvent.click(screen.getByTestId('sign-out-confirm-btn'))

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ to: '/login' })
    })
    expect(localStorage.getItem('minima_device_salt_u1')).toBeNull()
    expect(localStorage.getItem('minima_key_verify_u1')).toBeNull()
    expect(localStorage.getItem('minima_offline_user')).toBeNull()
    expect(localStorage.getItem('minima_key_verify_other')).toBe('keep')
  })
})
