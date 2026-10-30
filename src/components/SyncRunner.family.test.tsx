// No CONTRACT_GAPs: SyncRunner's Family behaviour is specified in plan section
// 6 and the Interface Contract (component: SyncRunner). The runtime (with a
// fake Family stream), the session hooks, the toast and the data-problem report
// are fakes; the existing engine behaviour stays covered by SyncRunner.test.tsx.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Lang } from '@/i18n/lang'
import type { FamilyStreamEvent, FamilySyncState } from '@/lib/sync/types'
import { setLang, translate } from '@/i18n/core'
import { useAccountSession, useAccountsVisible } from '@/lib/accountSession'
import { reportDataProblem } from '@/lib/dataProblem'
import { getSyncRuntime } from '@/lib/sync/runtime'
import { SyncRunner } from '@/components/SyncRunner'

const { toastFn, engine, family, setUserId } = vi.hoisted(() => ({
  toastFn: vi.fn(),
  engine: { start: vi.fn(), stop: vi.fn(), onEvent: vi.fn() },
  family: { onEvent: vi.fn() },
  setUserId: vi.fn(),
}))

vi.mock('@/lib/featureFlags', () => ({ ENABLE_ACCOUNTS: true, ENABLE_SYNC: true }))
vi.mock('sonner', () => ({
  toast: Object.assign(toastFn, { success: vi.fn(), error: vi.fn() }),
}))
vi.mock('@/lib/accountSession', () => ({
  useAccountsVisible: vi.fn(),
  useAccountSession: vi.fn(),
}))
vi.mock('@/lib/dataProblem', () => ({ reportDataProblem: vi.fn() }))
vi.mock('@/lib/sync/runtime', () => ({ getSyncRuntime: vi.fn() }))

const SPACE = 'a1b2c3d4-0000-4000-8000-0000000000a1'

function state(status: FamilySyncState['status']): FamilySyncState {
  return {
    status,
    spaceId: SPACE,
    role: 'owner',
    name: 'Home',
    readOnly: false,
    space: null,
    lastSyncAt: null,
    progress: null,
    errorCode: null,
    lastError: null,
    pendingOwnerEmail: null,
  }
}

let client: QueryClient

function renderRunner() {
  const tree = (
    <QueryClientProvider client={client}>
      <SyncRunner unlocked />
    </QueryClientProvider>
  )
  return render(tree)
}

function emitFamily(event: FamilyStreamEvent) {
  const listener = family.onEvent.mock.calls.at(-1)?.[0] as ((e: FamilyStreamEvent) => void) | undefined
  if (!listener) throw new Error('the runner did not subscribe to Family events')
  listener(event)
}

beforeEach(() => {
  vi.resetAllMocks()
  client = new QueryClient()
  setLang('en', { persist: false })
  vi.mocked(useAccountsVisible).mockReturnValue(true)
  vi.mocked(useAccountSession).mockReturnValue({ userId: 'user-1', email: 'ann@example.com' })
  vi.mocked(getSyncRuntime).mockReturnValue({ engine, actions: {}, family, familyActions: {}, setUserId } as never)
  engine.onEvent.mockReturnValue(vi.fn())
  family.onEvent.mockReturnValue(vi.fn())
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('subscribing', () => {
  it('subscribes to Family events when the runtime has a Family stream', () => {
    renderRunner()

    expect(family.onEvent).toHaveBeenCalledTimes(1)
    expect(engine.onEvent).toHaveBeenCalledTimes(1)
  })

  it('does nothing extra when the Family stream is null', () => {
    vi.mocked(getSyncRuntime).mockReturnValue({ engine, actions: {}, family: null, familyActions: null, setUserId } as never)

    renderRunner()

    expect(engine.onEvent).toHaveBeenCalledTimes(1)
    expect(family.onEvent).not.toHaveBeenCalled()
    expect(toastFn).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount', () => {
    const off = vi.fn()
    family.onEvent.mockReturnValue(off)

    const view = renderRunner()
    view.unmount()

    expect(off).toHaveBeenCalledTimes(1)
  })
})

describe.each<Lang>(['en', 'uk'])('toasts (%s)', (lang) => {
  beforeEach(() => setLang(lang, { persist: false }))

  it('joined toasts "You joined <name>"', () => {
    renderRunner()

    emitFamily({ type: 'joined', spaceId: SPACE, name: 'Our Home' })

    expect(toastFn).toHaveBeenCalledWith(translate(lang, 'family.toast.joined', { name: 'Our Home' }))
  })

  it('a join request toasts the email of the requester', () => {
    renderRunner()

    emitFamily({ type: 'join-request', spaceId: SPACE, userId: 'u2', email: 'bob@example.com' })

    expect(toastFn).toHaveBeenCalledWith(translate(lang, 'family.toast.request', { email: 'bob@example.com' }))
  })

  it('different names give different toasts', () => {
    renderRunner()

    emitFamily({ type: 'joined', spaceId: SPACE, name: 'A' })
    emitFamily({ type: 'joined', spaceId: SPACE, name: 'B' })

    expect(toastFn.mock.calls[0][0]).not.toBe(toastFn.mock.calls[1][0])
  })
})

describe('data problems', () => {
  it('a Family data-problem is reported like a personal one', () => {
    renderRunner()
    const error = new Error('cannot decrypt')

    emitFamily({ type: 'data-problem', error })

    expect(reportDataProblem).toHaveBeenCalledWith(error)
  })
})

describe('refreshing the queries after a Family cycle', () => {
  it('invalidates all queries when the state goes from syncing to a settled status', () => {
    const spy = vi.spyOn(client, 'invalidateQueries')
    renderRunner()

    emitFamily({ type: 'state', state: state('syncing') })
    expect(spy).not.toHaveBeenCalled()
    emitFamily({ type: 'state', state: state('synced') })

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not invalidate for a settled status that did not follow syncing', () => {
    const spy = vi.spyOn(client, 'invalidateQueries')
    renderRunner()

    emitFamily({ type: 'state', state: state('synced') })
    emitFamily({ type: 'state', state: state('offline') })

    expect(spy).not.toHaveBeenCalled()
  })

  it('also invalidates when syncing ends in an error', () => {
    const spy = vi.spyOn(client, 'invalidateQueries')
    renderRunner()

    emitFamily({ type: 'state', state: state('syncing') })
    emitFamily({ type: 'state', state: state('error') })

    expect(spy).toHaveBeenCalledTimes(1)
  })
})
