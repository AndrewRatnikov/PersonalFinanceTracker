// CONTRACT_GAP: the text of sync-link-error for a failure that is not a
//   VaultError is not specified; only that it is shown and non-empty.
//
// SyncLinkDialog props, options and selectors are specified in plan section 10
// and the Interface Contract (component: SyncLinkDialog). The runtime actions
// and the backup download are fakes; the radio buttons are native inputs.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Lang } from '@/i18n/lang'
import type { CloudVault } from '@/lib/cloud/types'
import { setLang, translate } from '@/i18n/core'
import { downloadBackup } from '@/lib/backup'
import { SyncLinkDialog } from '@/components/settings/SyncLinkDialog'

const { actions } = vi.hoisted(() => ({
  actions: { joinAndKeep: vi.fn(), replaceCloud: vi.fn() },
}))

vi.mock('@/lib/sync/runtime', () => ({
  getSyncRuntime: () => ({ engine: {}, actions, setUserId: vi.fn() }),
}))
vi.mock('@/lib/backup', () => ({ downloadBackup: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const LANGS: Array<Lang> = ['en', 'uk']

const CLOUD: CloudVault = {
  vault_id: 'cloud-vault',
  header_rev: 4,
  header: {
    v: 2,
    vaultId: 'cloud-vault',
    createdAt: '2026-10-01T00:00:00.000Z',
    kdf: { alg: 'PBKDF2-SHA256', iterations: 600000, salt: 'c2FsdA==' },
    wrappedByPassword: { iv: 'aXY=', ct: 'Y3Q=' },
    recovery: { salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=' },
    verifier: { iv: 'aXY=', ct: 'Y3Q=' },
  },
}

function vaultError(code: string, retryAfterMs = 0): Error {
  return Object.assign(new Error(code), { name: 'VaultError', code, retryAfterMs })
}

let client = new QueryClient()

function renderDialog(props: { open?: boolean; cloud?: CloudVault | null } = {}) {
  const onOpenChange = vi.fn()
  const onLinked = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <SyncLinkDialog
        open={props.open ?? true}
        cloud={props.cloud === undefined ? CLOUD : props.cloud}
        onOpenChange={onOpenChange}
        onLinked={onLinked}
      />
    </QueryClientProvider>,
  )
  return { onOpenChange, onLinked }
}

function confirm() {
  return screen.getByTestId<HTMLButtonElement>('sync-link-confirm')
}

function choose(id: 'sync-link-option-join' | 'sync-link-option-replace') {
  fireEvent.click(screen.getByTestId(id))
}

function typeInto(id: string, value: string) {
  fireEvent.change(screen.getByTestId(id), { target: { value } })
}

beforeEach(() => {
  vi.resetAllMocks()
  client = new QueryClient()
  vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined)
  setLang('en', { persist: false })
  actions.joinAndKeep.mockResolvedValue({ ran: true })
  actions.replaceCloud.mockResolvedValue({ ran: true })
  vi.mocked(downloadBackup).mockResolvedValue({} as never)
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('layout', () => {
  it('renders nothing while closed', () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId('sync-link-dialog')).toBeNull()
  })

  it.each(LANGS)('explains the situation and offers both options in %s', (lang) => {
    setLang(lang, { persist: false })
    renderDialog()

    const dialog = screen.getByTestId('sync-link-dialog')
    expect(dialog.textContent).toContain(translate(lang, 'sync.link.body'))
    expect(dialog.textContent).toContain(translate(lang, 'sync.link.join'))
    expect(dialog.textContent).toContain(translate(lang, 'sync.link.replace'))
    expect(screen.getByTestId('sync-link-backup-btn').textContent.trim()).toBe(
      translate(lang, 'sync.link.backupFirst'),
    )
    expect(translate('en', 'sync.link.body')).not.toBe(translate('uk', 'sync.link.body'))
  })

  it('Join is the default option', () => {
    renderDialog()
    const join = screen.getByTestId<HTMLInputElement>('sync-link-option-join')
    const replace = screen.getByTestId<HTMLInputElement>('sync-link-option-replace')
    expect(join.type).toBe('radio')
    expect(replace.type).toBe('radio')
    expect(join.checked).toBe(true)
    expect(replace.checked).toBe(false)
  })

  it('Join asks for the cloud password and Replace asks for DELETE', () => {
    renderDialog()
    expect(screen.getByTestId('sync-link-password')).toBeTruthy()
    expect(screen.queryByTestId('sync-link-delete-input')).toBeNull()

    choose('sync-link-option-replace')
    expect(screen.getByTestId<HTMLInputElement>('sync-link-option-replace').checked).toBe(true)
    expect(screen.getByTestId<HTMLInputElement>('sync-link-option-join').checked).toBe(false)
    expect(screen.getByTestId('sync-link-delete-input')).toBeTruthy()
    expect(screen.queryByTestId('sync-link-password')).toBeNull()
    expect(screen.getByTestId('sync-link-dialog').textContent).toContain(
      translate('en', 'common.typeToConfirm', { word: 'DELETE' }),
    )

    choose('sync-link-option-join')
    expect(screen.getByTestId('sync-link-password')).toBeTruthy()
    expect(screen.queryByTestId('sync-link-delete-input')).toBeNull()
  })

  it('the password field hides what is typed', () => {
    renderDialog()
    expect(screen.getByTestId<HTMLInputElement>('sync-link-password').type).toBe('password')
  })
})

describe('Join cloud data and keep this device’s entries', () => {
  it('needs a password to confirm', () => {
    renderDialog()
    expect(confirm().disabled).toBe(true)
    typeInto('sync-link-password', 'cloud pw')
    expect(confirm().disabled).toBe(false)
  })

  it.each(LANGS)('joins with the typed password and refreshes the data in %s', async (lang) => {
    setLang(lang, { persist: false })
    const { onLinked } = renderDialog()
    expect(confirm().textContent.trim()).toBe(translate(lang, 'sync.link.confirm'))
    typeInto('sync-link-password', 'cloud pw')
    fireEvent.click(confirm())

    await waitFor(() => {
      expect(onLinked).toHaveBeenCalledTimes(1)
    })
    expect(actions.joinAndKeep).toHaveBeenCalledWith(CLOUD, 'cloud pw')
    expect(actions.replaceCloud).not.toHaveBeenCalled()
    expect(client.invalidateQueries).toHaveBeenCalled()
  })

  it('a wrong password shows the error in words and links nothing', async () => {
    actions.joinAndKeep.mockRejectedValue(vaultError('incorrect-password'))
    const { onLinked } = renderDialog()
    typeInto('sync-link-password', 'nope')
    fireEvent.click(confirm())

    const error = await screen.findByTestId('sync-link-error')
    expect(error.textContent).toBe(translate('en', 'errors.vault.incorrectPassword'))
    expect(onLinked).not.toHaveBeenCalled()
    expect(client.invalidateQueries).not.toHaveBeenCalled()
  })

  it('a throttled attempt shows the wait in Ukrainian', async () => {
    setLang('uk', { persist: false })
    actions.joinAndKeep.mockRejectedValue(vaultError('throttled', 29_000))
    renderDialog()
    typeInto('sync-link-password', 'nope')
    fireEvent.click(confirm())

    const error = await screen.findByTestId('sync-link-error')
    expect(error.textContent).toBe(translate('uk', 'errors.vault.throttled', { seconds: 29 }))
  })

  it('any other failure is shown and links nothing', async () => {
    actions.joinAndKeep.mockRejectedValue(new Error('Network error'))
    const { onLinked } = renderDialog()
    typeInto('sync-link-password', 'pw')
    fireEvent.click(confirm())

    const error = await screen.findByTestId('sync-link-error')
    expect(error.textContent.trim().length).toBeGreaterThan(0)
    expect(onLinked).not.toHaveBeenCalled()
  })
})

describe('Replace cloud data with this device', () => {
  it('needs exactly DELETE', () => {
    renderDialog()
    choose('sync-link-option-replace')
    expect(confirm().disabled).toBe(true)

    for (const wrong of ['delete', 'DELET', 'DELETE ', ' DELETE', 'yes']) {
      typeInto('sync-link-delete-input', wrong)
      expect(confirm().disabled, wrong).toBe(true)
    }
    typeInto('sync-link-delete-input', 'DELETE')
    expect(confirm().disabled).toBe(false)
  })

  it('replaces the cloud data after DELETE and refreshes', async () => {
    const { onLinked } = renderDialog()
    choose('sync-link-option-replace')
    typeInto('sync-link-delete-input', 'DELETE')
    fireEvent.click(confirm())

    await waitFor(() => {
      expect(onLinked).toHaveBeenCalledTimes(1)
    })
    expect(actions.replaceCloud).toHaveBeenCalledWith('DELETE')
    expect(actions.joinAndKeep).not.toHaveBeenCalled()
    expect(client.invalidateQueries).toHaveBeenCalled()
  })

  it('never calls the cloud until confirmed', () => {
    renderDialog()
    choose('sync-link-option-replace')
    typeInto('sync-link-delete-input', 'DELETE')
    expect(actions.replaceCloud).not.toHaveBeenCalled()
  })

  it('shows a failure and links nothing', async () => {
    actions.replaceCloud.mockRejectedValue(new Error('Quota'))
    const { onLinked } = renderDialog()
    choose('sync-link-option-replace')
    typeInto('sync-link-delete-input', 'DELETE')
    fireEvent.click(confirm())

    expect((await screen.findByTestId('sync-link-error')).textContent.trim().length).toBeGreaterThan(0)
    expect(onLinked).not.toHaveBeenCalled()
  })
})

describe('Download backup first and Cancel', () => {
  it('the backup button downloads a backup and nothing else', async () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('sync-link-backup-btn'))

    await waitFor(() => {
      expect(downloadBackup).toHaveBeenCalledTimes(1)
    })
    expect(actions.joinAndKeep).not.toHaveBeenCalled()
    expect(actions.replaceCloud).not.toHaveBeenCalled()
  })

  it('Cancel closes the dialog and changes nothing', () => {
    const { onOpenChange, onLinked } = renderDialog()
    typeInto('sync-link-password', 'typed')
    fireEvent.click(screen.getByTestId('sync-link-cancel'))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onLinked).not.toHaveBeenCalled()
    expect(actions.joinAndKeep).not.toHaveBeenCalled()
    expect(actions.replaceCloud).not.toHaveBeenCalled()
    expect(downloadBackup).not.toHaveBeenCalled()
    expect(client.invalidateQueries).not.toHaveBeenCalled()
  })
})
