// No CONTRACT_GAPs: DataProblemScreen, DataProblemGate and DataErrorBoundary
// are fully specified in the Interface Contract. Phase 4 adds the optional
// "Back up readable data" action (onBackupReadable) and its Gate wiring. The
// validation-fixes run adds the Gate's onRestored wiring (RestoreBackupDialog
// is faked here; the real dialog is covered in DataProblemScreen.test.tsx).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Component } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { RestoreSummary } from '@/lib/backup'
import { downloadBackup, formatRestoreSummary } from '@/lib/backup'
import { DecryptError } from '@/lib/dataErrors'
import {
  clearDataProblem,
  getDataProblem,
  reportDataProblem,
} from '@/lib/dataProblem'
import { quarantineKey } from '@/lib/localDb'
import { DataErrorBoundary, DataProblemGate } from '@/components/DataProblemGate'
import { DataProblemScreen } from '@/components/DataProblemScreen'

vi.mock('@/lib/localDb', () => ({
  quarantineKey: vi.fn(),
}))
vi.mock('@/lib/backup', () => ({
  downloadBackup: vi.fn(),
  formatRestoreSummary: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/RestoreBackupDialog', () => ({
  RestoreBackupDialog: (props: {
    open: boolean
    forceReplace?: boolean
    onRestored?: (summary: RestoreSummary) => void
  }) =>
    props.open ? (
      <div
        data-testid="fake-restore-backup-dialog"
        data-force-replace={String(props.forceReplace === true)}
      >
        <button
          type="button"
          data-testid="fake-restore-backup-confirm"
          onClick={() =>
            props.onRestored?.({
              mode: 'replace',
              expenses: 6,
              income: 0,
              categories: 1,
              budgets: 0,
              added: 6,
              updated: 0,
              conflicts: 0,
              skipped: [],
              adoptedVault: false,
            })
          }
        >
          confirm
        </button>
      </div>
    ) : null,
}))

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function renderGate(client = new QueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <DataProblemGate>
        <div data-testid="gate-child" />
      </DataProblemGate>
    </QueryClientProvider>,
  )
  return client
}

beforeEach(() => {
  vi.resetAllMocks()
  clearDataProblem()
})

afterEach(() => {
  clearDataProblem()
})

describe('DataProblemScreen', () => {
  it('names the affected month for an expenses chunk', () => {
    render(
      <DataProblemScreen
        storageKey="expenses_2026_03"
        onRetry={vi.fn()}
        onQuarantine={vi.fn()}
      />,
    )

    expect(screen.getByTestId('data-problem-screen')).toBeTruthy()
    expect(screen.getByTestId('data-problem-key').textContent).toBe(
      'Expenses · 2026-03',
    )
    expect(screen.queryByTestId('data-problem-error')).toBeNull()
  })

  it('names other keys by their label', () => {
    render(
      <DataProblemScreen
        storageKey="categories"
        onRetry={vi.fn()}
        onQuarantine={vi.fn()}
      />,
    )

    expect(screen.getByTestId('data-problem-key').textContent).toBe('Categories')
  })

  it('Retry calls onRetry and not onQuarantine', () => {
    const onRetry = vi.fn()
    const onQuarantine = vi.fn()
    render(
      <DataProblemScreen
        storageKey="income"
        onRetry={onRetry}
        onQuarantine={onQuarantine}
      />,
    )

    fireEvent.click(screen.getByTestId('data-problem-retry'))

    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onQuarantine).not.toHaveBeenCalled()
  })

  it('has "Retry" and "Quarantine and continue" actions', () => {
    render(
      <DataProblemScreen
        storageKey="income"
        onRetry={vi.fn()}
        onQuarantine={vi.fn()}
      />,
    )

    expect(screen.getByTestId('data-problem-retry').textContent).toContain(
      'Retry',
    )
    expect(
      screen.getByTestId('data-problem-quarantine').textContent,
    ).toContain('Quarantine and continue')
  })

  it('disables Quarantine while pending', async () => {
    const gate = deferred()
    const onQuarantine = vi.fn(() => gate.promise)
    render(
      <DataProblemScreen
        storageKey="income"
        onRetry={vi.fn()}
        onQuarantine={onQuarantine}
      />,
    )
    const button = screen.getByTestId<HTMLButtonElement>(
      'data-problem-quarantine',
    )
    expect(button.disabled).toBe(false)

    fireEvent.click(button)

    await waitFor(() => {
      expect(button.disabled).toBe(true)
    })
    expect(onQuarantine).toHaveBeenCalledTimes(1)

    await act(async () => {
      gate.resolve()
      await gate.promise
    })
  })

  it('shows the rejection message in data-problem-error', async () => {
    render(
      <DataProblemScreen
        storageKey="income"
        onRetry={vi.fn()}
        onQuarantine={() => Promise.reject(new Error('disk full'))}
      />,
    )

    fireEvent.click(screen.getByTestId('data-problem-quarantine'))

    const error = await screen.findByTestId('data-problem-error')
    expect(error.textContent).toContain('disk full')
  })
})

