// CONTRACT_GAP: the toast options object is asserted by its action label and
//   onClick only (plan section 5, New-entries toast); other options are free.
//
// SyncRunner turns a Family `new-entries` event into one toast with an Open
// action, unless the user is already looking at that space.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { Lang } from '@/i18n/lang'
import type { FamilyStreamEvent, FamilySyncState } from '@/lib/sync/types'
import { plural, setLang, translate } from '@/i18n/core'
import { useAccountSession, useAccountsVisible } from '@/lib/accountSession'
import { getSyncRuntime } from '@/lib/sync/runtime'
import { SpaceSwitchProvider } from '@/lib/spaces/switcher'
import { SyncRunner } from '@/components/SyncRunner'

const { toastFn, engine, family, setUserId } = vi.hoisted(() => ({
  toastFn: vi.fn(),
  engine: { start: vi.fn(), stop: vi.fn(), onEvent: vi.fn() },
  family: { onEvent: vi.fn() },
  setUserId: vi.fn(),
}))

vi.mock('@/lib/featureFlags', () => ({ ENABLE_ACCOUNTS: true, ENABLE_SYNC: true, ENABLE_SPACES: true }))
vi.mock('sonner', () => ({
  toast: Object.assign(toastFn, { success: vi.fn(), error: vi.fn() }),
}))
vi.mock('@/lib/accountSession', () => ({
  useAccountsVisible: vi.fn(),
  useAccountSession: vi.fn(),
}))
vi.mock('@/lib/dataProblem', () => ({ reportDataProblem: vi.fn() }))
vi.mock('@/lib/sync/runtime', () => ({ getSyncRuntime: vi.fn() }))

const SPACE = 'fam-1'
const FAMILY = { id: SPACE, name: 'Our home', role: 'owner' as const, readOnly: false }

let client: QueryClient
const switchTo = vi.fn()

function state(status: FamilySyncState['status']): FamilySyncState {
  return {
    status,
    spaceId: SPACE,
    role: 'owner',
    name: 'Our home',
    readOnly: false,
    space: null,
    lastSyncAt: null,
    progress: null,
    errorCode: null,
    lastError: null,
    pendingOwnerEmail: null,
  }
}

function tree(spaceId: string): ReactNode {
  return (
    <QueryClientProvider client={client}>
      <SpaceSwitchProvider value={{ spaceId, family: FAMILY, switchTo }}>
        <SyncRunner unlocked />
      </SpaceSwitchProvider>
    </QueryClientProvider>
  )
}

function emit(event: FamilyStreamEvent) {
  const listener = family.onEvent.mock.calls.at(-1)?.[0] as ((e: FamilyStreamEvent) => void) | undefined
  if (!listener) throw new Error('the runner did not subscribe to Family events')
  listener(event)
}

beforeEach(() => {
  vi.resetAllMocks()
  client = new QueryClient()
  setLang('en', { persist: false })
  vi.mocked(useAccountsVisible).mockReturnValue(true)
  vi.mocked(useAccountSession).mockReturnValue({ userId: 'u-me', email: 'me@example.com' })
  vi.mocked(getSyncRuntime).mockReturnValue({ engine, actions: {}, family, familyActions: {}, setUserId } as never)
  engine.onEvent.mockReturnValue(vi.fn())
  family.onEvent.mockReturnValue(vi.fn())
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe.each<Lang>(['en', 'uk'])('new entries while viewing Personal (%s)', (lang) => {
  beforeEach(() => setLang(lang, { persist: false }))

  it('toasts the count and the Family name with an Open action that switches', () => {
    render(tree('personal'))

    emit({ type: 'new-entries', spaceId: SPACE, count: 3 })

    expect(toastFn).toHaveBeenCalledTimes(1)
    const [message, options] = toastFn.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }]
    expect(message).toBe(plural('space.newEntries', 3, { name: 'Our home' }))
    expect(message).toContain('Our home')
    expect(options.action.label).toBe(translate(lang, 'space.open'))
    expect(switchTo).not.toHaveBeenCalled()
    options.action.onClick()
    expect(switchTo).toHaveBeenCalledWith(SPACE)
  })

  it('a different count gives a different message', () => {
    render(tree('personal'))

    emit({ type: 'new-entries', spaceId: SPACE, count: 1 })
    emit({ type: 'new-entries', spaceId: SPACE, count: 5 })

    expect(toastFn.mock.calls[0][0]).not.toBe(toastFn.mock.calls[1][0])
  })
})

describe('new entries while already viewing that space', () => {
  it('shows no toast', () => {
    render(tree(SPACE))

    emit({ type: 'new-entries', spaceId: SPACE, count: 4 })

    expect(toastFn).not.toHaveBeenCalled()
  })

  it('reads the active space at event time, not at subscribe time', () => {
    const view = render(tree('personal'))
    view.rerender(tree(SPACE))

    emit({ type: 'new-entries', spaceId: SPACE, count: 2 })

    expect(toastFn).not.toHaveBeenCalled()
  })
})

describe('other Family events keep today’s handling', () => {
  it('a state event does not toast and still refreshes after syncing', () => {
    const spy = vi.spyOn(client, 'invalidateQueries')
    render(tree('personal'))

    emit({ type: 'state', state: state('syncing') })
    emit({ type: 'state', state: state('synced') })

    expect(toastFn).not.toHaveBeenCalled()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a joined event still toasts the join message', () => {
    render(tree('personal'))

    emit({ type: 'joined', spaceId: SPACE, name: 'Our home' })

    expect(toastFn).toHaveBeenCalledWith(translate('en', 'family.toast.joined', { name: 'Our home' }))
  })

  it('a new-entries event does not invalidate queries or look like a state change', () => {
    const spy = vi.spyOn(client, 'invalidateQueries')
    render(tree('personal'))

    emit({ type: 'state', state: state('syncing') })
    emit({ type: 'new-entries', spaceId: SPACE, count: 2 })
    emit({ type: 'state', state: state('synced') })

    expect(spy).toHaveBeenCalledTimes(1)
  })
})
