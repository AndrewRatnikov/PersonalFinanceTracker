// No CONTRACT_GAPs: SyncRunner behaviour is specified in plan section 10 and the
// Interface Contract (component: SyncRunner). The runtime, the session hooks,
// the toast and the data-problem report are fakes; the feature flag is a
// mutable getter.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Lang } from '@/i18n/lang'
import type { SyncEngineEvent } from '@/lib/sync/types'
import { setLang, translate } from '@/i18n/core'
import { useAccountSession, useAccountsVisible } from '@/lib/accountSession'
import { DecryptError } from '@/lib/dataErrors'
import { reportDataProblem } from '@/lib/dataProblem'
import { getSyncRuntime } from '@/lib/sync/runtime'
import { SyncRunner } from '@/components/SyncRunner'

const flags = vi.hoisted(() => ({ sync: true }))
const { toastFn, engine, setUserId } = vi.hoisted(() => ({
  toastFn: vi.fn(),
  engine: {
    start: vi.fn(),
    stop: vi.fn(),
    onEvent: vi.fn(),
  },
  setUserId: vi.fn(),
}))

vi.mock('@/lib/featureFlags', () => ({
  ENABLE_ACCOUNTS: true,
  get ENABLE_SYNC() {
    return flags.sync
  },
}))
vi.mock('sonner', () => ({
  toast: Object.assign(toastFn, { success: vi.fn(), error: vi.fn() }),
}))
vi.mock('@/lib/accountSession', () => ({
  useAccountsVisible: vi.fn(),
  useAccountSession: vi.fn(),
}))
vi.mock('@/lib/dataProblem', () => ({ reportDataProblem: vi.fn() }))
vi.mock('@/lib/sync/runtime', () => ({ getSyncRuntime: vi.fn() }))

const LANGS: Array<Lang> = ['en', 'uk']

function renderRunner(unlocked: boolean) {
  const client = new QueryClient()
  const tree = (u: boolean) => (
    <QueryClientProvider client={client}>
      <SyncRunner unlocked={u} />
    </QueryClientProvider>
  )
  const view = render(tree(unlocked))
  return { ...view, setUnlocked: (u: boolean) => view.rerender(tree(u)) }
}

function emit(event: SyncEngineEvent) {
  const listener = engine.onEvent.mock.calls.at(-1)?.[0] as ((e: SyncEngineEvent) => void) | undefined
  if (!listener) throw new Error('the runner did not subscribe to engine events')
  listener(event)
}

beforeEach(() => {
  vi.resetAllMocks()
  flags.sync = true
  setLang('en', { persist: false })
  vi.mocked(useAccountsVisible).mockReturnValue(true)
  vi.mocked(useAccountSession).mockReturnValue({ userId: 'user-1', email: 'ann@example.com' })
  vi.mocked(getSyncRuntime).mockReturnValue({ engine, actions: {}, setUserId } as never)
  engine.onEvent.mockReturnValue(vi.fn())
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('what it renders and when it stays out of the way', () => {
  it('renders nothing', () => {
    const { container } = renderRunner(true)
    expect(container.innerHTML).toBe('')
  })

  it('with the flag off it touches no sync code at all', () => {
    flags.sync = false
    renderRunner(true)
    expect(getSyncRuntime).not.toHaveBeenCalled()
    expect(engine.start).not.toHaveBeenCalled()
    expect(engine.stop).not.toHaveBeenCalled()
    expect(setUserId).not.toHaveBeenCalled()
  })

  it('with accounts hidden it does not build the runtime', () => {
    vi.mocked(useAccountsVisible).mockReturnValue(false)
    renderRunner(true)
    expect(getSyncRuntime).not.toHaveBeenCalled()
    expect(engine.start).not.toHaveBeenCalled()
  })
})

describe('starting and stopping the engine', () => {
  it('starts when the vault is unlocked and a user is signed in', () => {
    renderRunner(true)

    expect(setUserId).toHaveBeenCalledWith('user-1')
    expect(engine.start).toHaveBeenCalledTimes(1)
  })

  it('tells the runtime which user is signed in', () => {
    vi.mocked(useAccountSession).mockReturnValue({ userId: 'user-2', email: 'bob@example.com' })
    renderRunner(true)
    expect(setUserId).toHaveBeenCalledWith('user-2')
    expect(setUserId).not.toHaveBeenCalledWith('user-1')
  })

  it('does not start while the vault is locked', () => {
    renderRunner(false)
    expect(engine.start).not.toHaveBeenCalled()
    expect(engine.stop).toHaveBeenCalled()
  })

  it('does not start when signed out, and clears the user', () => {
    vi.mocked(useAccountSession).mockReturnValue(null)
    renderRunner(true)

    expect(setUserId).toHaveBeenCalledWith(null)
    expect(engine.start).not.toHaveBeenCalled()
    expect(engine.stop).toHaveBeenCalled()
  })

  it('stops when the vault is locked and starts again on unlock', () => {
    const { setUnlocked } = renderRunner(true)
    expect(engine.start).toHaveBeenCalledTimes(1)
    const stops = engine.stop.mock.calls.length

    setUnlocked(false)
    expect(engine.stop.mock.calls.length).toBeGreaterThan(stops)

    setUnlocked(true)
    expect(engine.start).toHaveBeenCalledTimes(2)
  })

  it('stops when the component unmounts', () => {
    const view = renderRunner(true)
    const stops = engine.stop.mock.calls.length
    view.unmount()
    expect(engine.stop.mock.calls.length).toBeGreaterThan(stops)
  })

  it('signing out stops the engine and keeps nothing else running', () => {
    const view = renderRunner(true)
    vi.mocked(useAccountSession).mockReturnValue(null)
    const stops = engine.stop.mock.calls.length
    view.setUnlocked(true)
    expect(engine.stop.mock.calls.length).toBeGreaterThan(stops)
  })
})

describe('engine events', () => {
  it('subscribes once and unsubscribes on unmount', () => {
    const off = vi.fn()
    engine.onEvent.mockReturnValue(off)
    const view = renderRunner(true)

    expect(engine.onEvent).toHaveBeenCalledTimes(1)
    expect(off).not.toHaveBeenCalled()
    view.unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it.each(LANGS)('a changed password on another device shows a toast in %s', (lang) => {
    setLang(lang, { persist: false })
    renderRunner(true)
    emit({ type: 'header-adopted' })

    expect(toastFn).toHaveBeenCalledTimes(1)
    expect(toastFn).toHaveBeenCalledWith(translate(lang, 'sync.toast.passwordChanged'))
  })

  it('state events cause no toast', () => {
    renderRunner(true)
    emit({
      type: 'state',
      state: {
        status: 'synced',
        lastSyncAt: null,
        progress: null,
        errorCode: null,
        lastError: null,
        deviceId: 'd',
      },
    })
    expect(toastFn).not.toHaveBeenCalled()
    expect(reportDataProblem).not.toHaveBeenCalled()
  })

  it('reports a local decrypt problem', () => {
    renderRunner(true)
    const error = new DecryptError('expenses_2026_10')
    emit({ type: 'data-problem', error })
    expect(reportDataProblem).toHaveBeenCalledTimes(1)
    expect(reportDataProblem).toHaveBeenCalledWith(error)
  })

  it('ignores a data problem that is not a decrypt error', () => {
    renderRunner(true)
    emit({ type: 'data-problem', error: new Error('something else') })
    emit({ type: 'data-problem', error: 'text' })
    expect(reportDataProblem).not.toHaveBeenCalled()
  })
})
