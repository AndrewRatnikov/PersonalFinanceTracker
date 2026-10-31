// No CONTRACT_GAPs: the Family feature line is specified in plan section 5
// (Landing): shown under the sync line when ENABLE_SPACES is true, in en and uk.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { Lang } from '@/i18n/lang'
import { setLang, translate } from '@/i18n/core'
import { useAccountsVisible } from '@/lib/accountSession'
import { cancelCreateVault, setVaultPhase } from '@/lib/vaultSession'
import LandingPage from '@/components/LandingPage'

const flags = vi.hoisted(() => ({ spaces: true }))

vi.mock('@/lib/featureFlags', () => ({
  ENABLE_ACCOUNTS: true,
  ENABLE_SYNC: true,
  get ENABLE_SPACES() {
    return flags.spaces
  },
}))
vi.mock('@/lib/accountSession', () => ({
  useAccountsVisible: vi.fn(),
  useAccountSession: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children?: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))
vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))
vi.mock('@/lib/backup', () => ({ formatRestoreSummary: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/RestoreBackupDialog', () => ({ RestoreBackupDialog: () => null }))

const LANGS: Array<Lang> = ['en', 'uk']

beforeEach(() => {
  vi.resetAllMocks()
  flags.spaces = true
  setLang('en', { persist: false })
  vi.mocked(useAccountsVisible).mockReturnValue(true)
  setVaultPhase('none')
  cancelCreateVault()
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe.each(LANGS)('landing with ENABLE_SPACES on (%s)', (lang) => {
  beforeEach(() => setLang(lang, { persist: false }))

  it('shows the Family feature line', () => {
    render(<LandingPage />)

    expect(screen.getByTestId('landing-family-feature').textContent.trim()).toBe(
      translate(lang, 'landing.features.familyLine'),
    )
  })

  it('keeps the sync line too', () => {
    render(<LandingPage />)

    expect(screen.getByTestId('landing-sync-feature')).toBeTruthy()
  })
})

describe('the Family copy', () => {
  it('differs between the two languages and mentions the beta in en', () => {
    const en = translate('en', 'landing.features.familyLine')
    const uk = translate('uk', 'landing.features.familyLine')

    expect(en).not.toBe(uk)
    expect(en).toBe(
      'Family budget: track shared spending together, end-to-end encrypted, free during the beta',
    )
    expect(uk.length).toBeGreaterThan(10)
  })
})

describe('landing with ENABLE_SPACES off', () => {
  it('has no Family line anywhere on the page', () => {
    flags.spaces = false

    render(<LandingPage />)

    expect(screen.queryByTestId('landing-family-feature')).toBeNull()
    expect(document.body.textContent).not.toContain(translate('en', 'landing.features.familyLine'))
  })
})
