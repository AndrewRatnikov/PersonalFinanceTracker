// No CONTRACT_GAPs: DataToolsTab selectors are fully specified in the
// Interface Contract (component: DataToolsTab). StorageStatusCard,
// RemoveDataDialog and RestoreBackupDialog are replaced by fakes
// (fake-storage-status, fake-remove-data-dialog, fake-restore-backup-dialog).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackupSettings } from '@/lib/backupReminder'
import type { ImportResult } from '@/lib/localImport'
import { downloadBackup } from '@/lib/backup'
import {
  getBackupSettings,
  updateBackupSettings,
} from '@/lib/backupReminder'
import { exportAllLocalData } from '@/lib/localExport'
import { importLocalDataFile } from '@/lib/localImport'
import { DataToolsTab } from '@/components/settings/DataToolsTab'

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('@/lib/backup', () => ({ downloadBackup: vi.fn() }))
vi.mock('@/lib/backupReminder', () => ({
  BACKUP_REMINDER_QUERY_KEY: ['backup-reminder'],
  BACKUP_SETTINGS_QUERY_KEY: ['backup-settings'],
  BACKUP_REMINDER_OPTIONS: [7, 14, 30, 0],
  DEFAULT_BACKUP_REMINDER_DAYS: 14,
  getBackupSettings: vi.fn(),
  updateBackupSettings: vi.fn(),
}))
vi.mock('@/lib/localExport', () => ({ exportAllLocalData: vi.fn() }))
vi.mock('@/lib/localImport', () => ({ importLocalDataFile: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
}))
vi.mock('@/components/settings/StorageStatusCard', () => ({
  StorageStatusCard: () => <div data-testid="fake-storage-status" />,
}))
vi.mock('@/components/RemoveDataDialog', () => ({
  RemoveDataDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="fake-remove-data-dialog" /> : null,
}))
vi.mock('@/components/RestoreBackupDialog', () => ({
  RestoreBackupDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="fake-restore-backup-dialog" /> : null,
}))

const SETTINGS: BackupSettings = {
  backupReminderDays: 14,
  lastBackupAt: null,
  lastDataChangeAt: null,
  backupReminderSnoozedUntil: null,
}

function importResult(patch: Partial<ImportResult> = {}): ImportResult {
  return {
    inserted: 0,
    skipped: 0,
    errors: [],
    duplicates: 0,
    duplicateRows: [],
    ...patch,
  }
}

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const view = render(
    <QueryClientProvider client={client}>
      <DataToolsTab />
    </QueryClientProvider>,
  )
  return { client, invalidate, ...view }
}

function invalidatedKeys(invalidate: { mock: { calls: Array<Array<unknown>> } }) {
  return invalidate.mock.calls.map((call) => {
    const filters = call[0] as { queryKey?: ReadonlyArray<unknown> } | undefined
    return filters?.queryKey ? JSON.stringify(filters.queryKey) : 'all'
  })
}