describe('DataProblemScreen "Back up readable data"', () => {
  function renderWithBackup(
    onBackupReadable: () => Promise<Array<string> | null>,
    props: { onRetry?: () => void; onQuarantine?: () => Promise<void> } = {},
  ) {
    render(
      <DataProblemScreen
        storageKey="expenses_2026_03"
        onRetry={props.onRetry ?? vi.fn()}
        onQuarantine={props.onQuarantine ?? vi.fn()}
        onBackupReadable={onBackupReadable}
      />,
    )
  }

  it('has no backup action unless onBackupReadable is given', () => {
    render(
      <DataProblemScreen
        storageKey="income"
        onRetry={vi.fn()}
        onQuarantine={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('data-problem-backup')).toBeNull()
    expect(screen.queryByTestId('data-problem-backup-done')).toBeNull()
  })

  it('shows the action between Retry and Quarantine', () => {
    renderWithBackup(() => Promise.resolve([]))

    const retry = screen.getByTestId('data-problem-retry')
    const backup = screen.getByTestId('data-problem-backup')
    const quarantine = screen.getByTestId('data-problem-quarantine')
    expect(backup.textContent).toContain('Back up readable data')
    expect(
      retry.compareDocumentPosition(backup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      backup.compareDocumentPosition(quarantine) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.queryByTestId('data-problem-backup-done')).toBeNull()
  })

  it('calls onBackupReadable and neither Retry nor Quarantine', async () => {
    const onBackupReadable = vi.fn(() => Promise.resolve([] as Array<string>))
    const onRetry = vi.fn()
    const onQuarantine = vi.fn()
    renderWithBackup(onBackupReadable, { onRetry, onQuarantine })

    fireEvent.click(screen.getByTestId('data-problem-backup'))

    await screen.findByTestId('data-problem-backup-done')
    expect(onBackupReadable).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
    expect(onQuarantine).not.toHaveBeenCalled()
  })

  it('confirms the backup when nothing was skipped', async () => {
    renderWithBackup(() => Promise.resolve([]))

    fireEvent.click(screen.getByTestId('data-problem-backup'))

    const done = await screen.findByTestId('data-problem-backup-done')
    expect(done.textContent).toContain('Readable data backed up.')
    expect(done.textContent).not.toContain('Not included')
  })

  it('lists the skipped keys by label', async () => {
    renderWithBackup(() => Promise.resolve(['expenses_2026_03', 'income']))

    fireEvent.click(screen.getByTestId('data-problem-backup'))

    const done = await screen.findByTestId('data-problem-backup-done')
    expect(done.textContent).toContain('Readable data backed up.')
    expect(done.textContent).toContain(' Not included: Expenses · 2026-03, Income')
  })

  it('lists a different set of skipped keys differently', async () => {
    renderWithBackup(() => Promise.resolve(['budgets']))

    fireEvent.click(screen.getByTestId('data-problem-backup'))

    const done = await screen.findByTestId('data-problem-backup-done')
    expect(done.textContent).toContain('Not included: Budgets')
    expect(done.textContent).not.toContain('Income')
  })

  it('shows no confirmation when the share was cancelled (null)', async () => {
    const onBackupReadable = vi.fn(() => Promise.resolve(null))
    renderWithBackup(onBackupReadable)

    fireEvent.click(screen.getByTestId('data-problem-backup'))

    await waitFor(() => {
      expect(onBackupReadable).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLButtonElement>('data-problem-backup').disabled,
      ).toBe(false)
    })
    expect(screen.queryByTestId('data-problem-backup-done')).toBeNull()
    expect(screen.queryByTestId('data-problem-error')).toBeNull()
  })

  it('disables Retry, Back up and Quarantine while it is pending', async () => {
    const gate = deferred<Array<string> | null>()
    renderWithBackup(() => gate.promise)

    fireEvent.click(screen.getByTestId('data-problem-backup'))

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLButtonElement>('data-problem-backup').disabled,
      ).toBe(true)
    })
    expect(
      screen.getByTestId<HTMLButtonElement>('data-problem-retry').disabled,
    ).toBe(true)
    expect(
      screen.getByTestId<HTMLButtonElement>('data-problem-quarantine').disabled,
    ).toBe(true)

    await act(async () => {
      gate.resolve([])
      await gate.promise
    })
    expect(
      screen.getByTestId<HTMLButtonElement>('data-problem-retry').disabled,
    ).toBe(false)
  })

  it('shows a failure in data-problem-error and no confirmation', async () => {
    renderWithBackup(() => Promise.reject(new Error('share exploded')))

    fireEvent.click(screen.getByTestId('data-problem-backup'))

    const error = await screen.findByTestId('data-problem-error')
    expect(error.textContent).toContain('share exploded')
    expect(screen.queryByTestId('data-problem-backup-done')).toBeNull()
  })
})

