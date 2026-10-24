// No CONTRACT_GAPs: DeleteCloudDataDialog props and selectors are specified in
// plan section 10 and the Interface Contract (component:
// DeleteCloudDataDialog). The runtime action is a fake; vault errors are plain
// errors named "VaultError" (the app recognises them by name and code).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Lang } from '@/i18n/lang'
import { setLang, translate } from '@/i18n/core'
import { DeleteCloudDataDialog } from '@/components/settings/DeleteCloudDataDialog'

const { actions, toastSuccess, toastError } = vi.hoisted(() => ({
  actions: { deleteCloudData: vi.fn() },
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/lib/sync/runtime', () => ({
  getSyncRuntime: () => ({ engine: {}, actions, setUserId: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))

const LANGS: Array<Lang> = ['en', 'uk']

function vaultError(code: string, retryAfterMs = 0): Error {
  return Object.assign(new Error(code), { name: 'VaultError', code, retryAfterMs })
}

function renderDialog(props: { open?: boolean; onDeleted?: () => void } = {}) {
  const onOpenChange = vi.fn()
  const onDeleted = props.onDeleted ?? vi.fn()
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <DeleteCloudDataDialog
        open={props.open ?? true}
        onOpenChange={onOpenChange}
        onDeleted={onDeleted}
      />
    </QueryClientProvider>,
  )
  return { onOpenChange, onDeleted }
}

function typePassword(value: string) {
  fireEvent.change(screen.getByTestId('delete-cloud-password'), { target: { value } })
}

function confirm() {
  return screen.getByTestId<HTMLButtonElement>('delete-cloud-confirm')
}

beforeEach(() => {
  vi.resetAllMocks()
  setLang('en', { persist: false })
  actions.deleteCloudData.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('DeleteCloudDataDialog', () => {
  it('renders nothing while closed', () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId('delete-cloud-dialog')).toBeNull()
  })

  it.each(LANGS)('explains what is deleted and asks for the password in %s', (lang) => {
    setLang(lang, { persist: false })
    renderDialog()

    const dialog = screen.getByTestId('delete-cloud-dialog')
    expect(dialog.textContent).toContain(translate(lang, 'sync.deleteCloud.body'))
    const input = screen.getByTestId<HTMLInputElement>('delete-cloud-password')
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    expect(screen.queryByTestId('delete-cloud-error')).toBeNull()
  })

  it('the confirm button needs a password', () => {
    renderDialog()
    expect(confirm().disabled).toBe(true)
    typePassword('secret')
    expect(confirm().disabled).toBe(false)
    typePassword('')
    expect(confirm().disabled).toBe(true)
  })

  it('does nothing until confirmed', () => {
    renderDialog()
    typePassword('secret')
    expect(actions.deleteCloudData).not.toHaveBeenCalled()
  })

  it('deletes with the typed password, says so, tells the caller and closes', async () => {
    const { onOpenChange, onDeleted } = renderDialog()
    typePassword('my password')
    fireEvent.click(confirm())

    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledTimes(1)
    })
    expect(actions.deleteCloudData).toHaveBeenCalledTimes(1)
    expect(actions.deleteCloudData).toHaveBeenCalledWith('my password')
    expect(toastSuccess).toHaveBeenCalledWith(translate('en', 'sync.toast.cloudDeleted'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('another password is sent as typed', async () => {
    renderDialog()
    typePassword('  spaces  kept ')
    fireEvent.click(confirm())
    await waitFor(() => {
      expect(actions.deleteCloudData).toHaveBeenCalledWith('  spaces  kept ')
    })
  })

  it('works without an onDeleted callback', async () => {
    const client = new QueryClient()
    const onOpenChange = vi.fn()
    render(
      <QueryClientProvider client={client}>
        <DeleteCloudDataDialog open onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    )
    typePassword('pw')
    fireEvent.click(confirm())
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it.each(LANGS)('a wrong password shows the vault error in %s and keeps the dialog', async (lang) => {
    setLang(lang, { persist: false })
    actions.deleteCloudData.mockRejectedValue(vaultError('incorrect-password'))
    const { onOpenChange, onDeleted } = renderDialog()
    typePassword('nope')
    fireEvent.click(confirm())

    const error = await screen.findByTestId('delete-cloud-error')
    expect(error.textContent).toBe(translate(lang, 'errors.vault.incorrectPassword'))
    expect(onDeleted).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(screen.getByTestId('delete-cloud-dialog')).toBeTruthy()
  })

  it('a throttled attempt shows the wait', async () => {
    actions.deleteCloudData.mockRejectedValue(vaultError('throttled', 12_400))
    renderDialog()
    typePassword('nope')
    fireEvent.click(confirm())

    const error = await screen.findByTestId('delete-cloud-error')
    expect(error.textContent).toBe(translate('en', 'errors.vault.throttled', { seconds: 13 }))
  })

  it('shows a server failure and lets the user try again', async () => {
    actions.deleteCloudData.mockRejectedValueOnce(new Error('Network error'))
    const { onDeleted } = renderDialog()
    typePassword('pw')
    fireEvent.click(confirm())

    const error = await screen.findByTestId('delete-cloud-error')
    expect(error.textContent).toBe('Network error')
    expect(onDeleted).not.toHaveBeenCalled()

    fireEvent.click(confirm())
    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledTimes(1)
    })
    expect(actions.deleteCloudData).toHaveBeenCalledTimes(2)
  })

  it('disables the confirm button while the request runs', async () => {
    let finish!: () => void
    actions.deleteCloudData.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    const { onDeleted } = renderDialog()
    typePassword('pw')
    fireEvent.click(confirm())

    await waitFor(() => {
      expect(confirm().disabled).toBe(true)
    })
    fireEvent.click(confirm())
    expect(actions.deleteCloudData).toHaveBeenCalledTimes(1)

    finish()
    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledTimes(1)
    })
  })
})