function chooseCsvFiles(files: Array<File>) {
  fireEvent.change(screen.getByTestId('csv-import-input'), {
    target: { files },
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getBackupSettings).mockResolvedValue(SETTINGS)
  vi.mocked(updateBackupSettings).mockResolvedValue(undefined)
  vi.mocked(downloadBackup).mockResolvedValue({
    status: 'saved',
    filename: 'minima-backup-2026-03-05.minima',
    skipped: [],
  })
  vi.mocked(exportAllLocalData).mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe('DataToolsTab', () => {
  it('renders the storage status card', () => {
    renderTab()

    expect(screen.getByTestId('fake-storage-status')).toBeTruthy()
  })

  it('has a Danger zone with a Remove data from this device button', () => {
    renderTab()

    const zone = screen.getByTestId('danger-zone-card')
    expect(zone.textContent).toContain('Remove all data from this device')
    expect(screen.getByTestId('remove-data-btn').textContent).toContain(
      'Remove data from this device',
    )
  })

  it('opens the remove-data dialog from the button', () => {
    renderTab()
    expect(screen.queryByTestId('fake-remove-data-dialog')).toBeNull()

    fireEvent.click(screen.getByTestId('remove-data-btn'))

    expect(screen.getByTestId('fake-remove-data-dialog')).toBeTruthy()
  })

  it('no longer offers Delete account', () => {
    renderTab()

    expect(screen.queryByTestId('delete-account-btn')).toBeNull()
    expect(screen.queryByTestId('delete-account-dialog')).toBeNull()
    expect(screen.getByTestId('danger-zone-card').textContent).not.toContain(
      'account',
    )
  })

  it('puts the storage status before the Danger zone', () => {
    renderTab()

    const storage = screen.getByTestId('fake-storage-status')
    const zone = screen.getByTestId('danger-zone-card')
    expect(
      storage.compareDocumentPosition(zone) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('orders the cards: backup, CSV export, CSV import, storage status, danger zone', () => {
    renderTab()

    const order = [
      screen.getByTestId('data-backup-card'),
      screen.getByTestId('csv-export-btn'),
      screen.getByTestId('csv-import-input'),
      screen.getByTestId('fake-storage-status'),
      screen.getByTestId('danger-zone-card'),
    ]
    for (let i = 0; i < order.length - 1; i++) {
      expect(
        order[i].compareDocumentPosition(order[i + 1]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
  })
})

describe('DataToolsTab backup card', () => {
  it('describes the .minima backup and has download and restore buttons', () => {
    renderTab()

    const card = screen.getByTestId('data-backup-card')
    expect(card.textContent).toContain('Backup (.minima)')
    expect(card.textContent).toContain(
      'Encrypted, lossless backup of all your data. Restore it here or on another device.',
    )
    expect(screen.getByTestId('backup-download-btn').textContent).toContain(
      'Download backup (.minima)',
    )
    expect(screen.getByTestId('backup-restore-btn').textContent).toContain(
      'Restore backup',
    )
  })

  it('Download backup saves, confirms with a toast and refreshes the reminder queries', async () => {
    const { invalidate } = renderTab()

    fireEvent.click(screen.getByTestId('backup-download-btn'))

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('Backup saved')
    })
    expect(downloadBackup).toHaveBeenCalledTimes(1)
    const keys = invalidatedKeys(invalidate)
    expect(keys).toContain(JSON.stringify(['backup-reminder']))
    expect(keys).toContain(JSON.stringify(['backup-settings']))
  })

  it('a cancelled share sheet shows no success toast and refreshes nothing', async () => {
    vi.mocked(downloadBackup).mockResolvedValue({
      status: 'cancelled',
      filename: 'x.minima',
      skipped: [],
    })
    const { invalidate } = renderTab()

    fireEvent.click(screen.getByTestId('backup-download-btn'))

    await waitFor(() => {
      expect(downloadBackup).toHaveBeenCalledTimes(1)
    })
    await Promise.resolve()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
    expect(invalidatedKeys(invalidate)).not.toContain(
      JSON.stringify(['backup-reminder']),
    )
  })

  it('a failed backup shows an error toast', async () => {
    vi.mocked(downloadBackup).mockRejectedValue(new Error('disk full'))
    renderTab()

    fireEvent.click(screen.getByTestId('backup-download-btn'))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled()
    })
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('Restore backup opens the restore dialog', () => {
    renderTab()
    expect(screen.queryByTestId('fake-restore-backup-dialog')).toBeNull()

    fireEvent.click(screen.getByTestId('backup-restore-btn'))

    expect(screen.getByTestId('fake-restore-backup-dialog')).toBeTruthy()
  })
})

describe('DataToolsTab backup reminder frequency', () => {
  it('offers 7 / 14 / 30 days and Off', () => {
    renderTab()

    const select = screen.getByTestId<HTMLSelectElement>(
      'backup-reminder-select',
    )
    expect(
      Array.from(select.options).map((o) => [o.value, o.textContent]),
    ).toEqual([
      ['7', 'Every 7 days'],
      ['14', 'Every 14 days'],
      ['30', 'Every 30 days'],
      ['0', 'Off'],
    ])
    expect(screen.getByTestId('data-backup-card').textContent).toContain(
      'Backup reminder',
    )
  })

  it('shows 14 days by default', async () => {
    renderTab()

    await waitFor(() => {
      expect(getBackupSettings).toHaveBeenCalled()
    })
    expect(
      screen.getByTestId<HTMLSelectElement>('backup-reminder-select').value,
    ).toBe('14')
  })

  it('shows the stored frequency', async () => {
    vi.mocked(getBackupSettings).mockResolvedValue({
      ...SETTINGS,
      backupReminderDays: 30,
    })
    renderTab()

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLSelectElement>('backup-reminder-select').value,
      ).toBe('30')
    })
  })

  it('shows Off for a stored 0', async () => {
    vi.mocked(getBackupSettings).mockResolvedValue({
      ...SETTINGS,
      backupReminderDays: 0,
    })
    renderTab()

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLSelectElement>('backup-reminder-select').value,
      ).toBe('0')
    })
  })

  it('saves the chosen frequency as a number and refreshes both backup queries', async () => {
    const { invalidate } = renderTab()
    await waitFor(() => {
      expect(getBackupSettings).toHaveBeenCalled()
    })

    fireEvent.change(screen.getByTestId('backup-reminder-select'), {
      target: { value: '7' },
    })

    await waitFor(() => {
      expect(updateBackupSettings).toHaveBeenCalledWith({
        backupReminderDays: 7,
      })
    })
    await waitFor(() => {
      const keys = invalidatedKeys(invalidate)
      expect(keys).toContain(JSON.stringify(['backup-reminder']))
      expect(keys).toContain(JSON.stringify(['backup-settings']))
    })
  })

  it('saves Off as 0', async () => {
    renderTab()
    await waitFor(() => {
      expect(getBackupSettings).toHaveBeenCalled()
    })

    fireEvent.change(screen.getByTestId('backup-reminder-select'), {
      target: { value: '0' },
    })

    await waitFor(() => {
      expect(updateBackupSettings).toHaveBeenCalledWith({
        backupReminderDays: 0,
      })
    })
  })
})

