// No CONTRACT_GAPs: props, testids and validation messages are fully specified
// in the Interface Contract (component: CreateVaultScreen). Phase 3 adds the
// persist() request after createVault and the optional Back button. The
// persist tests mock @/lib/appSettings and stub navigator.storage, so the real
// requestPersistentStorage runs.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { updateAppSettings } from '@/lib/appSettings'
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
vi.mock('@/lib/appSettings', () => ({ updateAppSettings: vi.fn() }))

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

function stubStorage(persist: () => Promise<boolean>) {
  Object.defineProperty(navigator, 'storage', {
    value: { persist },
    configurable: true,
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(updateAppSettings).mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(navigator, 'storage')
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

describe('CreateVaultScreen Back button', () => {
  it('is not rendered without onCancel', () => {
    render(<CreateVaultScreen onCreated={vi.fn()} />)

    expect(screen.queryByTestId('create-vault-cancel')).toBeNull()
  })

  it('is rendered with onCancel and calls it', () => {
    const onCancel = vi.fn()
    render(<CreateVaultScreen onCreated={vi.fn()} onCancel={onCancel} />)

    fireEvent.click(screen.getByTestId('create-vault-cancel'))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(createVault).not.toHaveBeenCalled()
  })

  it('is gone on the recovery key step', async () => {
    vi.mocked(createVault).mockResolvedValue({ recoveryKey: KEY })
    render(<CreateVaultScreen onCreated={vi.fn()} onCancel={vi.fn()} />)
    fill('long enough 1', 'long enough 1')
    submit()

    await screen.findByTestId('recovery-key-step')

    expect(screen.queryByTestId('create-vault-cancel')).toBeNull()
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

describe('CreateVaultScreen persistent storage request', () => {
  it('calls navigator.storage.persist() once after createVault succeeds', async () => {
    const persist = vi.fn().mockResolvedValue(true)
    stubStorage(persist)
    vi.mocked(createVault).mockResolvedValue({ recoveryKey: KEY })
    render(<CreateVaultScreen onCreated={vi.fn()} />)
    fill('long enough 1', 'long enough 1')
    expect(persist).not.toHaveBeenCalled()

    submit()
    await screen.findByTestId('recovery-key-step')

    await waitFor(() => {
      expect(persist).toHaveBeenCalledTimes(1)
    })
    expect(
      vi.mocked(createVault).mock.invocationCallOrder[0],
    ).toBeLessThan(persist.mock.invocationCallOrder[0])
  })

  it('records persistRequestedAt in the app settings', async () => {
    stubStorage(vi.fn().mockResolvedValue(true))
    vi.mocked(createVault).mockResolvedValue({ recoveryKey: KEY })
    render(<CreateVaultScreen onCreated={vi.fn()} />)
    fill('long enough 1', 'long enough 1')

    submit()

    await waitFor(() => {
      expect(updateAppSettings).toHaveBeenCalledTimes(1)
    })
    const patch = vi.mocked(updateAppSettings).mock.calls[0][0]
    expect(typeof patch.persistRequestedAt).toBe('string')
  })

  it('does not call persist() when createVault rejects', async () => {
    const persist = vi.fn().mockResolvedValue(true)
    stubStorage(persist)
    vi.mocked(createVault).mockRejectedValue(
      new MockVaultError('invalid-state', 'A vault already exists on this device'),
    )
    render(<CreateVaultScreen onCreated={vi.fn()} />)
    fill('long enough 1', 'long enough 1')

    submit()
    await screen.findByTestId('create-vault-error')

    expect(persist).not.toHaveBeenCalled()
  })

  it('does not call persist() when validation fails', () => {
    const persist = vi.fn().mockResolvedValue(true)
    stubStorage(persist)
    render(<CreateVaultScreen onCreated={vi.fn()} />)
    fill('short', 'short')

    submit()

    expect(persist).not.toHaveBeenCalled()
  })

  it('still reaches the recovery key step when persist() rejects', async () => {
    stubStorage(vi.fn().mockRejectedValue(new Error('denied')))
    vi.mocked(createVault).mockResolvedValue({ recoveryKey: KEY })
    render(<CreateVaultScreen onCreated={vi.fn()} />)
    fill('long enough 1', 'long enough 1')

    submit()

    await screen.findByTestId('recovery-key-step')
    expect(screen.getByTestId('recovery-key-value').textContent).toBe(KEY)
  })

  it('still reaches the recovery key step when the storage API is missing', async () => {
    vi.mocked(createVault).mockResolvedValue({ recoveryKey: KEY })
    render(<CreateVaultScreen onCreated={vi.fn()} />)
    fill('long enough 1', 'long enough 1')

    submit()

    await screen.findByTestId('recovery-key-step')
    expect(updateAppSettings).not.toHaveBeenCalled()
  })
})
