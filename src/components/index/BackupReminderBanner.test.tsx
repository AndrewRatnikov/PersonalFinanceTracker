// No CONTRACT_GAPs: BackupReminderBanner selectors, dependencies and behaviour
// are fully specified in the Interface Contract (component: BackupReminderBanner).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { downloadBackup } from '@/lib/backup'
import {
  getBackupReminderStatus,
  snoozeBackupReminder,
} from '@/lib/backupReminder'
import { BackupReminderBanner } from '@/components/index/BackupReminderBanner'

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('@/lib/backupReminder', () => ({
  BACKUP_REMINDER_QUERY_KEY: ['backup-reminder'],
  getBackupReminderStatus: vi.fn(),
  snoozeBackupReminder: vi.fn(),
  backupReminderText: (days: number | null) =>
    days === null ? 'No backup yet.' : `Last backup: ${days} days ago.`,
}))
vi.mock('@/lib/backup', () => ({ downloadBackup: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
}))

function renderBanner() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <BackupReminderBanner />
    </QueryClientProvider>,
  )
  return { client, ...view }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getBackupReminderStatus).mockResolvedValue({
    show: true,
    daysSinceBackup: null,
  })
  vi.mocked(snoozeBackupReminder).mockResolvedValue(undefined)
  vi.mocked(downloadBackup).mockResolvedValue({
    status: 'saved',
    filename: 'minima-backup-2026-03-05.minima',
    skipped: [],
  })
})

afterEach(() => {
  cleanup()
})

describe('BackupReminderBanner visibility', () => {
  it('renders nothing when the status says not to show', async () => {
    vi.mocked(getBackupReminderStatus).mockResolvedValue({
      show: false,
      daysSinceBackup: 20,
    })
    renderBanner()

    await waitFor(() => {
      expect(getBackupReminderStatus).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('backup-reminder-banner')).toBeNull()
  })

  it('renders nothing before the status has loaded', () => {
    vi.mocked(getBackupReminderStatus).mockReturnValue(new Promise(() => {}))
    renderBanner()

    expect(screen.queryByTestId('backup-reminder-banner')).toBeNull()
  })

  it('shows "No backup yet." when there was never a backup', async () => {
    renderBanner()

    const banner = await screen.findByTestId('backup-reminder-banner')
    expect(banner).toBeTruthy()
    expect(screen.getByTestId('backup-reminder-text').textContent).toBe(
      'No backup yet.',
    )
    expect(screen.getByTestId('backup-reminder-now').textContent).toContain(
      'Back up now',
    )
    expect(screen.getByTestId('backup-reminder-later').textContent).toContain(
      'Later',
    )
  })

  it('shows the number of days since the last backup', async () => {
    vi.mocked(getBackupReminderStatus).mockResolvedValue({
      show: true,
      daysSinceBackup: 19,
    })
    renderBanner()

    const text = await screen.findByTestId('backup-reminder-text')
    expect(text.textContent).toBe('Last backup: 19 days ago.')
  })
})

describe('BackupReminderBanner Back up now', () => {
  it('downloads a backup', async () => {
    renderBanner()
    await screen.findByTestId('backup-reminder-banner')

    fireEvent.click(screen.getByTestId('backup-reminder-now'))

    await waitFor(() => {
      expect(downloadBackup).toHaveBeenCalledTimes(1)
    })
  })

  it('hides once the status refetch after a saved backup says not to show', async () => {
    vi.mocked(getBackupReminderStatus)
      .mockResolvedValueOnce({ show: true, daysSinceBackup: 20 })
      .mockResolvedValue({ show: false, daysSinceBackup: 0 })
    renderBanner()
    await screen.findByTestId('backup-reminder-banner')

    fireEvent.click(screen.getByTestId('backup-reminder-now'))

    await waitFor(() => {
      expect(screen.queryByTestId('backup-reminder-banner')).toBeNull()
    })
    expect(getBackupReminderStatus).toHaveBeenCalledTimes(2)
  })

  it('stays visible and does not refetch when the share sheet is cancelled', async () => {
    vi.mocked(downloadBackup).mockResolvedValue({
      status: 'cancelled',
      filename: 'x.minima',
      skipped: [],
    })
    renderBanner()
    await screen.findByTestId('backup-reminder-banner')

    fireEvent.click(screen.getByTestId('backup-reminder-now'))

    await waitFor(() => {
      expect(downloadBackup).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByTestId('backup-reminder-banner')).toBeTruthy()
    expect(getBackupReminderStatus).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('shows an error toast and stays visible when the backup fails', async () => {
    vi.mocked(downloadBackup).mockRejectedValue(new Error('no space left'))
    renderBanner()
    await screen.findByTestId('backup-reminder-banner')

    fireEvent.click(screen.getByTestId('backup-reminder-now'))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled()
    })
    expect(screen.getByTestId('backup-reminder-banner')).toBeTruthy()
    expect(getBackupReminderStatus).toHaveBeenCalledTimes(1)
  })
})

describe('BackupReminderBanner Later', () => {
  it('snoozes the reminder and removes the banner', async () => {
    renderBanner()
    await screen.findByTestId('backup-reminder-banner')

    fireEvent.click(screen.getByTestId('backup-reminder-later'))

    await waitFor(() => {
      expect(snoozeBackupReminder).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByTestId('backup-reminder-banner')).toBeNull()
    expect(downloadBackup).not.toHaveBeenCalled()
  })

  it('stays hidden even if a refetch still reports show: true', async () => {
    renderBanner()
    await screen.findByTestId('backup-reminder-banner')

    fireEvent.click(screen.getByTestId('backup-reminder-later'))

    await waitFor(() => {
      expect(getBackupReminderStatus).toHaveBeenCalledTimes(2)
    })
    expect(screen.queryByTestId('backup-reminder-banner')).toBeNull()
  })

  it('refetches the status after snoozing', async () => {
    renderBanner()
    await screen.findByTestId('backup-reminder-banner')

    fireEvent.click(screen.getByTestId('backup-reminder-later'))

    await waitFor(() => {
      expect(getBackupReminderStatus).toHaveBeenCalledTimes(2)
    })
    expect(
      vi.mocked(snoozeBackupReminder).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(getBackupReminderStatus).mock.invocationCallOrder[1],
    )
  })
})
