// No CONTRACT_GAPs: nav-link-recurring, the /recurring target, the "Recurring"
// label and its position between Income and Settings are specified in the
// Interface Contract (component changes: Header). The sheet is opened with
// header-menu-btn.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { useAccountsVisible } from '@/lib/accountSession'
import { cancelCreateVault, setVaultPhase } from '@/lib/vaultSession'
import Header from '@/components/Header'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string
    children?: ReactNode
    [key: string]: unknown
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}))

vi.mock('@/lib/accountSession', () => ({ useAccountsVisible: vi.fn() }))
vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))

function renderHeader() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Header />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(useAccountsVisible).mockReturnValue(false)
  setVaultPhase('checking')
  cancelCreateVault()
})

afterEach(() => {
  cleanup()
})

describe('Header Recurring link when unlocked', () => {
  beforeEach(() => {
    setVaultPhase('unlocked')
  })

  it('shows a Recurring link to /recurring in the menu', () => {
    renderHeader()

    fireEvent.click(screen.getByTestId('header-menu-btn'))

    const link = screen.getByTestId('nav-link-recurring')
    expect(link.getAttribute('href')).toBe('/recurring')
    expect(link.textContent).toContain('Recurring')
  })

  it('shows the Repeat icon in the link', () => {
    renderHeader()

    fireEvent.click(screen.getByTestId('header-menu-btn'))

    expect(screen.getByTestId('nav-link-recurring').querySelector('svg')).not.toBeNull()
  })

  it('sits between Income and Settings', () => {
    renderHeader()

    fireEvent.click(screen.getByTestId('header-menu-btn'))

    const hrefs = screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'))
    const income = hrefs.indexOf('/income')
    const recurring = hrefs.indexOf('/recurring')
    const settings = hrefs.indexOf('/settings')
    expect(income).toBeGreaterThanOrEqual(0)
    expect(recurring).toBeGreaterThan(income)
    expect(settings).toBeGreaterThan(recurring)
  })

  it('is not in the DOM before the menu is opened', () => {
    renderHeader()

    expect(screen.queryByTestId('nav-link-recurring')).toBeNull()
  })
})

describe.each(['checking', 'none', 'locked'] as const)(
  'Header Recurring link (phase %s)',
  (phase) => {
    it('is not offered', () => {
      setVaultPhase(phase)
      renderHeader()

      expect(screen.queryByTestId('nav-link-recurring')).toBeNull()
      expect(screen.queryByTestId('header-menu-btn')).toBeNull()
    })
  },
)