describe('DataProblemGate', () => {
  it('renders its children when there is no problem', () => {
    renderGate()

    expect(screen.getByTestId('gate-child')).toBeTruthy()
    expect(screen.queryByTestId('data-problem-screen')).toBeNull()
  })

  it('replaces the children with the Data problem screen naming the key', () => {
    renderGate()

    act(() => {
      reportDataProblem(new DecryptError('expenses_2026_03'))
    })

    expect(screen.getByTestId('data-problem-key').textContent).toBe(
      'Expenses · 2026-03',
    )
    expect(screen.queryByTestId('gate-child')).toBeNull()
  })

  it('Retry resets the queries, clears the problem and brings the children back', async () => {
    const client = renderGate()
    const resetSpy = vi.spyOn(client, 'resetQueries')
    act(() => {
      reportDataProblem(new DecryptError('income'))
    })

    fireEvent.click(screen.getByTestId('data-problem-retry'))

    await screen.findByTestId('gate-child')
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(getDataProblem()).toBeNull()
    expect(screen.queryByTestId('data-problem-screen')).toBeNull()
    expect(quarantineKey).not.toHaveBeenCalled()
  })

  it('Quarantine and continue quarantines the key, resets the queries and returns to the app', async () => {
    vi.mocked(quarantineKey).mockResolvedValue(
      'quarantine:expenses_2026_03:2026-03-01T00:00:00.000Z',
    )
    const client = renderGate()
    const resetSpy = vi.spyOn(client, 'resetQueries')
    act(() => {
      reportDataProblem(new DecryptError('expenses_2026_03'))
    })

    fireEvent.click(screen.getByTestId('data-problem-quarantine'))

    await screen.findByTestId('gate-child')
    expect(quarantineKey).toHaveBeenCalledTimes(1)
    expect(quarantineKey).toHaveBeenCalledWith('expenses_2026_03')
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(quarantineKey).mock.invocationCallOrder[0],
    ).toBeLessThan(resetSpy.mock.invocationCallOrder[0])
    expect(getDataProblem()).toBeNull()
  })

  it('quarantines the key of the current problem, not a fixed one', async () => {
    vi.mocked(quarantineKey).mockResolvedValue(null)
    renderGate()
    act(() => {
      reportDataProblem(new DecryptError('budgets'))
    })

    fireEvent.click(screen.getByTestId('data-problem-quarantine'))

    await screen.findByTestId('gate-child')
    expect(quarantineKey).toHaveBeenCalledWith('budgets')
  })

  it('keeps the screen and shows the error when quarantining fails', async () => {
    vi.mocked(quarantineKey).mockRejectedValue(new Error('disk full'))
    const client = renderGate()
    const resetSpy = vi.spyOn(client, 'resetQueries')
    act(() => {
      reportDataProblem(new DecryptError('income'))
    })

    fireEvent.click(screen.getByTestId('data-problem-quarantine'))

    const error = await screen.findByTestId('data-problem-error')
    expect(error.textContent).toContain('disk full')
    expect(screen.queryByTestId('gate-child')).toBeNull()
    expect(getDataProblem()?.storageKey).toBe('income')
    expect(resetSpy).not.toHaveBeenCalled()
  })

  it('shows the first problem only until it is cleared', () => {
    renderGate()

    act(() => {
      reportDataProblem(new DecryptError('income'))
      reportDataProblem(new DecryptError('budgets'))
    })

    expect(screen.getByTestId('data-problem-key').textContent).toBe('Income')
  })

  it('offers "Back up readable data" on the screen', () => {
    renderGate()

    act(() => {
      reportDataProblem(new DecryptError('expenses_2026_03'))
    })

    expect(screen.getByTestId('data-problem-backup').textContent).toContain(
      'Back up readable data',
    )
  })

  it('Back up readable data makes a partial backup and lists the skipped keys', async () => {
    vi.mocked(downloadBackup).mockResolvedValue({
      status: 'saved',
      filename: 'minima-backup-2026-03-05.minima',
      skipped: ['expenses_2026_03'],
    })
    renderGate()
    act(() => {
      reportDataProblem(new DecryptError('expenses_2026_03'))
    })

    fireEvent.click(screen.getByTestId('data-problem-backup'))

    const done = await screen.findByTestId('data-problem-backup-done')
    expect(downloadBackup).toHaveBeenCalledTimes(1)
    expect(downloadBackup).toHaveBeenCalledWith({ partial: true })
    expect(done.textContent).toContain('Not included: Expenses · 2026-03')
    expect(screen.queryByTestId('gate-child')).toBeNull()
    expect(quarantineKey).not.toHaveBeenCalled()
    expect(getDataProblem()?.storageKey).toBe('expenses_2026_03')
  })

  it('reports no skipped keys when the partial backup skipped nothing', async () => {
    vi.mocked(downloadBackup).mockResolvedValue({
      status: 'saved',
      filename: 'x.minima',
      skipped: [],
    })
    renderGate()
    act(() => {
      reportDataProblem(new DecryptError('income'))
    })

    fireEvent.click(screen.getByTestId('data-problem-backup'))

    const done = await screen.findByTestId('data-problem-backup-done')
    expect(done.textContent).toContain('Readable data backed up.')
    expect(done.textContent).not.toContain('Not included')
  })

  it('shows no confirmation when the user cancels the share sheet', async () => {
    vi.mocked(downloadBackup).mockResolvedValue({
      status: 'cancelled',
      filename: 'x.minima',
      skipped: ['income'],
    })
    renderGate()
    act(() => {
      reportDataProblem(new DecryptError('income'))
    })

    fireEvent.click(screen.getByTestId('data-problem-backup'))

    await waitFor(() => {
      expect(downloadBackup).toHaveBeenCalledWith({ partial: true })
    })
    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLButtonElement>('data-problem-backup').disabled,
      ).toBe(false)
    })
    expect(screen.queryByTestId('data-problem-backup-done')).toBeNull()
  })

  it('shows the error when the backup fails', async () => {
    vi.mocked(downloadBackup).mockRejectedValue(new Error('no space'))
    renderGate()
    act(() => {
      reportDataProblem(new DecryptError('income'))
    })

    fireEvent.click(screen.getByTestId('data-problem-backup'))

    const error = await screen.findByTestId('data-problem-error')
    expect(error.textContent).toContain('no space')
    expect(screen.queryByTestId('data-problem-backup-done')).toBeNull()
  })
})