describe('DataToolsTab CSV export', () => {
  it('is a zip export labelled as spreadsheet-only', () => {
    renderTab()

    expect(screen.getByTestId('csv-export-label').textContent).toBe(
      'Readable by spreadsheets · not encrypted · not a full backup',
    )
    expect(screen.getByTestId('csv-export-btn').id).toBe('export-csv-btn')
    expect(document.body.textContent).toContain('Export CSV (.zip)')
  })

  it('runs the zip export when clicked', async () => {
    renderTab()

    fireEvent.click(screen.getByTestId('csv-export-btn'))

    await waitFor(() => {
      expect(exportAllLocalData).toHaveBeenCalledTimes(1)
    })
  })
})

describe('DataToolsTab CSV import', () => {
  it('keeps the file input id', () => {
    renderTab()

    expect(screen.getByTestId('csv-import-input').id).toBe('import-csv-input')
  })

  it('shows inserted and skipped counts per file, and no duplicate notice without duplicates', async () => {
    vi.mocked(importLocalDataFile).mockResolvedValue({
      type: 'expenses',
      result: importResult({ inserted: 4, skipped: 2, errors: ['Row 3: bad'] }),
    })
    renderTab()

    chooseCsvFiles([new File(['x'], 'expenses.csv')])

    const results = await screen.findByTestId('import-results')
    expect(results.textContent).toContain('expenses.csv')
    expect(results.textContent).toContain('4 inserted')
    expect(results.textContent).toContain(', 2 skipped')
    expect(results.textContent).toContain('Row 3: bad')
    expect(results.textContent).not.toContain('duplicates')
    expect(screen.queryByTestId('import-duplicates-notice')).toBeNull()
    expect(screen.queryByTestId('import-anyway-btn')).toBeNull()
  })

  it('imports categories before the other files', async () => {
    vi.mocked(importLocalDataFile).mockResolvedValue({
      type: 'x',
      result: importResult({ inserted: 1 }),
    })
    renderTab()

    chooseCsvFiles([
      new File(['x'], 'expenses.csv'),
      new File(['x'], 'categories.csv'),
    ])

    await screen.findByTestId('import-results')
    const order = vi
      .mocked(importLocalDataFile)
      .mock.calls.map((c) => c[0].name)
    expect(order).toEqual(['categories.csv', 'expenses.csv'])
  })

  it('reports the duplicate count in the results and a plural notice', async () => {
    vi.mocked(importLocalDataFile).mockResolvedValue({
      type: 'expenses',
      result: importResult({
        inserted: 2,
        duplicates: 3,
        duplicateRows: [2, 3, 4],
      }),
    })
    renderTab()

    chooseCsvFiles([new File(['x'], 'expenses.csv')])

    const results = await screen.findByTestId('import-results')
    expect(results.textContent).toContain('2 inserted')
    expect(results.textContent).toContain(', 3 duplicates')
    expect(screen.getByTestId('import-duplicates-notice').textContent).toBe(
      '3 rows looked like duplicates and were skipped.',
    )
    expect(screen.getByTestId('import-anyway-btn').textContent).toContain(
      'Import them anyway',
    )
  })

  it('uses the singular form for one duplicate', async () => {
    vi.mocked(importLocalDataFile).mockResolvedValue({
      type: 'expenses',
      result: importResult({ duplicates: 1, duplicateRows: [2] }),
    })
    renderTab()

    chooseCsvFiles([new File(['x'], 'expenses.csv')])

    const notice = await screen.findByTestId('import-duplicates-notice')
    expect(notice.textContent).toBe('1 row looked like a duplicate and was skipped.')
  })

  it('sums the duplicates over all files', async () => {
    vi.mocked(importLocalDataFile).mockImplementation((file) =>
      Promise.resolve(
        file.name === 'expenses.csv'
          ? {
              type: 'expenses',
              result: importResult({ duplicates: 2, duplicateRows: [2, 3] }),
            }
          : {
              type: 'income',
              result: importResult({ duplicates: 1, duplicateRows: [5] }),
            },
      ),
    )
    renderTab()

    chooseCsvFiles([
      new File(['x'], 'expenses.csv'),
      new File(['x'], 'income.csv'),
    ])

    const notice = await screen.findByTestId('import-duplicates-notice')
    expect(notice.textContent).toBe(
      '3 rows looked like duplicates and were skipped.',
    )
  })

  it('Import them anyway re-imports the duplicate rows, replaces the results and hides the notice', async () => {
    const expenses = new File(['x'], 'expenses.csv')
    vi.mocked(importLocalDataFile)
      .mockResolvedValueOnce({
        type: 'expenses',
        result: importResult({
          inserted: 1,
          duplicates: 2,
          duplicateRows: [2, 4],
        }),
      })
      .mockResolvedValueOnce({
        type: 'expenses',
        result: importResult({ inserted: 2 }),
      })
    const { invalidate } = renderTab()
    chooseCsvFiles([expenses])
    await screen.findByTestId('import-duplicates-notice')
    invalidate.mockClear()

    fireEvent.click(screen.getByTestId('import-anyway-btn'))

    await waitFor(() => {
      expect(screen.queryByTestId('import-duplicates-notice')).toBeNull()
    })
    expect(importLocalDataFile).toHaveBeenCalledTimes(2)
    expect(importLocalDataFile).toHaveBeenLastCalledWith(expenses, {
      allowDuplicates: true,
      rows: [2, 4],
    })
    const results = screen.getByTestId('import-results')
    expect(results.textContent).toContain('2 inserted')
    expect(results.textContent).not.toContain('1 inserted')
    expect(screen.queryByTestId('import-anyway-btn')).toBeNull()
    expect(invalidatedKeys(invalidate)).toContain('all')
  })

  it('Import them anyway only touches the files that had duplicates', async () => {
    const expenses = new File(['x'], 'expenses.csv')
    const income = new File(['x'], 'income.csv')
    vi.mocked(importLocalDataFile).mockImplementation((file, options) => {
      if (options?.allowDuplicates) {
        return Promise.resolve({
          type: 'income',
          result: importResult({ inserted: 1 }),
        })
      }
      return Promise.resolve(
        file === expenses
          ? { type: 'expenses', result: importResult({ inserted: 5 }) }
          : {
              type: 'income',
              result: importResult({ duplicates: 1, duplicateRows: [3] }),
            },
      )
    })
    renderTab()
    chooseCsvFiles([expenses, income])
    await screen.findByTestId('import-duplicates-notice')

    fireEvent.click(screen.getByTestId('import-anyway-btn'))

    await waitFor(() => {
      expect(screen.queryByTestId('import-duplicates-notice')).toBeNull()
    })
    const anywayCalls = vi
      .mocked(importLocalDataFile)
      .mock.calls.filter((c) => c[1]?.allowDuplicates)
    expect(anywayCalls).toHaveLength(1)
    expect(anywayCalls[0][0]).toBe(income)
    expect(anywayCalls[0][1]).toEqual({ allowDuplicates: true, rows: [3] })
    expect(screen.getByTestId('import-results').textContent).toContain(
      '5 inserted',
    )
  })
})
