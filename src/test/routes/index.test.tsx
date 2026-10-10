// No CONTRACT_GAPs: the index route's phase-driven rendering is fully
// specified in the Interface Contract (route: index). InstallHintCard is
// replaced by a fake (fake-install-hint), BackupReminderBanner by a fake
// (fake-backup-reminder), RecoveryKeyBanner by a fake (fake-recovery-key-banner)
// and Link by a plain anchor.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'

import {
  getAllBudgets,
  getAllCategories,
  getAllIncome,
  getExpensesForRange,
} from '@/lib/localDb'
import { cancelCreateVault, setVaultPhase } from '@/lib/vaultSession'
import { Route } from '@/routes/index'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactRouter>()
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
vi.mock('@/lib/backup', () => ({ formatRestoreSummary: vi.fn() }))
vi.mock('@/components/InstallHintCard', () => ({
  InstallHintCard: () => <div data-testid="fake-install-hint" />,
}))
vi.mock('@/components/index/BackupReminderBanner', () => ({
  BackupReminderBanner: () => <div data-testid="fake-backup-reminder" />,
}))
vi.mock('@/components/index/RecoveryKeyBanner', () => ({
  RecoveryKeyBanner: () => <div data-testid="fake-recovery-key-banner" />,
}))
vi.mock('@/components/RestoreBackupDialog', () => ({
  RestoreBackupDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="fake-restore-backup-dialog" /> : null,
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
      expect(screen.queryByTestId('fake-backup-reminder')).toBeNull()
      expect(screen.queryByTestId('fake-recovery-key-banner')).toBeNull()
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

  it('renders the backup reminder banner on the unlocked dashboard', async () => {
    setVaultPhase('unlocked')
    renderIndex()

    await screen.findByTestId('dashboard-summary')
    expect(screen.getAllByTestId('fake-backup-reminder')).toHaveLength(1)
  })

  it('renders the recovery key banner once on the unlocked dashboard', async () => {
    setVaultPhase('unlocked')
    renderIndex()

    await screen.findByTestId('dashboard-summary')
    expect(screen.getAllByTestId('fake-recovery-key-banner')).toHaveLength(1)
  })

  it('puts the recovery key banner directly above the backup reminder', async () => {
    setVaultPhase('unlocked')
    renderIndex()

    await screen.findByTestId('dashboard-summary')
    const recovery = screen.getByTestId('fake-recovery-key-banner')
    const backup = screen.getByTestId('fake-backup-reminder')
    expect(
      recovery.compareDocumentPosition(backup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(recovery.nextElementSibling).toBe(backup)
  })

  it('puts the banners after the install hint and above the summary', async () => {
    setVaultPhase('unlocked')
    renderIndex()

    const summary = await screen.findByTestId('dashboard-summary')
    const hint = screen.getByTestId('fake-install-hint')
    const recovery = screen.getByTestId('fake-recovery-key-banner')
    const banner = screen.getByTestId('fake-backup-reminder')
    expect(
      hint.compareDocumentPosition(recovery) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      hint.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      banner.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})
