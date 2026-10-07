// No CONTRACT_GAPs: DataProblemScreen, DataProblemGate and DataErrorBoundary
// are fully specified in the Interface Contract.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Component } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
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
