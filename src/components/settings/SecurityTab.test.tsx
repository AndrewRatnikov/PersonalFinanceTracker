// No CONTRACT_GAPs for testids. The exact client-side validation texts of the
// Change password card are not given in the contract, so those tests only
// assert that an error is shown and that changePassword is not called.
// SecurityTab now needs a QueryClientProvider (Auto-lock reads app settings).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getAppSettings, updateAppSettings } from '@/lib/appSettings'
import { changePassword, regenerateRecoveryKey } from '@/lib/vault'
import { lockApp } from '@/lib/vaultSession'
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
vi.mock('@/lib/appSettings', () => ({
  APP_SETTINGS_QUERY_KEY: ['settings'],
  AUTO_LOCK_OPTIONS: [0, 1, 5, 15, 60],
  DEFAULT_AUTO_LOCK_MINUTES: 15,
  getAppSettings: vi.fn(),
  updateAppSettings: vi.fn(),
}))
vi.mock('@/lib/vaultSession', () => ({ lockApp: vi.fn() }))

const NEW_KEY = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-XY'

const SETTINGS = {
  autoLockMinutes: 15,
  installHintDismissed: false,
  persistRequestedAt: null,
}

let client = new QueryClient()

function renderTab() {
  return render(
    <QueryClientProvider client={client}>
      <SecurityTab />
    </QueryClientProvider>,
  )
}

function select() {
  return screen.getByTestId<HTMLSelectElement>('auto-lock-select')
}

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
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(getAppSettings).mockResolvedValue(SETTINGS)
  vi.mocked(updateAppSettings).mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe('SecurityTab layout', () => {
  it('renders both cards and no messages initially', () => {
    renderTab()

    expect(screen.getByTestId('security-tab')).toBeTruthy()
    expect(screen.getByTestId('change-password-current')).toBeTruthy()
    expect(screen.getByTestId('regenerate-key-password')).toBeTruthy()
    expect(screen.queryByTestId('change-password-error')).toBeNull()
    expect(screen.queryByTestId('change-password-success')).toBeNull()
    expect(screen.queryByTestId('regenerate-key-error')).toBeNull()
    expect(screen.queryByTestId('regenerate-key-success')).toBeNull()
    expect(screen.queryByTestId('recovery-key-step')).toBeNull()
  })

  it('orders the cards: Change password, Generate key, Auto-lock, Lock now', () => {
    renderTab()

    const order = [
      'change-password-current',
      'regenerate-key-password',
      'auto-lock-select',
      'lock-now-btn',
    ].map((id) => screen.getByTestId(id))
    for (let i = 0; i < order.length - 1; i++) {
      expect(
        order[i].compareDocumentPosition(order[i + 1]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
  })
})

describe('Auto-lock', () => {
  it('offers Off, 1, 5, 15 and 60 minutes', () => {
    renderTab()

    const options = Array.from(select().options)
    expect(options.map((o) => o.value)).toEqual(['0', '1', '5', '15', '60'])
    expect(options.map((o) => o.textContent)).toEqual([
      'Off',
      '1 minute',
      '5 minutes',
      '15 minutes',
      '60 minutes',
    ])
  })

  it('defaults to 15 minutes', async () => {
    renderTab()

    await waitFor(() => {
      expect(getAppSettings).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(select().value).toBe('15')
    })
  })

  it('shows the stored value', async () => {
    vi.mocked(getAppSettings).mockResolvedValue({
      ...SETTINGS,
      autoLockMinutes: 5,
    })
    renderTab()

    await waitFor(() => {
      expect(select().value).toBe('5')
    })
  })

  it('saves the chosen number of minutes', async () => {
    renderTab()

    fireEvent.change(select(), { target: { value: '5' } })
    await waitFor(() => {
      expect(updateAppSettings).toHaveBeenCalledWith({ autoLockMinutes: 5 })
    })

    fireEvent.change(select(), { target: { value: '0' } })
    await waitFor(() => {
      expect(updateAppSettings).toHaveBeenCalledWith({ autoLockMinutes: 0 })
    })
    expect(updateAppSettings).toHaveBeenCalledTimes(2)
  })

  it('reloads the settings after saving', async () => {
    renderTab()
    await waitFor(() => {
      expect(getAppSettings).toHaveBeenCalledTimes(1)
    })

    fireEvent.change(select(), { target: { value: '60' } })

    await waitFor(() => {
      expect(getAppSettings).toHaveBeenCalledTimes(2)
    })
  })
})

describe('Lock now', () => {
  it('locks the app with the provider query client', () => {
    renderTab()

    fireEvent.click(screen.getByTestId('lock-now-btn'))

    expect(lockApp).toHaveBeenCalledTimes(1)
    expect(vi.mocked(lockApp).mock.calls[0][0]).toBe(client)
  })

  it('does not lock before the button is clicked', () => {
    renderTab()

    expect(lockApp).not.toHaveBeenCalled()
  })
})

describe('Change password', () => {
  it('rejects a new password shorter than 8 characters', () => {
    renderTab()

    fillChange('current password', 'short', 'short')
    submitOf('change-password-submit')

    expect(screen.getByTestId('change-password-error').textContent).toBeTruthy()
    expect(changePassword).not.toHaveBeenCalled()
    expect(screen.queryByTestId('change-password-success')).toBeNull()
  })

  it('rejects a mismatching confirmation', () => {
    renderTab()

    fillChange('current password', 'new password 1', 'new password 2')
    submitOf('change-password-submit')

    expect(screen.getByTestId('change-password-error').textContent).toBeTruthy()
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('calls changePassword(current, next), shows success and clears the fields', async () => {
    vi.mocked(changePassword).mockResolvedValue(undefined)
    renderTab()

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
    renderTab()

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
    renderTab()

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
    renderTab()
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
    renderTab()

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
