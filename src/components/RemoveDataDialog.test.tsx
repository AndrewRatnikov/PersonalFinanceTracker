// No CONTRACT_GAPs: RemoveDataDialog props, selectors and mocks are fully
// specified in the Interface Contract (component: RemoveDataDialog).

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { exportAllLocalData } from '@/lib/localExport'
import { reloadToHome, wipeLocalData } from '@/lib/localWipe'
import { verifyPassword } from '@/lib/vault'
import { RemoveDataDialog } from '@/components/RemoveDataDialog'

const { MockVaultError, toastError, toastSuccess } = vi.hoisted(() => {
  class HoistedVaultError extends Error {
    code: string
    retryAfterMs: number
    constructor(code: string, message: string, retryAfterMs = 0) {
      super(message)
      this.name = 'VaultError'
      this.code = code
      this.retryAfterMs = retryAfterMs
    }
  }
  return { MockVaultError: HoistedVaultError, toastError: vi.fn(), toastSuccess: vi.fn() }
})

vi.mock('@/lib/vault', () => ({
  verifyPassword: vi.fn(),
  VaultError: MockVaultError,
}))
vi.mock('@/lib/localWipe', () => ({
  wipeLocalData: vi.fn(),
  reloadToHome: vi.fn(),
}))
vi.mock('@/lib/localExport', () => ({ exportAllLocalData: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function renderDialog(
  props: Partial<React.ComponentProps<typeof RemoveDataDialog>> = {},
) {
  const onOpenChange = vi.fn()
  render(<RemoveDataDialog open onOpenChange={onOpenChange} {...props} />)
  return onOpenChange
}

function confirmButton() {
  return screen.getByTestId<HTMLButtonElement>('remove-data-confirm-btn')
}

function typePassword(value: string) {
  fireEvent.change(screen.getByTestId('remove-data-password-input'), {
    target: { value },
  })
}

function typeDelete(value: string) {
  fireEvent.change(screen.getByTestId('remove-data-delete-input'), {
    target: { value },
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(verifyPassword).mockResolvedValue(undefined)
  vi.mocked(wipeLocalData).mockResolvedValue(undefined)
  vi.mocked(exportAllLocalData).mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe('RemoveDataDialog layout', () => {
  it('renders nothing when closed', () => {
    renderDialog({ open: false })

    expect(screen.queryByTestId('remove-data-dialog')).toBeNull()
  })

  it('defaults to password confirmation with a backup button', () => {
    renderDialog()

    expect(screen.getByTestId('remove-data-dialog')).toBeTruthy()
    expect(screen.getByTestId('remove-data-password-input')).toBeTruthy()
    expect(screen.getByTestId('remove-data-backup-btn').textContent).toContain(
      'Download backup first',
    )
    expect(screen.queryByTestId('remove-data-delete-input')).toBeNull()
    expect(confirmButton().textContent).toContain('Remove all data')
    expect(screen.getByTestId('remove-data-cancel-btn')).toBeTruthy()
    expect(screen.queryByTestId('remove-data-error')).toBeNull()
  })

  it('typed-delete mode has the DELETE input and no backup button or password input', () => {
    renderDialog({ confirmWith: 'typed-delete' })

    expect(screen.getByTestId('remove-data-delete-input')).toBeTruthy()
    expect(screen.queryByTestId('remove-data-password-input')).toBeNull()
    expect(screen.queryByTestId('remove-data-backup-btn')).toBeNull()
    expect(screen.getByTestId('remove-data-dialog').textContent).toContain(
      'Type DELETE to confirm',
    )
  })

  it('explains what will be deleted', () => {
    renderDialog()

    const text = screen.getByTestId('remove-data-dialog').textContent.toLowerCase()
    expect(text).toContain('expenses')
    expect(text).toContain('recovery key')
  })
})

describe('RemoveDataDialog password confirmation', () => {
  it('keeps the confirm button disabled until a password is entered', () => {
    renderDialog()
    expect(confirmButton().disabled).toBe(true)

    typePassword('hunter2 hunter2')
    expect(confirmButton().disabled).toBe(false)

    typePassword('')
    expect(confirmButton().disabled).toBe(true)
  })

  it('verifies the password, then wipes, then reloads, in that order', async () => {
    renderDialog()
    typePassword('correct horse')

    fireEvent.click(confirmButton())

    await waitFor(() => {
      expect(reloadToHome).toHaveBeenCalledTimes(1)
    })
    expect(verifyPassword).toHaveBeenCalledWith('correct horse')
    expect(wipeLocalData).toHaveBeenCalledTimes(1)
    const verifyOrder = vi.mocked(verifyPassword).mock.invocationCallOrder[0]
    const wipeOrder = vi.mocked(wipeLocalData).mock.invocationCallOrder[0]
    const reloadOrder = vi.mocked(reloadToHome).mock.invocationCallOrder[0]
    expect(verifyOrder).toBeLessThan(wipeOrder)
    expect(wipeOrder).toBeLessThan(reloadOrder)
  })

  it('shows the error and does not wipe or reload for a wrong password', async () => {
    vi.mocked(verifyPassword).mockRejectedValue(
      new MockVaultError('incorrect-password', 'Incorrect password'),
    )
    renderDialog()
    typePassword('wrong one')

    fireEvent.click(confirmButton())

    await waitFor(() => {
      expect(screen.getByTestId('remove-data-error').textContent).toBe(
        'Incorrect password',
      )
    })
    expect(wipeLocalData).not.toHaveBeenCalled()
    expect(reloadToHome).not.toHaveBeenCalled()
    expect(screen.getByTestId('remove-data-dialog')).toBeTruthy()
  })

  it('shows a throttle message and does not wipe', async () => {
    vi.mocked(verifyPassword).mockRejectedValue(
      new MockVaultError('throttled', 'Too many attempts. Try again in 5 s.', 5000),
    )
    renderDialog()
    typePassword('anything')

    fireEvent.click(confirmButton())

    await waitFor(() => {
      expect(screen.getByTestId('remove-data-error').textContent).toContain(
        'Too many attempts',
      )
    })
    expect(wipeLocalData).not.toHaveBeenCalled()
  })

  it('shows "Could not remove data" and does not reload when the wipe fails', async () => {
    vi.mocked(wipeLocalData).mockRejectedValue(new Error('idb blocked'))
    renderDialog()
    typePassword('correct horse')

    fireEvent.click(confirmButton())

    await waitFor(() => {
      expect(screen.getByTestId('remove-data-error').textContent).toContain(
        'Could not remove data',
      )
    })
    expect(screen.getByTestId('remove-data-error').textContent).toContain(
      'idb blocked',
    )
    expect(reloadToHome).not.toHaveBeenCalled()
  })

  it('disables the confirm button while verification is pending', async () => {
    const pending = deferred<undefined>()
    vi.mocked(verifyPassword).mockReturnValue(pending.promise)
    renderDialog()
    typePassword('correct horse')

    fireEvent.click(confirmButton())

    await waitFor(() => {
      expect(confirmButton().disabled).toBe(true)
    })
    expect(wipeLocalData).not.toHaveBeenCalled()

    pending.resolve(undefined)
    await waitFor(() => {
      expect(reloadToHome).toHaveBeenCalled()
    })
  })

  it('does not wipe when the confirm button is clicked with an empty password', () => {
    renderDialog()

    fireEvent.click(confirmButton())

    expect(verifyPassword).not.toHaveBeenCalled()
    expect(wipeLocalData).not.toHaveBeenCalled()
  })
})

describe('RemoveDataDialog typed DELETE confirmation', () => {
  it('enables the confirm button only for exactly DELETE', () => {
    renderDialog({ confirmWith: 'typed-delete' })
    expect(confirmButton().disabled).toBe(true)

    for (const wrong of ['delete', 'DELET', 'DELETE!', 'DELETE ', ' DELETE']) {
      typeDelete(wrong)
      expect(confirmButton().disabled).toBe(true)
    }

    typeDelete('DELETE')
    expect(confirmButton().disabled).toBe(false)
  })

  it('wipes and reloads without ever verifying a password', async () => {
    renderDialog({ confirmWith: 'typed-delete' })
    typeDelete('DELETE')

    fireEvent.click(confirmButton())

    await waitFor(() => {
      expect(reloadToHome).toHaveBeenCalledTimes(1)
    })
    expect(wipeLocalData).toHaveBeenCalledTimes(1)
    expect(verifyPassword).not.toHaveBeenCalled()
  })

  it('does not wipe when clicked while the text is wrong', () => {
    renderDialog({ confirmWith: 'typed-delete' })
    typeDelete('delete')

    fireEvent.click(confirmButton())

    expect(wipeLocalData).not.toHaveBeenCalled()
    expect(reloadToHome).not.toHaveBeenCalled()
  })
})

describe('RemoveDataDialog backup and cancel', () => {
  it('Download backup first runs the CSV export and does not wipe', async () => {
    renderDialog()

    fireEvent.click(screen.getByTestId('remove-data-backup-btn'))

    await waitFor(() => {
      expect(exportAllLocalData).toHaveBeenCalledTimes(1)
    })
    expect(wipeLocalData).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('shows a toast when the backup fails', async () => {
    vi.mocked(exportAllLocalData).mockRejectedValue(new Error('no data'))
    renderDialog()

    fireEvent.click(screen.getByTestId('remove-data-backup-btn'))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled()
    })
    expect(wipeLocalData).not.toHaveBeenCalled()
  })

  it('Cancel closes the dialog without wiping', () => {
    const onOpenChange = renderDialog()

    fireEvent.click(screen.getByTestId('remove-data-cancel-btn'))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(wipeLocalData).not.toHaveBeenCalled()
  })
})
