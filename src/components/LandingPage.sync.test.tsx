// No CONTRACT_GAPs: the landing copy rules are specified in plan section 10 and
// the Interface Contract (component changes: LandingPage). Flags are mutable
// getters; the sync copy appears only with ENABLE_SYNC and visible accounts and
// the page is otherwise identical.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { Lang } from '@/i18n/lang'
import { setLang, translate } from '@/i18n/core'
import { useAccountsVisible } from '@/lib/accountSession'
import { cancelCreateVault, setVaultPhase } from '@/lib/vaultSession'
import LandingPage from '@/components/LandingPage'

const flags = vi.hoisted(() => ({ sync: true }))

vi.mock('@/lib/featureFlags', () => ({
  ENABLE_ACCOUNTS: true,
  get ENABLE_SYNC() {
    return flags.sync
  },
}))
vi.mock('@/lib/accountSession', () => ({
  useAccountsVisible: vi.fn(),
  useAccountSession: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string
    children?: ReactNode
    className?: string
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))
vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))
vi.mock('@/lib/backup', () => ({ formatRestoreSummary: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/RestoreBackupDialog', () => ({
  RestoreBackupDialog: () => null,
}))

const LANGS: Array<Lang> = ['en', 'uk']

function bullets(): HTMLElement {
  return screen.getByTestId('landing-privacy-bullets')
}

function bulletTexts(): Array<string> {
  return Array.from(bullets().children).map((c) => c.textContent.trim())
}

beforeEach(() => {
  vi.resetAllMocks()
  flags.sync = true
  setLang('en', { persist: false })
  vi.mocked(useAccountsVisible).mockReturnValue(true)
  setVaultPhase('none')
  cancelCreateVault()
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe.each(LANGS)('landing with sync flags off (%s)', (lang) => {
  beforeEach(() => {
    flags.sync = false
    setLang(lang, { persist: false })
  })

  it('keeps today’s four privacy bullets, with the zero-data one', () => {
    render(<LandingPage />)

    expect(bulletTexts()).toEqual([
      translate(lang, 'landing.privacy.bullet1'),
      translate(lang, 'landing.privacy.bullet2'),
      translate(lang, 'landing.privacy.bullet3'),
      translate(lang, 'landing.privacy.bullet4'),
    ])
  })

  it('has no sync line in the features', () => {
    render(<LandingPage />)
    expect(screen.queryByTestId('landing-sync-feature')).toBeNull()
    expect(document.body.textContent).not.toContain(translate(lang, 'landing.features.syncLine'))
    expect(document.body.textContent).not.toContain(translate(lang, 'landing.privacy.bullet2Sync'))
  })
})

describe.each(LANGS)('landing with sync on and accounts visible (%s)', (lang) => {
  beforeEach(() => {
    setLang(lang, { persist: false })
  })

  it('replaces the zero-data bullet with the optional-sync one and keeps the rest', () => {
    render(<LandingPage />)

    expect(bulletTexts()).toEqual([
      translate(lang, 'landing.privacy.bullet1'),
      translate(lang, 'landing.privacy.bullet2Sync'),
      translate(lang, 'landing.privacy.bullet3'),
      translate(lang, 'landing.privacy.bullet4'),
    ])
    expect(bullets().textContent).not.toContain(translate(lang, 'landing.privacy.bullet2'))
  })

  it('adds the sync line to the features', () => {
    render(<LandingPage />)
    expect(screen.getByTestId('landing-sync-feature').textContent.trim()).toBe(
      translate(lang, 'landing.features.syncLine'),
    )
  })

  it('still has the page', () => {
    render(<LandingPage />)
    expect(screen.getByTestId('landing-page')).toBeTruthy()
  })
})

describe('the two languages', () => {
  it('have different sync copy', () => {
    expect(translate('en', 'landing.privacy.bullet2Sync')).not.toBe(
      translate('uk', 'landing.privacy.bullet2Sync'),
    )
    expect(translate('en', 'landing.features.syncLine')).not.toBe(
      translate('uk', 'landing.features.syncLine'),
    )
    expect(translate('en', 'landing.privacy.bullet2Sync')).not.toBe(
      translate('en', 'landing.privacy.bullet2'),
    )
  })
})

describe('sync on but accounts hidden', () => {
  it('looks exactly like the page with the flag off', () => {
    vi.mocked(useAccountsVisible).mockReturnValue(false)
    render(<LandingPage />)
    const hiddenAccounts = bullets().innerHTML
    const hasSyncLine = screen.queryByTestId('landing-sync-feature') !== null
    cleanup()

    flags.sync = false
    vi.mocked(useAccountsVisible).mockReturnValue(true)
    render(<LandingPage />)

    expect(hasSyncLine).toBe(false)
    expect(bullets().innerHTML).toBe(hiddenAccounts)
    expect(bulletTexts()[1]).toBe(translate('en', 'landing.privacy.bullet2'))
  })
})
