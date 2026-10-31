// CONTRACT_GAP: the shape of the entries returned by listLocalSpaces and of
//   FamilySyncState.space.members is not spelled out in the contract; fixtures
//   use { id, name, role } and { user_id, status } and are cast.
// CONTRACT_GAP: the label of the discard confirm buttons is not asserted; they
//   are found by their testids (space-switch-confirm-discard / -cancel).
//
// ActiveSpaceRoot (plan section 1): flags off / locked / no Family give the
// default context and run no data function; the start space follows "Open the
// app in"; switching is per tab and stored as the shared default; the drawer
// guard asks before switching.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { getOpenAppIn } from '@/lib/appSettings'
import { getMemberProfiles, getSpaceInfo, listLocalSpaces } from '@/lib/localDb'
import { ACTIVE_SPACE_STORAGE_KEY } from '@/lib/spaces/activeSpace'
import { getCurrentMemberId } from '@/lib/spaces/member'
import { useActiveSpace } from '@/lib/spaces/react'
import {
  ActiveSpaceRoot,
  SpaceReadyGate,
  SpaceSwitchProvider,
  useSpaceAccess,
  useSpaceSwitch,
  useSwitchGuard,
} from '@/lib/spaces/switcher'

const h = vi.hoisted(() => ({
  available: true,
  held: new Set<string>(),
  readOnly: false,
  famState: { status: 'synced', spaceId: 'fam-1', name: 'Our home', readOnly: false } as Record<string, unknown>,
  syncState: { status: 'synced', readOnly: false, space: null } as Record<string, unknown>,
}))

vi.mock('@/lib/featureFlags', () => ({ ENABLE_ACCOUNTS: true, ENABLE_SYNC: true, ENABLE_SPACES: true }))
vi.mock('@/lib/sync/react', () => ({
  useFamilyAvailable: () => h.available,
  useFamilySyncState: () => h.famState,
  useSyncState: () => h.syncState,
}))
vi.mock('@/lib/localDb', () => ({
  listLocalSpaces: vi.fn(),
  getSpaceInfo: vi.fn(),
  getMemberProfiles: vi.fn(),
  spaceDb: vi.fn(),
}))
vi.mock('@/lib/spaces/keyring', () => ({
  isSpaceHeld: (id: string) => h.held.has(id),
  isSpaceReadOnly: () => h.readOnly,
}))
vi.mock('@/lib/spaces/member', () => ({
  getCurrentMemberId: vi.fn(),
  memberColor: () => 'var(--chart-1)',
  MEMBER_COLORS: ['var(--chart-1)'],
}))
vi.mock('@/lib/appSettings', () => ({
  getOpenAppIn: vi.fn(),
  setOpenAppIn: vi.fn(),
  OPEN_APP_IN_QUERY_KEY: ['settings', 'open-app-in'],
}))

const FAM = 'fam-1'

function Probe({ id = 'probe' }: { id?: string }) {
  const s = useSpaceSwitch()
  const access = useSpaceAccess()
  const providerSpace = useActiveSpace()
  return (
    <div
      data-probe={id}
      data-space={s.spaceId}
      data-provider-space={providerSpace}
      data-family={s.family?.id ?? ''}
      data-family-name={s.family?.name ?? ''}
      data-is-family={String(s.isFamily)}
      data-ready={String(s.ready)}
      data-readonly={String(access.readOnly)}
      data-paused={String(access.paused)}
      data-directory={s.directory ? s.directory.members.map((m) => `${m.id}:${m.active}`).join(',') : 'null'}
      data-member={s.memberId ?? ''}
    >
      <button data-probe={`${id}-to-family`} onClick={() => s.switchTo(FAM)} />
      <button data-probe={`${id}-to-personal`} onClick={() => s.switchTo('personal')} />
      <button data-probe={`${id}-to-bogus`} onClick={() => s.switchTo('other-space')} />
    </div>
  )
}

function Guarded({ dirty, close, active = true }: { dirty: boolean; close: () => void; active?: boolean }) {
  useSwitchGuard(active, { isDirty: () => dirty, close })
  return null
}

