// No CONTRACT_GAPs: DataProblemScreen props and testids are fully specified in
// the Interface Contract. The real RestoreBackupDialog is rendered with
// @/lib/backup mocked. The library-level "unreadable blob ends up in
// quarantine unchanged" check lives in src/lib/backup.test.ts.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RestoreSummary } from '@/lib/backup'
import {
  defaultRestoreMode,
  formatRestoreSummary,
  restoreBackup,
} from '@/lib/backup'
import { DataProblemScreen } from '@/components/DataProblemScreen'

vi.mock('@/lib/backup', () => ({
  restoreBackup: vi.fn(),
  defaultRestoreMode: vi.fn(),
  formatRestoreSummary: vi.fn(),
}))

function summary(patch: Partial<RestoreSummary> = {}): RestoreSummary {
  return {
    mode: 'replace',
    expenses: 3,
    income: 1,
    categories: 2,
    budgets: 1,
    added: 5,
    updated: 0,
    conflicts: 0,
    skipped: [],
    adoptedVault: false,
    ...patch,
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function renderScreen(
  props: Partial<React.ComponentProps<typeof DataProblemScreen>> = {},
) {
  const onRetry = vi.fn()
  const onQuarantine = vi.fn(() => Promise.resolve())
  const onRestored = vi.fn()
  render(
    <DataProblemScreen
      storageKey="expenses_2026_03"
      onRetry={onRetry}
      onQuarantine={onQuarantine}
      onRestored={onRestored}
      {...props}
    />,
  )
  return { onRetry, onQuarantine, onRestored }
}

function chooseFile(name = 'b.minima') {
  const file = new File(['{}'], name)
  fireEvent.change(screen.getByTestId('restore-backup-file-input'), {
    target: { files: [file] },
  })
  return file
}

function typeSecret(value: string) {
  fireEvent.change(screen.getByTestId('restore-backup-secret-input'), {
    target: { value },
  })
}

function submitRestore() {
  fireEvent.click(screen.getByTestId('restore-backup-submit'))
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(defaultRestoreMode).mockResolvedValue('merge')
  vi.mocked(restoreBackup).mockResolvedValue(summary())
  vi.mocked(formatRestoreSummary).mockImplementation(
    (s) => `${s.expenses} expenses restored`,
  )
})

afterEach(() => {
  cleanup()
})

describe('DataProblemScreen restore entry point', () => {
  it('has no restore action or hint unless onRestored is given', () => {
    render(
      <DataProblemScreen
        storageKey="income"
        onRetry={vi.fn()}
        onQuarantine={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('data-problem-restore')).toBeNull()
    expect(screen.queryByTestId('data-problem-restore-hint')).toBeNull()
  })

  it('shows "Restore from backup" and the replace / quarantine hint', () => {
    renderScreen()

    expect(screen.getByTestId('data-problem-restore').textContent).toContain(
      'Restore from backup',
    )
    const hint = screen.getByTestId('data-problem-restore-hint').textContent
    expect(hint).toContain('replaces the data on this device')
    expect(hint).toContain('kept aside in quarantine, unchanged')
  })

  it('keeps Retry and Quarantine and keeps the dialog closed at first', () => {
    renderScreen()

    expect(screen.getByTestId('data-problem-retry')).toBeTruthy()
    expect(screen.getByTestId('data-problem-quarantine')).toBeTruthy()
    expect(screen.queryByTestId('restore-backup-dialog')).toBeNull()
  })

  it('opens the dialog with no mode select and a replace note', async () => {
    renderScreen()

    fireEvent.click(screen.getByTestId('data-problem-restore'))

    await screen.findByTestId('restore-backup-dialog')
    expect(screen.queryByTestId('restore-backup-mode-select')).toBeNull()
    expect(screen.getByTestId('restore-backup-replace-note')).toBeTruthy()
    expect(defaultRestoreMode).not.toHaveBeenCalled()
  })

  it('restores with mode replace even when the default mode would be merge', async () => {
    vi.mocked(defaultRestoreMode).mockResolvedValue('merge')
    renderScreen()
    fireEvent.click(screen.getByTestId('data-problem-restore'))
    await screen.findByTestId('restore-backup-dialog')
    const file = chooseFile()
    typeSecret('backup secret')

    submitRestore()

    await waitFor(() => {
      expect(restoreBackup).toHaveBeenCalledTimes(1)
    })
    expect(restoreBackup).toHaveBeenCalledWith(file, 'backup secret', 'replace')
  })

  it('passes the summary to onRestored after a successful restore', async () => {
    const result = summary({ expenses: 9 })
    vi.mocked(restoreBackup).mockResolvedValue(result)
    const { onRestored } = renderScreen()
    fireEvent.click(screen.getByTestId('data-problem-restore'))
    await screen.findByTestId('restore-backup-dialog')
    chooseFile()
    typeSecret('backup secret')

    submitRestore()

    await waitFor(() => {
      expect(onRestored).toHaveBeenCalledTimes(1)
    })
    expect(onRestored).toHaveBeenCalledWith(result)
  })

  it('does not call onRestored when the restore fails and shows the dialog error', async () => {
    vi.mocked(restoreBackup).mockRejectedValue(new Error('wrong secret'))
    const { onRestored } = renderScreen()
    fireEvent.click(screen.getByTestId('data-problem-restore'))
    await screen.findByTestId('restore-backup-dialog')
    chooseFile()
    typeSecret('bad')

    submitRestore()

    const error = await screen.findByTestId('restore-backup-error')
    expect(error.textContent).toBe('wrong secret')
    expect(onRestored).not.toHaveBeenCalled()
  })

  it('shows an error from onRestored in data-problem-error', async () => {
    const { onRestored } = renderScreen({
      onRestored: vi.fn(() => Promise.reject(new Error('reset failed'))),
    })
    expect(onRestored).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('data-problem-restore'))
    await screen.findByTestId('restore-backup-dialog')
    chooseFile()
    typeSecret('backup secret')

    submitRestore()

    const error = await screen.findByTestId('data-problem-error')
    expect(error.textContent).toContain('reset failed')
  })

  it('does not call Retry or Quarantine when restoring', async () => {
    const { onRetry, onQuarantine } = renderScreen()
    fireEvent.click(screen.getByTestId('data-problem-restore'))
    await screen.findByTestId('restore-backup-dialog')
    chooseFile()
    typeSecret('backup secret')

    submitRestore()

    await waitFor(() => {
      expect(restoreBackup).toHaveBeenCalledTimes(1)
    })
    expect(onRetry).not.toHaveBeenCalled()
    expect(onQuarantine).not.toHaveBeenCalled()
  })

  it('disables the restore button while another action is pending', async () => {
    const gate = deferred()
    renderScreen({ onQuarantine: () => gate.promise })
    const restore = screen.getByTestId<HTMLButtonElement>('data-problem-restore')
    expect(restore.disabled).toBe(false)

    fireEvent.click(screen.getByTestId('data-problem-quarantine'))

    await waitFor(() => {
      expect(restore.disabled).toBe(true)
    })
    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    expect(restore.disabled).toBe(false)
  })
})
