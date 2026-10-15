// No CONTRACT_GAPs: data-testid="landing-exchange-rates-note" and its sentence
// are fully specified in the Interface Contract (other selectors) and plan
// section 13. Mocks follow LandingPage.test.tsx.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { cancelCreateVault, setVaultPhase } from '@/lib/vaultSession'
import LandingPage from '@/components/LandingPage'

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

beforeEach(() => {
  setVaultPhase('none')
  cancelCreateVault()
})

afterEach(() => {
  cleanup()
})

describe('LandingPage exchange-rates privacy sentence', () => {
  it('says rates come from the National Bank of Ukraine and only dates are sent', () => {
    render(<LandingPage />)

    expect(screen.getByTestId('landing-exchange-rates-note').textContent.trim()).toBe(
      'Exchange rates come from the National Bank of Ukraine; only dates are sent, never amounts.',
    )
  })

  it('sits in the privacy section', () => {
    render(<LandingPage />)

    const note = screen.getByTestId('landing-exchange-rates-note')
    expect(note.closest('#privacy')).not.toBeNull()
  })

  it('appears exactly once', () => {
    render(<LandingPage />)

    expect(screen.getAllByTestId('landing-exchange-rates-note')).toHaveLength(1)
  })
})
