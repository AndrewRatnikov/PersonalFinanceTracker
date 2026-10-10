// No CONTRACT_GAPs: props, testids and error messages are fully specified in
// the Interface Contract (component: UnlockScreen).

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { unlockWithPassword } from '@/lib/vault'
import { UnlockScreen } from '@/components/vault/UnlockScreen'

const { MockVaultError } = vi.hoisted(() => {
  class FakeVaultError extends Error {
    code: string
    retryAfterMs: number
    constructor(code: string, message: string, retryAfterMs = 0) {
      super(message)
      this.name = 'VaultError'
      this.code = code
      this.retryAfterMs = retryAfterMs
    }
  }
  return { MockVaultError: FakeVaultError }
})

vi.mock('@/lib/vault', () => ({
  unlockWithPassword: vi.fn(),
  VaultError: MockVaultError,
}))

function renderScreen(legacy = false) {
  const onUnlocked = vi.fn()
  const onForgotPassword = vi.fn()
  render(
    <UnlockScreen
      legacy={legacy}
      onUnlocked={onUnlocked}
      onForgotPassword={onForgotPassword}
    />,
  )
  return { onUnlocked, onForgotPassword }
}

function submitWith(password: string) {
  fireEvent.change(screen.getByTestId('unlock-password-input'), {
    target: { value: password },
  })
  const form = screen.getByTestId('unlock-submit').closest('form')
  if (!form) throw new Error('submit button is not inside a form')
  fireEvent.submit(form)
}

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('UnlockScreen', () => {
  it('renders the password field and a submit button', () => {
    renderScreen()

    expect(screen.getByTestId('unlock-screen')).toBeTruthy()
    expect(
      screen.getByTestId<HTMLInputElement>('unlock-password-input').id,
    ).toBe('password')
    expect(screen.getByTestId<HTMLButtonElement>('unlock-submit').type).toBe(
      'submit',
    )
    expect(screen.queryByTestId('unlock-error')).toBeNull()
  })

  it('unlocks with the typed password and passes the result on', async () => {
    vi.mocked(unlockWithPassword).mockResolvedValue({ recoveryKey: null })
    const { onUnlocked } = renderScreen()

    submitWith('my password')

    await waitFor(() => {
      expect(onUnlocked).toHaveBeenCalledWith({ recoveryKey: null })
    })
    expect(unlockWithPassword).toHaveBeenCalledWith('my password')
  })

  it('passes a migration recovery key through to onUnlocked', async () => {
    const key = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-XY'
    vi.mocked(unlockWithPassword).mockResolvedValue({ recoveryKey: key })
    const { onUnlocked } = renderScreen(true)

    submitWith('my password')

    await waitFor(() => {
      expect(onUnlocked).toHaveBeenCalledWith({ recoveryKey: key })
    })
  })

  it('shows "Incorrect password" and does not unlock on a wrong password', async () => {
    vi.mocked(unlockWithPassword).mockRejectedValue(
      new MockVaultError('incorrect-password', 'Incorrect password'),
    )
    const { onUnlocked } = renderScreen()

    submitWith('wrong')

    await waitFor(() => {
      expect(screen.getByTestId('unlock-error').textContent).toBe(
        'Incorrect password',
      )
    })
    expect(onUnlocked).not.toHaveBeenCalled()
  })

  it('shows the throttle message', async () => {
    vi.mocked(unlockWithPassword).mockRejectedValue(
      new MockVaultError(
        'throttled',
        'Too many attempts. Try again in 5 s.',
        5000,
      ),
    )
    renderScreen()

    submitWith('whatever')

    await waitFor(() => {
      expect(screen.getByTestId('unlock-error').textContent).toContain(
        'Too many attempts',
      )
    })
  })

  it('shows "Vault damaged"', async () => {
    vi.mocked(unlockWithPassword).mockRejectedValue(
      new MockVaultError('damaged', 'Vault damaged'),
    )
    renderScreen()

    submitWith('whatever')

    await waitFor(() => {
      expect(screen.getByTestId('unlock-error').textContent).toBe(
        'Vault damaged',
      )
    })
  })

  it('shows a generic message for a non-VaultError failure', async () => {
    vi.mocked(unlockWithPassword).mockRejectedValue(new Error('boom'))
    const { onUnlocked } = renderScreen()

    submitWith('whatever')

    await waitFor(() => {
      expect(screen.getByTestId('unlock-error').textContent).toBe(
        'Something went wrong. Please try again.',
      )
    })
    expect(onUnlocked).not.toHaveBeenCalled()
  })

  it('offers "Forgot password?" and calls onForgotPassword when not legacy', () => {
    const { onForgotPassword } = renderScreen(false)

    fireEvent.click(screen.getByTestId('unlock-forgot-password'))

    expect(onForgotPassword).toHaveBeenCalledTimes(1)
  })

  it('hides "Forgot password?" for a legacy v1 store', () => {
    renderScreen(true)
    expect(screen.queryByTestId('unlock-forgot-password')).toBeNull()
  })
})
