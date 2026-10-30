// No CONTRACT_GAPs: props, selectors and the confirm rule are specified in the
// Interface Contract (component: FamilyDeleteDialog) and plan section 7.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Lang } from '@/i18n/lang'
import { setLang, translate } from '@/i18n/core'
import { FamilyDeleteDialog } from '@/components/settings/FamilyDeleteDialog'

function renderDialog(over: Partial<React.ComponentProps<typeof FamilyDeleteDialog>> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    spaceName: 'Our Home',
    onConfirm: vi.fn(() => Promise.resolve()),
    onDownloadBackup: vi.fn(() => Promise.resolve()),
    ...over,
  }
  render(<FamilyDeleteDialog {...props} />)
  return props
}

function confirmButton() {
  return screen.getByTestId<HTMLButtonElement>('family-delete-confirm')
}

function type(value: string) {
  fireEvent.change(screen.getByTestId('family-delete-name-input'), { target: { value } })
}

beforeEach(() => {
  setLang('en', { persist: false })
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe.each<Lang>(['en', 'uk'])('the delete dialog (%s)', (lang) => {
  beforeEach(() => setLang(lang, { persist: false }))

  it('names the Family in the title and explains the effect', () => {
    renderDialog()

    const text = screen.getByTestId('family-delete-dialog').textContent
    expect(text).toContain(translate(lang, 'family.delete.title', { name: 'Our Home' }))
    expect(text).toContain(translate(lang, 'family.delete.body'))
    expect(text).toContain(translate(lang, 'family.delete.typeName'))
  })

  it('offers "Download backup first"', () => {
    renderDialog()

    expect(screen.getByTestId('family-delete-backup-btn').textContent).toContain(translate(lang, 'family.delete.backup'))
  })
})

describe('the confirm button', () => {
  it('is disabled until the typed name matches', () => {
    renderDialog()

    expect(confirmButton().disabled).toBe(true)
    type('Our')
    expect(confirmButton().disabled).toBe(true)
    type('our home')
    expect(confirmButton().disabled).toBe(true)
    type('Our Home')
    expect(confirmButton().disabled).toBe(false)
  })

  it('ignores surrounding whitespace on both sides', () => {
    renderDialog({ spaceName: '  Our Home ' })

    type(' Our Home  ')

    expect(confirmButton().disabled).toBe(false)
  })

  it('goes back to disabled when the name stops matching', () => {
    renderDialog()
    type('Our Home')
    expect(confirmButton().disabled).toBe(false)

    type('Our Hom')

    expect(confirmButton().disabled).toBe(true)
  })

  it('does not call onConfirm while disabled', () => {
    const props = renderDialog()

    fireEvent.click(confirmButton())

    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('calls onConfirm with the typed name', async () => {
    const props = renderDialog()
    type('Our Home')

    fireEvent.click(confirmButton())

    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledWith('Our Home'))
  })
})

describe('download backup first', () => {
  it('calls onDownloadBackup and does not delete', async () => {
    const props = renderDialog()

    fireEvent.click(screen.getByTestId('family-delete-backup-btn'))

    await waitFor(() => expect(props.onDownloadBackup).toHaveBeenCalledTimes(1))
    expect(props.onConfirm).not.toHaveBeenCalled()
  })
})

describe('open state', () => {
  it('renders nothing when closed', () => {
    renderDialog({ open: false })

    expect(screen.queryByTestId('family-delete-dialog')).toBeNull()
  })

  it('Cancel asks the parent to close', () => {
    const props = renderDialog()

    fireEvent.click(screen.getByText(translate('en', 'family.cancel')))

    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })
})
