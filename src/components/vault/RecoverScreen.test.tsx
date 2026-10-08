// No CONTRACT_GAPs: props, testids and flow are specified in the Interface
// Contract (component: RecoverScreen). Validation texts for step 2 mirror
// CreateVaultScreen per the plan. Phase 3 adds the optional onLostBoth link.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  resetPasswordWithRecoveryKey,
  unlockWithRecoveryKey,
} from '@/lib/vault'
import { RecoverScreen } from '@/components/vault/RecoverScreen'

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
  unlockWithRecoveryKey: vi.fn(),
  resetPasswordWithRecoveryKey: vi.fn(),
  VaultError: MockVaultError,
}))

const KEY = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-XY'

function submitOf(testId: string) {
  const form = screen.getByTestId(testId).closest('form')
  if (!form) throw new Error(`${testId} is not inside a form`)
  fireEvent.submit(form)
}

function renderScreen(onLostBoth?: () => void) {
  const onRecovered = vi.fn()
  const onCancel = vi.fn()
  render(
    <RecoverScreen
      onRecovered={onRecovered}
      onCancel={onCancel}
      onLostBoth={onLostBoth}
    />,
  )
  return { onRecovered, onCancel }
}

async function goToPasswordStep(key = KEY) {
  vi.mocked(unlockWithRecoveryKey).mockResolvedValue(undefined)
  fireEvent.change(screen.getByTestId('recover-key-input'), {
    target: { value: key },
  })
  submitOf('recover-key-submit')
  await screen.findByTestId('recover-password-input')
}

function fillPasswords(password: string, confirm: string) {
  fireEvent.change(screen.getByTestId('recover-password-input'), {
    target: { value: password },
  })
  fireEvent.change(screen.getByTestId('recover-confirm-input'), {
    target: { value: confirm },
  })
}

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('RecoverScreen key step', () => {
  it('starts on the recovery key step', () => {
    renderScreen()

    expect(screen.getByTestId('recover-screen')).toBeTruthy()
    expect(screen.getByTestId('recover-key-input')).toBeTruthy()
    expect(screen.queryByTestId('recover-password-input')).toBeNull()
    expect(screen.queryByTestId('recover-error')).toBeNull()
  })

  it('submits the typed key to unlockWithRecoveryKey and moves to the password step', async () => {
    renderScreen()

    await goToPasswordStep('abcde fghjk mnpqr stvwx yz012 34567 xy')

    expect(unlockWithRecoveryKey).toHaveBeenCalledWith(
      'abcde fghjk mnpqr stvwx yz012 34567 xy',
    )
    expect(screen.queryByTestId('recover-key-input')).toBeNull()
    expect(screen.getByTestId('recover-confirm-input')).toBeTruthy()
  })

  it('shows "This recovery key doesn\'t match" and stays on step 1 for a wrong key', async () => {
    vi.mocked(unlockWithRecoveryKey).mockRejectedValue(
      new MockVaultError(
        'incorrect-recovery-key',
        "This recovery key doesn't match",
      ),
    )
    renderScreen()

    fireEvent.change(screen.getByTestId('recover-key-input'), {
      target: { value: KEY },
    })
    submitOf('recover-key-submit')

    await waitFor(() => {
      expect(screen.getByTestId('recover-error').textContent).toBe(
        "This recovery key doesn't match",
      )
    })
    expect(screen.getByTestId('recover-key-input')).toBeTruthy()
    expect(screen.queryByTestId('recover-password-input')).toBeNull()
  })

  it('shows the throttle message', async () => {
    vi.mocked(unlockWithRecoveryKey).mockRejectedValue(
      new MockVaultError(
        'throttled',
        'Too many attempts. Try again in 5 s.',
        5000,
      ),
    )
    renderScreen()

    fireEvent.change(screen.getByTestId('recover-key-input'), {
      target: { value: KEY },
    })
    submitOf('recover-key-submit')

    await waitFor(() => {
      expect(screen.getByTestId('recover-error').textContent).toContain(
        'Too many attempts',
      )
    })
  })

  it('calls onCancel from the cancel button', () => {
    const { onCancel } = renderScreen()

    fireEvent.click(screen.getByTestId('recover-cancel'))

    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe("RecoverScreen 'I've lost both' link", () => {
  it('is not rendered without onLostBoth', () => {
    renderScreen()

    expect(screen.queryByTestId('recover-lost-both')).toBeNull()
  })

  it('is rendered on the key step with onLostBoth and calls it on click', () => {
    const onLostBoth = vi.fn()
    const { onCancel, onRecovered } = renderScreen(onLostBoth)

    const link = screen.getByTestId('recover-lost-both')
    expect(link.textContent).toContain("I've lost both")
    expect(onLostBoth).not.toHaveBeenCalled()

    fireEvent.click(link)

    expect(onLostBoth).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    expect(onRecovered).not.toHaveBeenCalled()
    expect(unlockWithRecoveryKey).not.toHaveBeenCalled()
  })

  it('is not shown on the password step', async () => {
    renderScreen(vi.fn())
    await goToPasswordStep()

    expect(screen.queryByTestId('recover-lost-both')).toBeNull()
  })
})

describe('RecoverScreen password step', () => {
  it('rejects a new password shorter than 8 characters', async () => {
    const { onRecovered } = renderScreen()
    await goToPasswordStep()

    fillPasswords('short', 'short')
    submitOf('recover-password-submit')

    expect(screen.getByTestId('recover-error').textContent).toBe(
      'Password must be at least 8 characters',
    )
    expect(resetPasswordWithRecoveryKey).not.toHaveBeenCalled()
    expect(onRecovered).not.toHaveBeenCalled()
  })

  it('rejects mismatched passwords', async () => {
    const { onRecovered } = renderScreen()
    await goToPasswordStep()

    fillPasswords('long enough 1', 'long enough 2')
    submitOf('recover-password-submit')

    expect(screen.getByTestId('recover-error').textContent).toBe(
      'Passwords do not match',
    )
    expect(resetPasswordWithRecoveryKey).not.toHaveBeenCalled()
    expect(onRecovered).not.toHaveBeenCalled()
  })

  it('resets the password with the entered key and calls onRecovered', async () => {
    vi.mocked(resetPasswordWithRecoveryKey).mockResolvedValue(undefined)
    const { onRecovered } = renderScreen()
    await goToPasswordStep()

    fillPasswords('long enough 1', 'long enough 1')
    submitOf('recover-password-submit')

    await waitFor(() => {
      expect(onRecovered).toHaveBeenCalledTimes(1)
    })
    expect(resetPasswordWithRecoveryKey).toHaveBeenCalledWith(
      KEY,
      'long enough 1',
    )
  })

  it('shows a VaultError from the reset and does not call onRecovered', async () => {
    vi.mocked(resetPasswordWithRecoveryKey).mockRejectedValue(
      new MockVaultError(
        'incorrect-recovery-key',
        "This recovery key doesn't match",
      ),
    )
    const { onRecovered } = renderScreen()
    await goToPasswordStep()

    fillPasswords('long enough 1', 'long enough 1')
    submitOf('recover-password-submit')

    await waitFor(() => {
      expect(screen.getByTestId('recover-error').textContent).toBe(
        "This recovery key doesn't match",
      )
    })
    expect(onRecovered).not.toHaveBeenCalled()
  })
})
