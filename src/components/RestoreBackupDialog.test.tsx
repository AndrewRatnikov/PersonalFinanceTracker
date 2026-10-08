// No CONTRACT_GAPs: RestoreBackupDialog props, selectors and mocks are fully
// specified in the Interface Contract (component: RestoreBackupDialog).

import {
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
import { RestoreBackupDialog } from '@/components/RestoreBackupDialog'

vi.mock('@/lib/backup', () => ({
  restoreBackup: vi.fn(),
  defaultRestoreMode: vi.fn(),
  formatRestoreSummary: vi.fn(),
}))

function summary(patch: Partial<RestoreSummary> = {}): RestoreSummary {
  return {
    mode: 'merge',
    expenses: 3,
    income: 1,
    categories: 2,
    budgets: 1,
    added: 5,
    updated: 2,
    conflicts: 0,
    skipped: [],
    adoptedVault: false,
    ...patch,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function renderDialog(
  props: Partial<React.ComponentProps<typeof RestoreBackupDialog>> = {},
) {
  const onOpenChange = vi.fn()
  const onRestored = vi.fn()
  const view = render(
    <RestoreBackupDialog
      open
      onOpenChange={onOpenChange}
      onRestored={onRestored}
      {...props}
    />,
  )
  return { onOpenChange, onRestored, ...view }
}

function submit() {
  return screen.getByTestId<HTMLButtonElement>('restore-backup-submit')
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

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(defaultRestoreMode).mockResolvedValue('merge')
  vi.mocked(restoreBackup).mockResolvedValue(summary())
  vi.mocked(formatRestoreSummary).mockImplementation(
    (s) => `${s.expenses} expenses restored, ${s.updated} updated`,
  )
})

afterEach(() => {
  cleanup()
})

describe('RestoreBackupDialog layout', () => {
  it('renders nothing when closed', () => {
    renderDialog({ open: false })

    expect(screen.queryByTestId('restore-backup-dialog')).toBeNull()
  })

  it('has a .minima file input, a password-type secret input and the unlock rule', () => {
    renderDialog()

    expect(screen.getByTestId('restore-backup-dialog')).toBeTruthy()
    const file = screen.getByTestId<HTMLInputElement>(
      'restore-backup-file-input',
    )
    expect(file.type).toBe('file')
    expect(file.accept).toContain('.minima')
    const secret = screen.getByTestId<HTMLInputElement>(
      'restore-backup-secret-input',
    )
    expect(secret.type).toBe('password')
    const rule = screen.getByTestId('restore-backup-unlock-rule').textContent
    expect(rule).toContain('password that was current when this backup was made')
    expect(rule).toContain('recovery key')
    expect(screen.getByTestId('restore-backup-cancel').textContent).toBe(
      'Cancel',
    )
    expect(submit().textContent).toContain('Restore')
  })

  it('shows no error or summary at first', () => {
    renderDialog()

    expect(screen.queryByTestId('restore-backup-error')).toBeNull()
    expect(screen.queryByTestId('restore-backup-summary')).toBeNull()
  })

  it('offers a merge / replace select on an existing device', () => {
    renderDialog()

    const select = screen.getByTestId<HTMLSelectElement>(
      'restore-backup-mode-select',
    )
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'merge',
      'replace',
    ])
  })

  it('has no mode select on a fresh device', () => {
    renderDialog({ freshDevice: true })

    expect(screen.queryByTestId('restore-backup-mode-select')).toBeNull()
    expect(screen.getByTestId('restore-backup-unlock-rule')).toBeTruthy()
  })
})

