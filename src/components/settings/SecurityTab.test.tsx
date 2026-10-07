// No CONTRACT_GAPs for testids. The exact client-side validation texts of the
// Change password card are not given in the contract, so those tests only
// assert that an error is shown and that changePassword is not called.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { changePassword, regenerateRecoveryKey } from '@/lib/vault'
import { SecurityTab } from '@/components/settings/SecurityTab'

const { MockVaultError } = vi.hoisted(() => {
  class MockVaultError extends Error {
    code: string
    retryAfterMs: number
    constructor(code: string, message: string, retryAfterMs = 0) {
      super(message)
      this.name = 'VaultError'
      this.code = code
      this.retryAfterMs = retryAfterMs
    }
  }
  return { MockVaultError }
})

vi.mock('@/lib/vault', () => ({
  changePassword: vi.fn(),
  regenerateRecoveryKey: vi.fn(),
  VaultError: MockVaultError,
}))

const NEW_KEY = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-XY'

function setValue(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } })
}

function submitOf(testId: string) {
  const button = screen.getByTestId(testId)
  const form = button.closest('form')
  if (form) fireEvent.submit(form)
  else fireEvent.click(button)
}

function fillChange(current: string, next: string, confirm: string) {
  setValue('change-password-current', current)
  setValue('change-password-new', next)
  setValue('change-password-confirm', confirm)
}

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('SecurityTab layout', () => {
  it('renders both cards and no messages initially', () => {
    render(<SecurityTab />)

    expect(screen.getByTestId('security-tab')).toBeTruthy()
    expect(screen.getByTestId('change-password-current')).toBeTruthy()
    expect(screen.getByTestId('regenerate-key-password')).toBeTruthy()
    expect(screen.queryByTestId('change-password-error')).toBeNull()
    expect(screen.queryByTestId('change-password-success')).toBeNull()
    expect(screen.queryByTestId('regenerate-key-error')).toBeNull()
    expect(screen.queryByTestId('regenerate-key-success')).toBeNull()
    expect(screen.queryByTestId('recovery-key-step')).toBeNull()
  })
})

describe('Change password', () => {
  it('rejects a new password shorter than 8 characters', () => {
    render(<SecurityTab />)

    fillChange('current password', 'short', 'short')
    submitOf('change-password-submit')

    expect(screen.getByTestId('change-password-error').textContent).toBeTruthy()
    expect(changePassword).not.toHaveBeenCalled()
    expect(screen.queryByTestId('change-password-success')).toBeNull()
  })

  it('rejects a mismatching confirmation', () => {
    render(<SecurityTab />)

    fillChange('current password', 'new password 1', 'new password 2')
    submitOf('change-password-submit')

    expect(screen.getByTestId('change-password-error').textContent).toBeTruthy()
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('calls changePassword(current, next), shows success and clears the fields', async () => {
    vi.mocked(changePassword).mockResolvedValue(undefined)
    render(<SecurityTab />)

    fillChange('current password', 'new password 1', 'new password 1')
    submitOf('change-password-submit')

    await waitFor(() => {
      expect(screen.getByTestId('change-password-success').textContent).toContain(
        'Password changed',
      )
    })
    expect(changePassword).toHaveBeenCalledWith(
      'current password',
      'new password 1',
    )
    expect(
      screen.getByTestId<HTMLInputElement>('change-password-current').value,
    ).toBe('')
    expect(
      screen.getByTestId<HTMLInputElement>('change-password-new').value,
    ).toBe('')
    expect(
      screen.getByTestId<HTMLInputElement>('change-password-confirm').value,
    ).toBe('')
    expect(screen.queryByTestId('change-password-error')).toBeNull()
  })

  it('shows "Incorrect password" for a wrong current password and no success', async () => {
    vi.mocked(changePassword).mockRejectedValue(
      new MockVaultError('incorrect-password', 'Incorrect password'),
    )
    render(<SecurityTab />)

    fillChange('wrong one', 'new password 1', 'new password 1')
    submitOf('change-password-submit')

    await waitFor(() => {
      expect(screen.getByTestId('change-password-error').textContent).toBe(
        'Incorrect password',
      )
    })
    expect(screen.queryByTestId('change-password-success')).toBeNull()
  })
})

describe('Generate new recovery key', () => {
  it('shows the new key in the save step and no success message yet', async () => {
    vi.mocked(regenerateRecoveryKey).mockResolvedValue({ recoveryKey: NEW_KEY })
    render(<SecurityTab />)

    setValue('regenerate-key-password', 'my password')
    submitOf('regenerate-key-submit')

    await screen.findByTestId('recovery-key-step')
    expect(regenerateRecoveryKey).toHaveBeenCalledWith('my password')
    expect(screen.getByTestId('recovery-key-value').textContent).toBe(NEW_KEY)
    expect(screen.queryByTestId('regenerate-key-success')).toBeNull()
    expect(screen.queryByTestId('regenerate-key-error')).toBeNull()
  })

  it('shows success, hides the step and clears the password after confirming', async () => {
    vi.mocked(regenerateRecoveryKey).mockResolvedValue({ recoveryKey: NEW_KEY })
    render(<SecurityTab />)
    setValue('regenerate-key-password', 'my password')
    submitOf('regenerate-key-submit')
    await screen.findByTestId('recovery-key-step')

    expect(screen.getByTestId('recovery-key-continue').textContent).toBe('Done')
    fireEvent.click(screen.getByTestId('recovery-key-saved-checkbox'))
    setValue('recovery-key-last-group-input', 'xy')
    fireEvent.click(screen.getByTestId('recovery-key-continue'))

    await waitFor(() => {
      expect(screen.getByTestId('regenerate-key-success')).toBeTruthy()
    })
    expect(screen.getByTestId('regenerate-key-success').textContent).toContain(
      'old one no longer works',
    )
    expect(screen.queryByTestId('recovery-key-step')).toBeNull()
    expect(
      screen.getByTestId<HTMLInputElement>('regenerate-key-password').value,
    ).toBe('')
  })

  it('shows "Incorrect password" for a wrong password and no key', async () => {
    vi.mocked(regenerateRecoveryKey).mockRejectedValue(
      new MockVaultError('incorrect-password', 'Incorrect password'),
    )
    render(<SecurityTab />)

    setValue('regenerate-key-password', 'wrong one')
    submitOf('regenerate-key-submit')

    await waitFor(() => {
      expect(screen.getByTestId('regenerate-key-error').textContent).toBe(
        'Incorrect password',
      )
    })
    expect(screen.queryByTestId('recovery-key-step')).toBeNull()
    expect(screen.queryByTestId('regenerate-key-success')).toBeNull()
  })
})
