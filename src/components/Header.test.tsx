// No CONTRACT_GAPs: Header selectors, phases and mocks are fully specified in
// the Interface Contract (component: Header).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { useAccountsVisible } from '@/lib/accountSession'
import { lockVault } from '@/lib/vault'
import {
  cancelCreateVault,
  getVaultSession,
  setVaultPhase,
} from '@/lib/vaultSession'
import Header from '@/components/Header'

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

vi.mock('@/lib/accountSession', () => ({ useAccountsVisible: vi.fn() }))
vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))

let client = new QueryClient()

function renderHeader() {
  return render(
    <QueryClientProvider client={client}>
      <Header />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  client = new QueryClient()
  vi.mocked(useAccountsVisible).mockReturnValue(false)
  setVaultPhase('checking')
  cancelCreateVault()
})

afterEach(() => {
  cleanup()
})

describe('Header when unlocked', () => {
  beforeEach(() => {
    setVaultPhase('unlocked')
  })

  it('shows the menu button and the lock button, not the marketing CTAs', () => {
    renderHeader()

    expect(screen.getByTestId('header-menu-btn')).toBeTruthy()
    expect(screen.getByTestId('header-lock-btn')).toBeTruthy()
    expect(screen.queryByTestId('header-start-tracking')).toBeNull()
    expect(screen.queryByTestId('header-sign-in')).toBeNull()
  })

  it('has no Profile link in the sheet when accounts are hidden', () => {
    renderHeader()

    fireEvent.click(screen.getByTestId('header-menu-btn'))

    expect(screen.getByText('Settings')).toBeTruthy()
    expect(screen.queryByTestId('nav-link-profile')).toBeNull()
    expect(screen.queryByText('Profile')).toBeNull()
  })

  it('shows the Profile link in the sheet when accounts are visible', () => {
    vi.mocked(useAccountsVisible).mockReturnValue(true)
    renderHeader()

    fireEvent.click(screen.getByTestId('header-menu-btn'))

    const profile = screen.getByTestId('nav-link-profile')
    expect(profile.getAttribute('href')).toBe('/profile')
  })

  it('locks the app from the lock button: key cleared, cache emptied, phase locked', () => {
    client.setQueryData(['income'], [{ id: 'i1' }])
    renderHeader()

    fireEvent.click(screen.getByTestId('header-lock-btn'))

    expect(lockVault).toHaveBeenCalledTimes(1)
    expect(client.getQueryData(['income'])).toBeUndefined()
    expect(getVaultSession().phase).toBe('locked')
  })
})

describe.each(['checking', 'none', 'locked'] as const)(
  'Header marketing mode (phase %s)',
  (phase) => {
    beforeEach(() => {
      setVaultPhase(phase)
    })

    it('shows Start tracking and no lock or menu-nav controls', () => {
      renderHeader()

      expect(screen.getByTestId('header-start-tracking').textContent).toContain(
        'Start tracking',
      )
      expect(screen.queryByTestId('header-lock-btn')).toBeNull()
      expect(screen.queryByTestId('header-menu-btn')).toBeNull()
    })

    it('hides Sign in and every /login link when accounts are hidden', () => {
      const { container } = renderHeader()

      expect(screen.queryByTestId('header-sign-in')).toBeNull()
      expect(container.querySelector('a[href="/login"]')).toBeNull()
    })

    it('shows the Sign in link to /login when accounts are visible', () => {
      vi.mocked(useAccountsVisible).mockReturnValue(true)
      renderHeader()

      expect(screen.getByTestId('header-sign-in').getAttribute('href')).toBe(
        '/login',
      )
    })
  },
)

describe('Header Start tracking button', () => {
  it('requests the create-vault flow', () => {
    setVaultPhase('none')
    renderHeader()
    expect(getVaultSession().createRequested).toBe(false)

    fireEvent.click(screen.getByTestId('header-start-tracking'))

    expect(getVaultSession().createRequested).toBe(true)
  })

  it('is not a link to /login', () => {
    setVaultPhase('none')
    renderHeader()

    expect(screen.getByTestId('header-start-tracking').closest('a')).toBeNull()
  })
})
