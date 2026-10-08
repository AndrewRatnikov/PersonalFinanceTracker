// No CONTRACT_GAPs: the index route's phase-driven rendering is fully
// specified in the Interface Contract (route: index). InstallHintCard is
// replaced by a fake (fake-install-hint) and Link by a plain anchor.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import {
  getAllBudgets,
  getAllCategories,
  getAllIncome,
  getExpensesForRange,
} from '@/lib/localDb'
import { cancelCreateVault, setVaultPhase } from '@/lib/vaultSession'
import { Route } from '@/routes/index'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ to, children }: { to: string; children?: ReactNode }) => (
      <a href={to}>{children}</a>
    ),
  }
})

vi.mock('@/lib/localDb', () => ({
  getAllCategories: vi.fn(),
  getExpensesForRange: vi.fn(),
  getAllIncome: vi.fn(),
  getAllBudgets: vi.fn(),
  addExpense: vi.fn(),
}))
vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))
vi.mock('@/components/InstallHintCard', () => ({
  InstallHintCard: () => <div data-testid="fake-install-hint" />,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function renderIndex() {
  const Page = Route.options.component as React.ComponentType | undefined
  if (!Page) throw new Error('route has no component')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getAllCategories).mockResolvedValue([])
  vi.mocked(getExpensesForRange).mockResolvedValue([])
  vi.mocked(getAllIncome).mockResolvedValue([])
  vi.mocked(getAllBudgets).mockResolvedValue([])
  cancelCreateVault()
})

afterEach(() => {
  cleanup()
  act(() => {
    setVaultPhase('checking')
  })
})

describe('index route', () => {
  it('renders the dashboard, with the install hint, when unlocked', async () => {
    setVaultPhase('unlocked')
    renderIndex()

    await screen.findByTestId('dashboard-summary')
    expect(screen.getByTestId('fake-install-hint')).toBeTruthy()
    expect(screen.queryByTestId('landing-start-tracking')).toBeNull()
  })

  it.each(['none', 'locked', 'checking'] as const)(
    'renders the landing page when the phase is %s',
    (phase) => {
      setVaultPhase(phase)
      renderIndex()

      expect(screen.getByTestId('landing-start-tracking')).toBeTruthy()
      expect(screen.queryByTestId('dashboard-summary')).toBeNull()
      expect(screen.queryByTestId('fake-install-hint')).toBeNull()
      expect(getAllCategories).not.toHaveBeenCalled()
    },
  )

  it('switches from the landing page to the dashboard when the vault unlocks', async () => {
    setVaultPhase('locked')
    renderIndex()
    expect(screen.getByTestId('landing-start-tracking')).toBeTruthy()

    act(() => {
      setVaultPhase('unlocked')
    })

    await screen.findByTestId('dashboard-summary')
    expect(screen.queryByTestId('landing-start-tracking')).toBeNull()
  })
})