function renderRoot(children: ReactNode, unlocked = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (
    <QueryClientProvider client={client}>
      <ActiveSpaceRoot unlocked={unlocked}>
        <SpaceReadyGate>{children}</SpaceReadyGate>
      </ActiveSpaceRoot>
    </QueryClientProvider>
  )
  const view = render(tree)
  return { ...view, client, again: () => view.rerender(tree) }
}

function queryProbe(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-probe="${id}"]`)
}

function byProbe(id: string): HTMLElement {
  const el = queryProbe(id)
  if (!el) throw new Error(`probe element not found: ${id}`)
  return el
}

function probe(id = 'probe') {
  return byProbe(id)
}

async function settled(id = 'probe') {
  return waitFor(() => {
    probe(id)
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  h.available = true
  h.held = new Set([FAM])
  h.readOnly = false
  h.famState = { status: 'synced', spaceId: FAM, name: 'Our home', readOnly: false }
  h.syncState = { status: 'synced', readOnly: false, space: null }
  vi.mocked(listLocalSpaces).mockResolvedValue([{ id: FAM, name: 'Stale name', role: 'owner' }] as never)
  vi.mocked(getSpaceInfo).mockResolvedValue({ id: 'space', name: 'Our home' } as never)
  vi.mocked(getMemberProfiles).mockResolvedValue([
    { id: 'u-me', displayName: 'Andrii', color: 'var(--chart-1)' },
    { id: 'u-left', displayName: 'Maksym', color: 'var(--chart-2)' },
  ] as never)
  vi.mocked(getCurrentMemberId).mockResolvedValue('u-me')
  vi.mocked(getOpenAppIn).mockResolvedValue('last')
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('no Family: the default context and no data call', () => {
  it('flags off (family not available): personal, no family, ready at once', async () => {
    h.available = false

    renderRoot(<Probe />)

    await settled()
    expect(probe().getAttribute('data-space')).toBe('personal')
    expect(probe().getAttribute('data-family')).toBe('')
    expect(probe().getAttribute('data-ready')).toBe('true')
    expect(probe().getAttribute('data-directory')).toBe('null')
    expect(listLocalSpaces).not.toHaveBeenCalled()
    expect(getSpaceInfo).not.toHaveBeenCalled()
    expect(getMemberProfiles).not.toHaveBeenCalled()
    expect(getCurrentMemberId).not.toHaveBeenCalled()
    expect(getOpenAppIn).not.toHaveBeenCalled()
  })

  it('locked: personal and no data call', async () => {
    renderRoot(<Probe />, false)

    await settled()
    expect(probe().getAttribute('data-family')).toBe('')
    expect(probe().getAttribute('data-space')).toBe('personal')
    expect(listLocalSpaces).not.toHaveBeenCalled()
  })

  it('unlocked, flags on, but no Family held: family is null', async () => {
    vi.mocked(listLocalSpaces).mockResolvedValue([])

    renderRoot(<Probe />)

    await waitFor(() => expect(listLocalSpaces).toHaveBeenCalled())
    await settled()
    expect(probe().getAttribute('data-family')).toBe('')
    expect(probe().getAttribute('data-space')).toBe('personal')
    expect(probe().getAttribute('data-is-family')).toBe('false')
  })

  it('the default context without any provider is the same', () => {
    render(<Probe />)

    expect(probe().getAttribute('data-space')).toBe('personal')
    expect(probe().getAttribute('data-family')).toBe('')
    expect(probe().getAttribute('data-ready')).toBe('true')
    expect(probe().getAttribute('data-readonly')).toBe('false')
    expect(probe().getAttribute('data-paused')).toBe('false')
  })
})

describe('the Family summary', () => {
  it('uses the space info name over the stored entry name', async () => {
    renderRoot(<Probe />)

    await waitFor(() => expect(probe().getAttribute('data-family')).toBe(FAM))
    expect(probe().getAttribute('data-family-name')).toBe('Our home')
  })

  it('falls back to the entry name when the name read fails', async () => {
    vi.mocked(getSpaceInfo).mockRejectedValue(new Error('locked'))

    renderRoot(<Probe />)

    await waitFor(() => expect(probe().getAttribute('data-family')).toBe(FAM))
    expect(probe().getAttribute('data-family-name')).toBe('Stale name')
  })
})

describe('the start space', () => {
  it('"Family" opens in the Family without touching the stored default', async () => {
    vi.mocked(getOpenAppIn).mockResolvedValue('family')

    renderRoot(<Probe />)

    await waitFor(() => expect(probe().getAttribute('data-space')).toBe(FAM))
    expect(probe().getAttribute('data-provider-space')).toBe(FAM)
    expect(localStorage.getItem(ACTIVE_SPACE_STORAGE_KEY)).toBeNull()
  })

  it('"Personal" opens in Personal even when Family was used last', async () => {
    localStorage.setItem(ACTIVE_SPACE_STORAGE_KEY, FAM)
    vi.mocked(getOpenAppIn).mockResolvedValue('personal')

    renderRoot(<Probe />)

    await waitFor(() => expect(probe().getAttribute('data-family')).toBe(FAM))
    expect(probe().getAttribute('data-space')).toBe('personal')
  })

  it('"Last used" opens in the stored Family, and in Personal when nothing was stored', async () => {
    localStorage.setItem(ACTIVE_SPACE_STORAGE_KEY, FAM)
    const first = renderRoot(<Probe />)
    await waitFor(() => expect(probe().getAttribute('data-space')).toBe(FAM))
    first.unmount()

    localStorage.clear()
    renderRoot(<Probe />)
    await waitFor(() => expect(probe().getAttribute('data-family')).toBe(FAM))
    expect(probe().getAttribute('data-space')).toBe('personal')
  })

  it('children wait behind the ready gate until the family query settles', async () => {
    let resolve: (v: never) => void = () => undefined
    vi.mocked(listLocalSpaces).mockReturnValue(new Promise((r) => (resolve = r as never)))

    renderRoot(<Probe />)

    expect(queryProbe('probe')).toBeNull()
    await act(async () => {
      resolve([{ id: FAM, name: 'Stale', role: 'owner' }] as never)
      await Promise.resolve()
    })
    await waitFor(() => expect(probe().getAttribute('data-ready')).toBe('true'))
  })
})

describe('switching', () => {
  it('switches, stores the shared default, and switches back', async () => {
    renderRoot(<Probe />)
    await waitFor(() => expect(probe().getAttribute('data-family')).toBe(FAM))

    fireEvent.click(byProbe('probe-to-family'))
    expect(probe().getAttribute('data-space')).toBe(FAM)
    expect(probe().getAttribute('data-is-family')).toBe('true')
    expect(localStorage.getItem(ACTIVE_SPACE_STORAGE_KEY)).toBe(FAM)

    fireEvent.click(byProbe('probe-to-personal'))
    expect(probe().getAttribute('data-space')).toBe('personal')
    expect(localStorage.getItem(ACTIVE_SPACE_STORAGE_KEY)).toBe('personal')
  })

  it('ignores an id that is neither personal nor the Family', async () => {
    renderRoot(<Probe />)
    await waitFor(() => expect(probe().getAttribute('data-family')).toBe(FAM))

    fireEvent.click(byProbe('probe-to-bogus'))

    expect(probe().getAttribute('data-space')).toBe('personal')
    expect(localStorage.getItem(ACTIVE_SPACE_STORAGE_KEY)).toBeNull()
  })

  it('falls back to Personal when the Family disappears', async () => {
    const view = renderRoot(<Probe />)
    await waitFor(() => expect(probe().getAttribute('data-family')).toBe(FAM))
    fireEvent.click(byProbe('probe-to-family'))
    expect(probe().getAttribute('data-space')).toBe(FAM)

    vi.mocked(listLocalSpaces).mockResolvedValue([])
    h.famState = { status: 'removed', spaceId: null, name: null, readOnly: false }
    view.again()

    await waitFor(() => expect(probe().getAttribute('data-family')).toBe(''))
    expect(probe().getAttribute('data-space')).toBe('personal')
    expect(probe().getAttribute('data-provider-space')).toBe('personal')
  })

  it('is per tab: another root does not follow, a later root starts from the stored default', async () => {
    const a = renderRoot(
      <>
        <Probe id="a" />
      </>,
    )
    await waitFor(() => expect(probe('a').getAttribute('data-family')).toBe(FAM))
    const b = renderRoot(<Probe id="b" />)
    await waitFor(() => expect(probe('b').getAttribute('data-family')).toBe(FAM))

    fireEvent.click(byProbe('a-to-family'))

    expect(probe('a').getAttribute('data-space')).toBe(FAM)
    expect(probe('b').getAttribute('data-space')).toBe('personal')
    expect(localStorage.getItem(ACTIVE_SPACE_STORAGE_KEY)).toBe(FAM)
    window.dispatchEvent(new StorageEvent('storage', { key: ACTIVE_SPACE_STORAGE_KEY, newValue: FAM }))
    expect(probe('b').getAttribute('data-space')).toBe('personal')

    renderRoot(<Probe id="c" />)
    await waitFor(() => expect(probe('c').getAttribute('data-space')).toBe(FAM))
    a.unmount()
    b.unmount()
  })
})

describe('access and members in the Family', () => {
  async function inFamily() {
    renderRoot(<Probe />)
    await waitFor(() => expect(probe().getAttribute('data-family')).toBe(FAM))
    fireEvent.click(byProbe('probe-to-family'))
  }

  it('paused: paused true, still editable', async () => {
    h.syncState = { status: 'paused', readOnly: false, space: null }
    await inFamily()

    expect(probe().getAttribute('data-paused')).toBe('true')
    expect(probe().getAttribute('data-readonly')).toBe('false')
  })

  it('read-only when the sync state says removed, space-gone or readOnly, or the keyring says so', async () => {
    for (const patch of [
      { status: 'removed' },
      { status: 'space-gone' },
      { status: 'synced', readOnly: true },
    ]) {
      h.syncState = { readOnly: false, space: null, ...patch }
      const { unmount } = renderRoot(<Probe />)
      await waitFor(() => expect(probe().getAttribute('data-family')).toBe(FAM))
      fireEvent.click(byProbe('probe-to-family'))
      expect(probe().getAttribute('data-readonly')).toBe('true')
      expect(probe().getAttribute('data-paused')).toBe('false')
      unmount()
    }

    h.syncState = { status: 'synced', readOnly: false, space: null }
    h.readOnly = true
    await inFamily()
    expect(probe().getAttribute('data-readonly')).toBe('true')
  })

  it('a healthy Family is neither read-only nor paused, and Personal is never read-only', async () => {
    h.syncState = { status: 'removed', readOnly: true, space: null }
    renderRoot(<Probe />)
    await waitFor(() => expect(probe().getAttribute('data-family')).toBe(FAM))

    expect(probe().getAttribute('data-space')).toBe('personal')
    expect(probe().getAttribute('data-readonly')).toBe('false')
    expect(probe().getAttribute('data-paused')).toBe('false')
  })

  it('the directory exists only in the Family, flags former members and knows me', async () => {
    h.syncState = {
      status: 'synced',
      readOnly: false,
      space: { members: [{ user_id: 'u-me', status: 'active' }, { user_id: 'u-left', status: 'removed' }] },
    }
    renderRoot(<Probe />)
    await waitFor(() => expect(probe().getAttribute('data-family')).toBe(FAM))
    expect(probe().getAttribute('data-directory')).toBe('null')

    fireEvent.click(byProbe('probe-to-family'))

    await waitFor(() => expect(probe().getAttribute('data-directory')).not.toBe('null'))
    expect(probe().getAttribute('data-directory')).toBe('u-me:true,u-left:false')
    await waitFor(() => expect(probe().getAttribute('data-member')).toBe('u-me'))
  })

  it('with an unknown member list every profile counts as active', async () => {
    await inFamily()

    await waitFor(() => expect(probe().getAttribute('data-directory')).toContain('u-left:true'))
  })
})

describe('the drawer guard', () => {
  async function setup(dirty: boolean) {
    const close = vi.fn()
    renderRoot(
      <>
        <Probe />
        <Guarded dirty={dirty} close={close} />
      </>,
    )
    await waitFor(() => expect(probe().getAttribute('data-family')).toBe(FAM))
    return close
  }

  it('a clean guard is closed and the switch happens without a confirm', async () => {
    const close = await setup(false)

    fireEvent.click(byProbe('probe-to-family'))

    expect(close).toHaveBeenCalledTimes(1)
    expect(probe().getAttribute('data-space')).toBe(FAM)
    expect(screen.queryByTestId('space-switch-confirm')).toBeNull()
  })

  it('a dirty guard asks first; Cancel keeps everything', async () => {
    const close = await setup(true)

    fireEvent.click(byProbe('probe-to-family'))

    expect(screen.getByTestId('space-switch-confirm')).toBeTruthy()
    expect(probe().getAttribute('data-space')).toBe('personal')
    fireEvent.click(screen.getByTestId('space-switch-confirm-cancel'))
    expect(close).not.toHaveBeenCalled()
    expect(probe().getAttribute('data-space')).toBe('personal')
    expect(localStorage.getItem(ACTIVE_SPACE_STORAGE_KEY)).toBeNull()
  })

  it('a dirty guard: Discard closes the drawer and then switches', async () => {
    const close = await setup(true)

    fireEvent.click(byProbe('probe-to-family'))
    fireEvent.click(screen.getByTestId('space-switch-confirm-discard'))

    expect(close).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(probe().getAttribute('data-space')).toBe(FAM))
    expect(localStorage.getItem(ACTIVE_SPACE_STORAGE_KEY)).toBe(FAM)
  })

  it('an inactive guard is not registered', async () => {
    const close = vi.fn()
    renderRoot(
      <>
        <Probe />
        <Guarded dirty active={false} close={close} />
      </>,
    )
    await waitFor(() => expect(probe().getAttribute('data-family')).toBe(FAM))

    fireEvent.click(byProbe('probe-to-family'))

    expect(screen.queryByTestId('space-switch-confirm')).toBeNull()
    expect(close).not.toHaveBeenCalled()
    expect(probe().getAttribute('data-space')).toBe(FAM)
  })

  it('switching to the space that is already active does nothing', async () => {
    const close = await setup(true)

    fireEvent.click(byProbe('probe-to-personal'))

    expect(screen.queryByTestId('space-switch-confirm')).toBeNull()
    expect(close).not.toHaveBeenCalled()
  })
})

describe('SpaceSwitchProvider (test provider)', () => {
  it('fills the defaults and provides the space to the data hooks', () => {
    render(
      <SpaceSwitchProvider
        value={{ spaceId: FAM, family: { id: FAM, name: 'Our home', role: 'owner', readOnly: false } }}
      >
        <Probe />
      </SpaceSwitchProvider>,
    )

    expect(probe().getAttribute('data-space')).toBe(FAM)
    expect(probe().getAttribute('data-provider-space')).toBe(FAM)
    expect(probe().getAttribute('data-is-family')).toBe('true')
    expect(probe().getAttribute('data-ready')).toBe('true')
    expect(probe().getAttribute('data-readonly')).toBe('false')
  })

  it('isFamily is false for personal even with a family, and flags pass through', () => {
    render(
      <SpaceSwitchProvider
        value={{
          spaceId: 'personal',
          family: { id: FAM, name: 'Our home', role: 'owner', readOnly: false },
          readOnly: true,
          paused: true,
        }}
      >
        <Probe />
      </SpaceSwitchProvider>,
    )

    expect(probe().getAttribute('data-is-family')).toBe('false')
    expect(probe().getAttribute('data-readonly')).toBe('true')
    expect(probe().getAttribute('data-paused')).toBe('true')
  })
})
