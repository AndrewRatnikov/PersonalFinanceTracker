// No CONTRACT_GAPs: the footer testid and the legal links are specified in the
// Interface Contract (component: LandingPage). The mocks copy
// LandingPage.test.tsx, with a Link mock that passes data-testid through.

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { setLang } from '@/i18n/core'
import { cancelCreateVault, setVaultPhase } from '@/lib/vaultSession'
import LandingPage from '@/components/LandingPage'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    className,
    ...rest
  }: {
    to: string
    children?: ReactNode
    className?: string
    'data-testid'?: string
  }) => (
    <a href={to} className={className} data-testid={rest['data-testid']}>
      {children}
    </a>
  ),
}))

vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))
vi.mock('@/lib/backup', () => ({ formatRestoreSummary: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('@/components/RestoreBackupDialog', () => ({
  RestoreBackupDialog: () => null,
}))

beforeEach(() => {
  setLang('en', { persist: false })
  setVaultPhase('none')
  cancelCreateVault()
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('LandingPage footer legal links (criterion 31)', () => {
  it('has a footer with links to /terms and /privacy', () => {
    render(<LandingPage />)

    const footer = screen.getByTestId('landing-footer')
    expect(footer.tagName).toBe('FOOTER')
    expect(within(footer).getByTestId('legal-terms-link').getAttribute('href')).toBe(
      '/terms',
    )
    expect(
      within(footer).getByTestId('legal-privacy-link').getAttribute('href'),
    ).toBe('/privacy')
  })

  it('shows the links once, inside the footer only', () => {
    render(<LandingPage />)

    expect(screen.getAllByTestId('legal-terms-link')).toHaveLength(1)
    expect(screen.getAllByTestId('legal-privacy-link')).toHaveLength(1)
    const footer = screen.getByTestId('landing-footer')
    expect(footer.contains(screen.getByTestId('legal-links'))).toBe(true)
  })

  it('keeps the footer copy unchanged', () => {
    render(<LandingPage />)

    expect(screen.getByTestId('landing-footer').textContent).toContain(
      'No account needed. No financial data is stored on any server.',
    )
  })

  it('labels the links in the interface language', () => {
    render(<LandingPage />)
    const en = screen.getByTestId('legal-terms-link').textContent
    cleanup()

    setLang('uk', { persist: false })
    render(<LandingPage />)
    const uk = screen.getByTestId('legal-terms-link').textContent

    expect(en).toMatch(/terms/i)
    expect(uk).not.toBe(en)
    expect(uk).toMatch(/[Ѐ-ӿ]/)
  })

  it('does not add a login link to the landing page', () => {
    const { container } = render(<LandingPage />)
    expect(container.querySelector('a[href="/login"]')).toBeNull()
  })
})
