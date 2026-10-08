// No CONTRACT_GAPs: LandingPage selectors and behaviour are fully specified in
// the Interface Contract (component: LandingPage). RestoreBackupDialog is
// replaced by a fake that renders fake-restore-backup-dialog when open and
// exposes plain buttons (found by text, no testid) that call onRestored and
// onOpenChange.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { RestoreSummary } from '@/lib/backup'
import { formatRestoreSummary } from '@/lib/backup'
import {
  cancelCreateVault,
  getVaultSession,
  setVaultPhase,
} from '@/lib/vaultSession'
import LandingPage from '@/components/LandingPage'

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }))

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
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: vi.fn() },
}))

const SUMMARY: RestoreSummary = {
  mode: 'replace',
  expenses: 4,
  income: 1,
  categories: 2,
  budgets: 1,
  added: 8,
  updated: 0,
  conflicts: 0,
  skipped: [],
  adoptedVault: true,
}

vi.mock('@/components/RestoreBackupDialog', () => ({
  RestoreBackupDialog: ({
    open,
    freshDevice,
    onOpenChange,
    onRestored,
  }: {
    open: boolean
    freshDevice?: boolean
    onOpenChange: (open: boolean) => void
    onRestored?: (summary: RestoreSummary) => void
  }) =>
    open ? (
      <div
        data-testid="fake-restore-backup-dialog"
        data-fresh={String(Boolean(freshDevice))}
      >
        <button type="button" onClick={() => onRestored?.(SUMMARY)}>
          fake-restored
        </button>
        <button type="button" onClick={() => onOpenChange(false)}>
          fake-close
        </button>
      </div>
    ) : null,
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(formatRestoreSummary).mockImplementation(
    (s) => `${s.expenses} expenses restored`,
  )
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

  it('renders an enabled Restore from backup button', () => {
    render(<LandingPage />)

    const restore = screen.getByTestId<HTMLButtonElement>(
      'landing-restore-backup',
    )
    expect(restore.disabled).toBe(false)
    expect(restore.textContent).toContain('Restore from backup')
    expect(restore.title).toBe('')
  })

  it('does not show the restore dialog until the button is clicked', () => {
    render(<LandingPage />)

    expect(screen.queryByTestId('fake-restore-backup-dialog')).toBeNull()
  })

  it('opens the restore dialog for a fresh device when Restore is clicked', () => {
    render(<LandingPage />)

    fireEvent.click(screen.getByTestId('landing-restore-backup'))

    const dialog = screen.getByTestId('fake-restore-backup-dialog')
    expect(dialog.getAttribute('data-fresh')).toBe('true')
  })

  it('does not request vault creation when Restore is clicked', () => {
    render(<LandingPage />)

    fireEvent.click(screen.getByTestId('landing-restore-backup'))

    expect(getVaultSession().createRequested).toBe(false)
  })

  it('Start tracking does not open the restore dialog', () => {
    render(<LandingPage />)

    fireEvent.click(screen.getByTestId('landing-start-tracking'))

    expect(screen.queryByTestId('fake-restore-backup-dialog')).toBeNull()
  })

  it('closes the restore dialog through onOpenChange(false)', () => {
    render(<LandingPage />)
    fireEvent.click(screen.getByTestId('landing-restore-backup'))

    fireEvent.click(screen.getByText('fake-close'))

    expect(screen.queryByTestId('fake-restore-backup-dialog')).toBeNull()
  })

  it('unlocks the app and toasts the summary after a successful restore', () => {
    render(<LandingPage />)
    expect(getVaultSession().phase).toBe('none')
    fireEvent.click(screen.getByTestId('landing-restore-backup'))

    fireEvent.click(screen.getByText('fake-restored'))

    expect(getVaultSession().phase).toBe('unlocked')
    expect(formatRestoreSummary).toHaveBeenCalledWith(SUMMARY)
    expect(toastSuccess).toHaveBeenCalledWith('4 expenses restored')
  })

  it('does not unlock the app when nothing was restored', () => {
    render(<LandingPage />)

    fireEvent.click(screen.getByTestId('landing-restore-backup'))
    fireEvent.click(screen.getByText('fake-close'))

    expect(getVaultSession().phase).toBe('none')
    expect(toastSuccess).not.toHaveBeenCalled()
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
