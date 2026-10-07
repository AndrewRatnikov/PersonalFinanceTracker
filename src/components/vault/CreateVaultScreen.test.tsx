// No CONTRACT_GAPs: props, testids and validation messages are fully specified
// in the Interface Contract (component: CreateVaultScreen).

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createVault } from '@/lib/vault'
import { CreateVaultScreen } from '@/components/vault/CreateVaultScreen'

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
  createVault: vi.fn(),
  VaultError: MockVaultError,
}))

const KEY = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-XY'

function fill(password: string, confirm: string) {
  fireEvent.change(screen.getByTestId('create-vault-password-input'), {
    target: { value: password },
  })
  fireEvent.change(screen.getByTestId('create-vault-confirm-input'), {
    target: { value: confirm },
  })
}

function submit() {
  const form = screen.getByTestId('create-vault-submit').closest('form')
  if (!form) throw new Error('submit button is not inside a form')
  fireEvent.submit(form)
}

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('CreateVaultScreen password step', () => {
  it('renders the password and confirmation inputs and a submit button', () => {
    render(<CreateVaultScreen onCreated={vi.fn()} />)

    expect(screen.getByTestId('create-vault-screen')).toBeTruthy()
    expect(
      screen.getByTestId<HTMLInputElement>('create-vault-password-input').id,
    ).toBe('password')
    expect(
      screen.getByTestId<HTMLInputElement>('create-vault-confirm-input').id,
    ).toBe('confirm')
    expect(
      screen.getByTestId<HTMLButtonElement>('create-vault-submit').type,
    ).toBe('submit')
    expect(screen.queryByTestId('recovery-key-step')).toBeNull()
  })

  it('shows a length-based strength hint that changes with the password', () => {
    render(<CreateVaultScreen onCreated={vi.fn()} />)
    const hint = () => screen.getByTestId('create-vault-strength').textContent

    fill('short', '')
    expect(hint()).toContain('Too short')
    fill('eightchr', '')
    expect(hint()).toContain('OK')
    fill('a-much-longer-password', '')
    expect(hint()).toContain('Strong')
  })

  it('rejects a password shorter than 8 characters without calling createVault', () => {
    render(<CreateVaultScreen onCreated={vi.fn()} />)

    fill('short', 'short')
    submit()

    expect(screen.getByTestId('create-vault-error').textContent).toBe(
      'Password must be at least 8 characters',
    )
    expect(createVault).not.toHaveBeenCalled()
  })

  it('rejects mismatched passwords without calling createVault', () => {
    render(<CreateVaultScreen onCreated={vi.fn()} />)

    fill('long enough 1', 'long enough 2')
    submit()

    expect(screen.getByTestId('create-vault-error').textContent).toBe(
      'Passwords do not match',
    )
    expect(createVault).not.toHaveBeenCalled()
  })

  it('shows a VaultError message from createVault and stays on the password step', async () => {
    vi.mocked(createVault).mockRejectedValue(
      new MockVaultError('invalid-state', 'A vault already exists on this device'),
    )
    render(<CreateVaultScreen onCreated={vi.fn()} />)

    fill('long enough 1', 'long enough 1')
    submit()

    await waitFor(() => {
      expect(screen.getByTestId('create-vault-error').textContent).toBe(
        'A vault already exists on this device',
      )
    })
    expect(screen.queryByTestId('recovery-key-step')).toBeNull()
  })
})

describe('CreateVaultScreen recovery key step', () => {
  async function createAndReachKeyStep(onCreated = vi.fn()) {
    vi.mocked(createVault).mockResolvedValue({ recoveryKey: KEY })
    render(<CreateVaultScreen onCreated={onCreated} />)
    fill('long enough 1', 'long enough 1')
    submit()
    await screen.findByTestId('recovery-key-step')
    return onCreated
  }

  it('calls createVault with the password and then shows the recovery key', async () => {
    await createAndReachKeyStep()

    expect(createVault).toHaveBeenCalledTimes(1)
    expect(createVault).toHaveBeenCalledWith('long enough 1')
    expect(screen.getByTestId('recovery-key-value').textContent).toBe(KEY)
  })

  it('does not call onCreated until the key is confirmed and continue is clicked', async () => {
    const onCreated = await createAndReachKeyStep()

    expect(onCreated).not.toHaveBeenCalled()
    expect(
      screen.getByTestId<HTMLButtonElement>('recovery-key-continue').disabled,
    ).toBe(true)

    fireEvent.click(screen.getByTestId('recovery-key-saved-checkbox'))
    fireEvent.change(screen.getByTestId('recovery-key-last-group-input'), {
      target: { value: 'xy' },
    })
    expect(onCreated).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('recovery-key-continue'))
    expect(onCreated).toHaveBeenCalledTimes(1)
  })

  it('keeps continue disabled with a wrong last group', async () => {
    const onCreated = await createAndReachKeyStep()

    fireEvent.click(screen.getByTestId('recovery-key-saved-checkbox'))
    fireEvent.change(screen.getByTestId('recovery-key-last-group-input'), {
      target: { value: 'ZZ' },
    })

    expect(
      screen.getByTestId<HTMLButtonElement>('recovery-key-continue').disabled,
    ).toBe(true)
    fireEvent.click(screen.getByTestId('recovery-key-continue'))
    expect(onCreated).not.toHaveBeenCalled()
  })
})