describe('RestoreBackupDialog mode default', () => {
  it('starts on merge, then takes "replace" from defaultRestoreMode', async () => {
    vi.mocked(defaultRestoreMode).mockResolvedValue('replace')
    renderDialog()

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLSelectElement>('restore-backup-mode-select')
          .value,
      ).toBe('replace')
    })
  })

  it('stays on merge when defaultRestoreMode says merge', async () => {
    vi.mocked(defaultRestoreMode).mockResolvedValue('merge')
    renderDialog()

    await waitFor(() => {
      expect(defaultRestoreMode).toHaveBeenCalled()
    })
    expect(
      screen.getByTestId<HTMLSelectElement>('restore-backup-mode-select').value,
    ).toBe('merge')
  })

  it('asks again each time the dialog opens', async () => {
    const { rerender, onOpenChange } = renderDialog({ open: false })
    expect(defaultRestoreMode).not.toHaveBeenCalled()

    rerender(<RestoreBackupDialog open onOpenChange={onOpenChange} />)
    await waitFor(() => {
      expect(defaultRestoreMode).toHaveBeenCalledTimes(1)
    })

    rerender(<RestoreBackupDialog open={false} onOpenChange={onOpenChange} />)
    rerender(<RestoreBackupDialog open onOpenChange={onOpenChange} />)
    await waitFor(() => {
      expect(defaultRestoreMode).toHaveBeenCalledTimes(2)
    })
  })
})

describe('RestoreBackupDialog submit', () => {
  it('is disabled until a file is chosen and a secret is entered', () => {
    renderDialog()
    expect(submit().disabled).toBe(true)

    chooseFile()
    expect(submit().disabled).toBe(true)

    typeSecret('hunter2 hunter2')
    expect(submit().disabled).toBe(false)

    typeSecret('')
    expect(submit().disabled).toBe(true)
  })

  it('is disabled with only a secret', () => {
    renderDialog()

    typeSecret('hunter2 hunter2')

    expect(submit().disabled).toBe(true)
  })

  it('calls restoreBackup with the chosen file, the secret and the selected mode', async () => {
    renderDialog()
    const file = chooseFile()
    typeSecret('my password')

    fireEvent.click(submit())

    await waitFor(() => {
      expect(restoreBackup).toHaveBeenCalledTimes(1)
    })
    expect(restoreBackup).toHaveBeenCalledWith(file, 'my password', 'merge')
  })

  it('passes "replace" when the select is changed to it', async () => {
    renderDialog()
    const file = chooseFile()
    typeSecret('other secret')
    fireEvent.change(screen.getByTestId('restore-backup-mode-select'), {
      target: { value: 'replace' },
    })

    fireEvent.click(submit())

    await waitFor(() => {
      expect(restoreBackup).toHaveBeenCalledWith(file, 'other secret', 'replace')
    })
  })

  it('on a fresh device always restores in replace mode', async () => {
    vi.mocked(defaultRestoreMode).mockResolvedValue('merge')
    renderDialog({ freshDevice: true })
    const file = chooseFile()
    typeSecret('fresh secret')

    fireEvent.click(submit())

    await waitFor(() => {
      expect(restoreBackup).toHaveBeenCalledWith(
        file,
        'fresh secret',
        'replace',
      )
    })
  })

  it('disables the submit button while the restore is pending', async () => {
    const pending = deferred<RestoreSummary>()
    vi.mocked(restoreBackup).mockReturnValue(pending.promise)
    renderDialog()
    chooseFile()
    typeSecret('my password')

    fireEvent.click(submit())

    await waitFor(() => {
      expect(submit().disabled).toBe(true)
    })

    pending.resolve(summary())
    await screen.findByTestId('restore-backup-summary')
  })
})

