// No CONTRACT_GAPs: RecurringScheduler props and behaviour are specified in the
// Interface Contract (component: RecurringScheduler) and plan section 7.
// processDueRecurring, sonner and reportDataProblem are mocked; the date
// change is driven with fake timers and vi.setSystemTime.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { RecurringScheduler } from '@/components/RecurringScheduler'
import { reportDataProblem } from '@/lib/dataProblem'
import { DecryptError } from '@/lib/dataErrors'
import { processDueRecurring } from '@/lib/localDb'
import { recurringCreatedMessage } from '@/lib/recurrence'

vi.mock('@/lib/localDb', () => ({ processDueRecurring: vi.fn() }))
vi.mock('@/lib/dataProblem', () => ({ reportDataProblem: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const DAY_ONE = new Date(2026, 4, 15, 10, 0, 0)
const DAY_TWO = new Date(2026, 4, 16, 10, 0, 0)
const DAY_THREE = new Date(2026, 4, 17, 10, 0, 0)

let visibility: DocumentVisibilityState = 'visible'
let client: QueryClient

function wrap(ui: ReactNode) {
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

function renderScheduler(props: { unlocked: boolean; checkIntervalMs?: number }) {
  return render(wrap(<RecurringScheduler {...props} />))
}

async function becomeVisible() {
  visibility = 'visible'
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

async function becomeHidden() {
  visibility = 'hidden'
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(processDueRecurring).mockResolvedValue({ created: 0, itemsTouched: 0 })
  vi.useFakeTimers()
  vi.setSystemTime(DAY_ONE)
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
  client = new QueryClient()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('RecurringScheduler triggers', () => {
  it('renders nothing and does not run on mount, even when unlocked', async () => {
    const { container } = renderScheduler({ unlocked: true })
    await advance(0)

    expect(container.innerHTML).toBe('')
    expect(processDueRecurring).not.toHaveBeenCalled()
  })

  it('runs when the tab becomes visible while unlocked', async () => {
    renderScheduler({ unlocked: true })

    await becomeVisible()

    expect(processDueRecurring).toHaveBeenCalledTimes(1)
    await becomeVisible()
    expect(processDueRecurring).toHaveBeenCalledTimes(2)
  })

  it('does not run when the tab becomes hidden', async () => {
    renderScheduler({ unlocked: true })

    await becomeHidden()

    expect(processDueRecurring).not.toHaveBeenCalled()
  })

  it('does not run on visibility changes while locked', async () => {
    renderScheduler({ unlocked: false })

    await becomeVisible()

    expect(processDueRecurring).not.toHaveBeenCalled()
  })

  it('starts listening when unlocked turns true and stops when it turns false', async () => {
    const { rerender } = renderScheduler({ unlocked: false })
    await becomeVisible()
    expect(processDueRecurring).not.toHaveBeenCalled()

    rerender(wrap(<RecurringScheduler unlocked />))
    await becomeVisible()
    expect(processDueRecurring).toHaveBeenCalledTimes(1)

    rerender(wrap(<RecurringScheduler unlocked={false} />))
    await becomeVisible()
    expect(processDueRecurring).toHaveBeenCalledTimes(1)
  })

  it('removes its listener and interval on unmount', async () => {
    const { unmount } = renderScheduler({ unlocked: true, checkIntervalMs: 1000 })
    unmount()

    await becomeVisible()
    vi.setSystemTime(DAY_TWO)
    await advance(5000)

    expect(processDueRecurring).not.toHaveBeenCalled()
  })

  it('runs when the local date changes, detected by the interval', async () => {
    renderScheduler({ unlocked: true, checkIntervalMs: 1000 })

    await advance(5000)
    expect(processDueRecurring).not.toHaveBeenCalled()

    vi.setSystemTime(DAY_TWO)
    await advance(1000)
    expect(processDueRecurring).toHaveBeenCalledTimes(1)

    await advance(5000)
    expect(processDueRecurring).toHaveBeenCalledTimes(1)

    vi.setSystemTime(DAY_THREE)
    await advance(1000)
    expect(processDueRecurring).toHaveBeenCalledTimes(2)
  })

  it('does not run on the interval while locked, even after the date changed', async () => {
    renderScheduler({ unlocked: false, checkIntervalMs: 1000 })

    vi.setSystemTime(DAY_TWO)
    await advance(5000)

    expect(processDueRecurring).not.toHaveBeenCalled()
  })

  it('defaults the check interval to one minute', async () => {
    renderScheduler({ unlocked: true })

    vi.setSystemTime(DAY_TWO)
    await advance(30_000)
    expect(processDueRecurring).not.toHaveBeenCalled()

    await advance(30_000)
    expect(processDueRecurring).toHaveBeenCalledTimes(1)
  })
})

describe('RecurringScheduler results', () => {
  it('shows one toast with the count when records were created', async () => {
    vi.mocked(processDueRecurring).mockResolvedValue({ created: 3, itemsTouched: 1 })
    renderScheduler({ unlocked: true })

    await becomeVisible()

    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith(recurringCreatedMessage(3))
    expect(recurringCreatedMessage(3)).toBe('Added 3 recurring transactions')
  })

  it('the toast text follows the created count', async () => {
    vi.mocked(processDueRecurring).mockResolvedValue({ created: 1, itemsTouched: 1 })
    renderScheduler({ unlocked: true })

    await becomeVisible()

    expect(toast.success).toHaveBeenCalledWith(recurringCreatedMessage(1))
    expect(toast.success).not.toHaveBeenCalledWith(recurringCreatedMessage(3))
  })

  it('shows no toast when nothing was created', async () => {
    renderScheduler({ unlocked: true })

    await becomeVisible()

    expect(processDueRecurring).toHaveBeenCalledTimes(1)
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('invalidates recurring, expenses, income and analytics when items were touched', async () => {
    vi.mocked(processDueRecurring).mockResolvedValue({ created: 2, itemsTouched: 2 })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    renderScheduler({ unlocked: true })

    await becomeVisible()

    const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey)
    expect(keys).toEqual(
      expect.arrayContaining([
        ['recurring'],
        ['expenses'],
        ['income'],
        ['analytics'],
      ]),
    )
  })

  it('invalidates nothing when no item was touched', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    renderScheduler({ unlocked: true })

    await becomeVisible()

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('routes a DecryptError to the data problem screen', async () => {
    const error = new DecryptError('recurring', new Error('bad tag'))
    vi.mocked(processDueRecurring).mockRejectedValue(error)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderScheduler({ unlocked: true })

    await becomeVisible()

    expect(reportDataProblem).toHaveBeenCalledTimes(1)
    expect(reportDataProblem).toHaveBeenCalledWith(error)
    expect(toast.success).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('logs any other error and does not report a data problem', async () => {
    vi.mocked(processDueRecurring).mockRejectedValue(new Error('disk full'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderScheduler({ unlocked: true })

    await becomeVisible()

    expect(consoleError).toHaveBeenCalled()
    expect(reportDataProblem).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('keeps running after a failed run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(processDueRecurring)
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue({ created: 1, itemsTouched: 1 })
    renderScheduler({ unlocked: true })

    await becomeVisible()
    await becomeVisible()

    expect(processDueRecurring).toHaveBeenCalledTimes(2)
    expect(toast.success).toHaveBeenCalledTimes(1)
  })
})
