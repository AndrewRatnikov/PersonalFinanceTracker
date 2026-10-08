// No CONTRACT_GAPs: LandingPage selectors and behaviour are fully specified in
// the Interface Contract (component: LandingPage).

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import {
  cancelCreateVault,
  getVaultSession,
  setVaultPhase,
} from '@/lib/vaultSession'
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

beforeEach(() => {
  setVaultPhase('none')
  cancelCreateVault()
})

afterEach(() => {
  cleanup()
})

describe('LandingPage', () => {
  it('renders a Start tracking hero button', () => {
    render(<LandingPage />)

    expect(screen.getByTestId('landing-start-tracking').textContent).toContain(
      'Start tracking',
    )
  })

  it('opens the create-vault flow when Start tracking is clicked', () => {
    render(<LandingPage />)
    expect(getVaultSession().createRequested).toBe(false)

    fireEvent.click(screen.getByTestId('landing-start-tracking'))

    expect(getVaultSession().createRequested).toBe(true)
  })

  it('renders a disabled Restore from backup button', () => {
    render(<LandingPage />)

    const restore = screen.getByTestId<HTMLButtonElement>(
      'landing-restore-backup',
    )
    expect(restore.disabled).toBe(true)
    expect(restore.textContent).toContain('Restore from backup')
    expect(restore.title).toBe('Coming soon')
  })

  it('does not request creation when the disabled Restore button is clicked', () => {
    render(<LandingPage />)

    fireEvent.click(screen.getByTestId('landing-restore-backup'))

    expect(getVaultSession().createRequested).toBe(false)
  })

  it('has no link to /login', () => {
    const { container } = render(<LandingPage />)

    expect(container.querySelector('a[href="/login"]')).toBeNull()
  })

  it('no longer asks for a Google sign-in', () => {
    const { container } = render(<LandingPage />)

    expect(container.textContent).not.toContain('Continue with Google')
    expect(container.textContent).not.toContain('One Google sign-in')
  })
})