describe('RestoreBackupDialog result', () => {
  it('shows the formatted summary, calls onRestored and offers Done', async () => {
    const result = summary({ expenses: 7, updated: 4 })
    vi.mocked(restoreBackup).mockResolvedValue(result)
    const { onRestored } = renderDialog()
    chooseFile()
    typeSecret('my password')

    fireEvent.click(submit())

    const text = await screen.findByTestId('restore-backup-summary')
    expect(text.textContent).toContain('7 expenses restored, 4 updated')
    expect(formatRestoreSummary).toHaveBeenCalledWith(result)
    expect(onRestored).toHaveBeenCalledTimes(1)
    expect(onRestored).toHaveBeenCalledWith(result)
    expect(screen.getByTestId('restore-backup-cancel').textContent).toBe('Done')
    expect(screen.queryByTestId('restore-backup-error')).toBeNull()
  })

  it('reflects a different summary in the text', async () => {
    vi.mocked(restoreBackup).mockResolvedValue(
      summary({ expenses: 1, updated: 0 }),
    )
    renderDialog()
    chooseFile()
    typeSecret('my password')

    fireEvent.click(submit())

    const text = await screen.findByTestId('restore-backup-summary')
    expect(text.textContent).toContain('1 expenses restored, 0 updated')
  })

  it('lists the keys that are not in a partial backup', async () => {
    vi.mocked(restoreBackup).mockResolvedValue(
      summary({ skipped: ['expenses_2026_03', 'income'] }),
    )
    renderDialog()
    chooseFile()
    typeSecret('my password')

    fireEvent.click(submit())

    const text = await screen.findByTestId('restore-backup-summary')
    expect(text.textContent).toContain('Not in this backup: ')
    expect(text.textContent).toContain('Expenses · 2026-03')
    expect(text.textContent).toContain('Income')
  })

  it('does not mention missing data when nothing was skipped', async () => {
    renderDialog()
    chooseFile()
    typeSecret('my password')

    fireEvent.click(submit())

    const text = await screen.findByTestId('restore-backup-summary')
    expect(text.textContent).not.toContain('Not in this backup')
  })

  it('shows the error message and does not call onRestored', async () => {
    vi.mocked(restoreBackup).mockRejectedValue(
      new Error("This password or recovery key doesn't open this backup"),
    )
    const { onRestored } = renderDialog()
    chooseFile()
    typeSecret('wrong')

    fireEvent.click(submit())

    const error = await screen.findByTestId('restore-backup-error')
    expect(error.textContent).toBe(
      "This password or recovery key doesn't open this backup",
    )
    expect(screen.queryByTestId('restore-backup-summary')).toBeNull()
    expect(onRestored).not.toHaveBeenCalled()
    expect(screen.getByTestId('restore-backup-cancel').textContent).toBe(
      'Cancel',
    )
  })

  it('shows a different error message for a different failure', async () => {
    vi.mocked(restoreBackup).mockRejectedValue(new Error('This backup file is damaged'))
    renderDialog()
    chooseFile()
    typeSecret('x')

    fireEvent.click(submit())

    const error = await screen.findByTestId('restore-backup-error')
    expect(error.textContent).toBe('This backup file is damaged')
  })

  it('lets the user retry after an error', async () => {
    vi.mocked(restoreBackup).mockRejectedValueOnce(new Error('nope'))
    renderDialog()
    chooseFile()
    typeSecret('first')
    fireEvent.click(submit())
    await screen.findByTestId('restore-backup-error')

    typeSecret('second')
    expect(submit().disabled).toBe(false)
    fireEvent.click(submit())

    await screen.findByTestId('restore-backup-summary')
    expect(restoreBackup).toHaveBeenCalledTimes(2)
    expect(vi.mocked(restoreBackup).mock.calls[1][1]).toBe('second')
  })
})

describe('RestoreBackupDialog cancel and reset', () => {
  it('Cancel closes the dialog without restoring', () => {
    const { onOpenChange } = renderDialog()

    fireEvent.click(screen.getByTestId('restore-backup-cancel'))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(restoreBackup).not.toHaveBeenCalled()
  })

  it('Done closes the dialog after a restore', async () => {
    const { onOpenChange } = renderDialog()
    chooseFile()
    typeSecret('my password')
    fireEvent.click(submit())
    await screen.findByTestId('restore-backup-summary')

    fireEvent.click(screen.getByTestId('restore-backup-cancel'))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('clears the secret, the error and the summary when it is closed and reopened', async () => {
    vi.mocked(restoreBackup).mockRejectedValueOnce(new Error('boom'))
    const { rerender, onOpenChange } = renderDialog()
    chooseFile()
    typeSecret('keep me not')
    fireEvent.click(submit())
    await screen.findByTestId('restore-backup-error')

    rerender(<RestoreBackupDialog open={false} onOpenChange={onOpenChange} />)
    rerender(<RestoreBackupDialog open onOpenChange={onOpenChange} />)

    expect(
      screen.getByTestId<HTMLInputElement>('restore-backup-secret-input').value,
    ).toBe('')
    expect(screen.queryByTestId('restore-backup-error')).toBeNull()
    expect(submit().disabled).toBe(true)
  })
})
