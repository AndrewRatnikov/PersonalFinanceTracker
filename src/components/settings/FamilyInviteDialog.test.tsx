// No CONTRACT_GAPs: props, selectors and the Copy / Share behaviour are
// specified in the Interface Contract (component: FamilyInviteDialog) and plan
// section 7. sonner's toast and the clipboard are fakes.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Lang } from '@/i18n/lang'
import { setLang, translate } from '@/i18n/core'
import { FamilyInviteDialog } from '@/components/settings/FamilyInviteDialog'

const { toastFn } = vi.hoisted(() => ({ toastFn: vi.fn() }))

vi.mock('sonner', () => ({
  toast: Object.assign(toastFn, { success: toastFn, error: vi.fn() }),
}))

const INVITE = {
  url: 'https://minima.example/join#invite-id.c2VjcmV0LXNlY3JldA',
  inviteId: 'invite-id',
  expiresAt: '2026-11-01T10:00:00.000Z',
}

const writeText = vi.fn(() => Promise.resolve())

function setShare(value: unknown) {
  Object.defineProperty(navigator, 'share', { value, configurable: true, writable: true })
}

function renderDialog(props: Partial<React.ComponentProps<typeof FamilyInviteDialog>> = {}) {
  const onOpenChange = vi.fn()
  const view = render(<FamilyInviteDialog open onOpenChange={onOpenChange} invite={INVITE} {...props} />)
  return { ...view, onOpenChange }
}

beforeEach(() => {
  vi.clearAllMocks()
  setLang('en', { persist: false })
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  setShare(undefined)
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe.each<Lang>(['en', 'uk'])('the invite dialog (%s)', (lang) => {
  beforeEach(() => setLang(lang, { persist: false }))

  it('shows the link in a read-only input', () => {
    renderDialog()

    const input = screen.getByTestId<HTMLInputElement>('family-invite-link')
    expect(input.value).toBe(INVITE.url)
    expect(input.readOnly).toBe(true)
    expect(screen.getByTestId('family-invite-dialog')).toBeTruthy()
  })

  it('shows the note sentence', () => {
    renderDialog()

    expect(screen.getByTestId('family-invite-note').textContent).toContain(translate(lang, 'family.inviteDialog.note'))
  })

  it('Copy writes the link to the clipboard and toasts "Link copied"', async () => {
    renderDialog()

    fireEvent.click(screen.getByTestId('family-invite-copy-btn'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(INVITE.url))
    await waitFor(() => expect(toastFn).toHaveBeenCalledWith(translate(lang, 'family.inviteDialog.copied')))
  })
})

describe('the note text', () => {
  it('is the exact English sentence', () => {
    renderDialog()

    expect(screen.getByTestId('family-invite-note').textContent).toContain(
      'Anyone with this link can ask to join. You approve every request. The link works once and expires in 48 hours.',
    )
  })
})

describe('Share', () => {
  it('is not rendered when navigator.share is missing', () => {
    renderDialog()

    expect(screen.queryByTestId('family-invite-share-btn')).toBeNull()
  })

  it('is rendered when navigator.share is a function and shares the url', async () => {
    const share = vi.fn(() => Promise.resolve())
    setShare(share)
    renderDialog()

    fireEvent.click(screen.getByTestId('family-invite-share-btn'))

    await waitFor(() => expect(share).toHaveBeenCalledWith({ url: INVITE.url }))
  })

  it('ignores an AbortError (the user closed the share sheet)', async () => {
    const share = vi.fn(() => Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })))
    setShare(share)
    renderDialog()

    fireEvent.click(screen.getByTestId('family-invite-share-btn'))

    await waitFor(() => expect(share).toHaveBeenCalled())
    expect(toastFn).not.toHaveBeenCalled()
    expect(screen.getByTestId('family-invite-dialog')).toBeTruthy()
  })
})

describe('open and close', () => {
  it('renders nothing when closed', () => {
    renderDialog({ open: false })

    expect(screen.queryByTestId('family-invite-dialog')).toBeNull()
  })

  it('renders no link without an invite', () => {
    renderDialog({ invite: null })

    expect(screen.queryByTestId<HTMLInputElement>('family-invite-link')?.value ?? '').toBe('')
  })

  it('Close asks the parent to close', () => {
    const { onOpenChange } = renderDialog()

    fireEvent.click(screen.getByText(translate('en', 'family.inviteDialog.close')))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