describe('DataProblemGate restore from backup', () => {
  it('offers "Restore from backup" on the screen', () => {
    renderGate()

    act(() => {
      reportDataProblem(new DecryptError('expenses_2026_03'))
    })

    expect(screen.getByTestId('data-problem-restore').textContent).toContain(
      'Restore from backup',
    )
  })

  it('after a restore: resets the queries, clears the problem, then toasts the summary', async () => {
    vi.mocked(formatRestoreSummary).mockImplementation(
      (s) => `${s.expenses} expenses restored`,
    )
    const client = renderGate()
    const seenByReset: Array<boolean> = []
    const seenByToast: Array<boolean> = []
    const resetSpy = vi
      .spyOn(client, 'resetQueries')
      .mockImplementation(() => {
        seenByReset.push(getDataProblem() !== null)
        return Promise.resolve()
      })
    vi.mocked(toast.success).mockImplementation(() => {
      seenByToast.push(getDataProblem() !== null)
      return 1
    })
    act(() => {
      reportDataProblem(new DecryptError('expenses_2026_03'))
    })
    fireEvent.click(screen.getByTestId('data-problem-restore'))
    await screen.findByTestId('fake-restore-backup-dialog')

    fireEvent.click(screen.getByTestId('fake-restore-backup-confirm'))

    await screen.findByTestId('gate-child')
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(getDataProblem()).toBeNull()
    expect(screen.queryByTestId('data-problem-screen')).toBeNull()
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('6 expenses restored')
    // The problem is still set when the queries are reset, and cleared before the toast.
    expect(seenByReset).toEqual([true])
    expect(seenByToast).toEqual([false])
    expect(quarantineKey).not.toHaveBeenCalled()
  })

  it('does nothing until the restore is confirmed', async () => {
    const client = renderGate()
    const resetSpy = vi.spyOn(client, 'resetQueries')
    act(() => {
      reportDataProblem(new DecryptError('income'))
    })

    fireEvent.click(screen.getByTestId('data-problem-restore'))
    await screen.findByTestId('fake-restore-backup-dialog')

    expect(resetSpy).not.toHaveBeenCalled()
    expect(getDataProblem()?.storageKey).toBe('income')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('opens the restore dialog in forceReplace mode', async () => {
    renderGate()
    act(() => {
      reportDataProblem(new DecryptError('income'))
    })

    fireEvent.click(screen.getByTestId('data-problem-restore'))

    const dialog = await screen.findByTestId('fake-restore-backup-dialog')
    expect(dialog.getAttribute('data-force-replace')).toBe('true')
  })
})

describe('DataErrorBoundary', () => {
  class Catcher extends Component<
    { children: ReactNode },
    { message: string | null }
  > {
    state = { message: null as string | null }
    static getDerivedStateFromError(error: unknown) {
      return { message: error instanceof Error ? error.message : 'unknown' }
    }
    render() {
      if (this.state.message !== null) {
        return <p>outer caught: {this.state.message}</p>
      }
      return this.props.children
    }
  }

  function Thrower({ error }: { error: Error }): ReactNode {
    throw error
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports a DecryptError thrown during render and renders nothing for it', () => {
    render(
      <DataErrorBoundary>
        <Thrower error={new DecryptError('income')} />
      </DataErrorBoundary>,
    )

    expect(getDataProblem()?.storageKey).toBe('income')
    expect(document.body.textContent).toBe('')
  })

  it('the gate swaps in the Data problem screen when a child throws DecryptError', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DataProblemGate>
          <Thrower error={new DecryptError('expenses_2026_03')} />
        </DataProblemGate>
      </QueryClientProvider>,
    )

    const key = await screen.findByTestId('data-problem-key')
    expect(key.textContent).toBe('Expenses · 2026-03')
  })

  it('rethrows other errors to the parent boundary and reports no problem', () => {
    render(
      <Catcher>
        <DataErrorBoundary>
          <Thrower error={new Error('plain failure')} />
        </DataErrorBoundary>
      </Catcher>,
    )

    expect(screen.getByText('outer caught: plain failure')).toBeTruthy()
    expect(getDataProblem()).toBeNull()
  })

  it('renders children normally when nothing throws', () => {
    render(
      <DataErrorBoundary>
        <div data-testid="gate-child" />
      </DataErrorBoundary>,
    )

    expect(screen.getByTestId('gate-child')).toBeTruthy()
    expect(getDataProblem()).toBeNull()
  })
})
