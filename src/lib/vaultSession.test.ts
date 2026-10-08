// No CONTRACT_GAPs: vaultSession exports and test notes are fully specified in
// the Interface Contract (module: vaultSession).

import { QueryClient } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncChannel } from '@/lib/syncChannel'
import { reloadToHome } from '@/lib/localWipe'
import { setSyncChannel } from '@/lib/syncChannel'
import { lockVault } from '@/lib/vault'
import {
  DATA_ROUTES,
  cancelCreateVault,
  computeGate,
  connectOtherTabs,
  getVaultSession,
  isDataRoute,
  lockApp,
  phaseForVaultState,
  requestCreateVault,
  setVaultPhase,
  subscribeVaultSession,
  useVaultSession,
} from '@/lib/vaultSession'

vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))
vi.mock('@/lib/localWipe', () => ({ reloadToHome: vi.fn() }))

function fakeChannel() {
  return {
    postMessage: vi.fn<SyncChannel['postMessage']>(),
    addEventListener: vi.fn<SyncChannel['addEventListener']>(),
    removeEventListener: vi.fn<SyncChannel['removeEventListener']>(),
    close: vi.fn<SyncChannel['close']>(),
  }
}

function fire(channel: ReturnType<typeof fakeChannel>, data: unknown) {
  const listener = channel.addEventListener.mock.calls[0][1]
  listener(new MessageEvent('message', { data }))
}

beforeEach(() => {
  vi.mocked(lockVault).mockReset()
  vi.mocked(reloadToHome).mockReset()
  setVaultPhase('checking')
  cancelCreateVault()
})

afterEach(() => {
  setSyncChannel(undefined)
})

describe('isDataRoute', () => {
  it('lists the four data routes', () => {
    expect([...DATA_ROUTES].sort()).toEqual([
      '/analytics',
      '/income',
      '/settings',
      '/transactions',
    ])
  })

  it.each([
    '/analytics',
    '/transactions',
    '/income',
    '/settings',
    '/settings/security',
    '/transactions/abc',
  ])('is true for %s', (path) => {
    expect(isDataRoute(path)).toBe(true)
  })

  it.each([
    '/',
    '/login',
    '/auth/callback',
    '/profile',
    '/settingsfoo',
    '/incomes',
    '/foo/settings',
  ])('is false for %s', (path) => {
    expect(isDataRoute(path)).toBe(false)
  })
})

describe('phaseForVaultState', () => {
  it("maps 'none' to 'none'", () => {
    expect(phaseForVaultState('none')).toBe('none')
  })

  it.each(['v1', 'v2', 'orphaned'] as const)("maps '%s' to 'locked'", (s) => {
    expect(phaseForVaultState(s)).toBe('locked')
  })
})

describe('the vault session store', () => {
  it("starts from a known state after reset: 'checking' and no create request", () => {
    expect(getVaultSession()).toEqual({
      phase: 'checking',
      createRequested: false,
    })
  })

  it('setVaultPhase changes the phase', () => {
    setVaultPhase('locked')
    expect(getVaultSession().phase).toBe('locked')

    setVaultPhase('none')
    expect(getVaultSession().phase).toBe('none')
  })

  it('requestCreateVault and cancelCreateVault toggle createRequested', () => {
    setVaultPhase('none')

    requestCreateVault()
    expect(getVaultSession().createRequested).toBe(true)

    cancelCreateVault()
    expect(getVaultSession().createRequested).toBe(false)
  })

  it("setVaultPhase('unlocked') clears createRequested", () => {
    setVaultPhase('none')
    requestCreateVault()

    setVaultPhase('unlocked')

    expect(getVaultSession()).toEqual({
      phase: 'unlocked',
      createRequested: false,
    })
  })

  it("other phases keep createRequested", () => {
    requestCreateVault()
    setVaultPhase('none')

    expect(getVaultSession().createRequested).toBe(true)
  })

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeVaultSession(listener)

    setVaultPhase('locked')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    setVaultPhase('unlocked')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('useVaultSession re-renders with the new state', () => {
    const { result } = renderHook(() => useVaultSession())
    expect(result.current.phase).toBe('checking')

    act(() => {
      setVaultPhase('locked')
    })
    expect(result.current.phase).toBe('locked')

    act(() => {
      requestCreateVault()
    })
    expect(result.current.createRequested).toBe(true)
  })
})

describe('computeGate', () => {
  const base = {
    mounted: true,
    phase: 'unlocked' as const,
    createRequested: false,
    pathname: '/transactions',
  }

  it('shows no gate and keeps children before mount, whatever the phase', () => {
    for (const phase of ['checking', 'none', 'locked', 'unlocked'] as const) {
      expect(computeGate({ ...base, mounted: false, phase })).toEqual({
        showGate: false,
        showChildren: true,
      })
    }
  })

  it('shows the gate and hides data routes while locked', () => {
    expect(computeGate({ ...base, phase: 'locked' })).toEqual({
      showGate: true,
      showChildren: false,
    })
  })

  it('keeps non-data routes rendering under the gate while locked', () => {
    for (const pathname of ['/', '/login', '/auth/callback', '/profile']) {
      expect(computeGate({ ...base, phase: 'locked', pathname })).toEqual({
        showGate: true,
        showChildren: true,
      })
    }
  })

  it('shows nothing extra when unlocked', () => {
    expect(computeGate(base)).toEqual({ showGate: false, showChildren: true })
    expect(computeGate({ ...base, pathname: '/' })).toEqual({
      showGate: false,
      showChildren: true,
    })
  })

  it('shows no gate with no vault until creation is requested', () => {
    expect(computeGate({ ...base, phase: 'none' }).showGate).toBe(false)
    expect(
      computeGate({ ...base, phase: 'none', createRequested: true }).showGate,
    ).toBe(true)
  })

  it('hides data routes but not the landing page when there is no vault', () => {
    expect(computeGate({ ...base, phase: 'none' }).showChildren).toBe(false)
    expect(
      computeGate({ ...base, phase: 'none', pathname: '/' }).showChildren,
    ).toBe(true)
  })

  it('ignores createRequested outside the none phase', () => {
    expect(
      computeGate({ ...base, phase: 'unlocked', createRequested: true })
        .showGate,
    ).toBe(false)
    expect(
      computeGate({ ...base, phase: 'checking', createRequested: true })
        .showGate,
    ).toBe(false)
  })

  it('shows no gate while checking and hides data routes', () => {
    expect(computeGate({ ...base, phase: 'checking' })).toEqual({
      showGate: false,
      showChildren: false,
    })
    expect(computeGate({ ...base, phase: 'checking', pathname: '/' })).toEqual({
      showGate: false,
      showChildren: true,
    })
  })
})

describe('lockApp', () => {
  it('clears the key, empties the query cache and moves unlocked to locked', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(['income'], [{ id: 'i1' }])
    setVaultPhase('unlocked')

    lockApp(queryClient)

    expect(lockVault).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(['income'])).toBeUndefined()
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
    expect(getVaultSession().phase).toBe('locked')
  })

  it("broadcasts { type: 'lock' } by default", () => {
    const channel = fakeChannel()
    setSyncChannel(channel)
    setVaultPhase('unlocked')

    lockApp({ clear: vi.fn() })

    expect(channel.postMessage).toHaveBeenCalledTimes(1)
    expect(channel.postMessage).toHaveBeenCalledWith({ type: 'lock' })
  })

  it('does not broadcast when broadcast is false', () => {
    const channel = fakeChannel()
    setSyncChannel(channel)
    setVaultPhase('unlocked')

    lockApp({ clear: vi.fn() }, { broadcast: false })

    expect(channel.postMessage).not.toHaveBeenCalled()
    expect(lockVault).toHaveBeenCalledTimes(1)
    expect(getVaultSession().phase).toBe('locked')
  })

  it("never turns 'none' into 'locked'", () => {
    setVaultPhase('none')

    lockApp({ clear: vi.fn() })

    expect(getVaultSession().phase).toBe('none')
  })

  it('is idempotent when already locked', () => {
    const clear = vi.fn()
    setVaultPhase('locked')

    lockApp({ clear })
    lockApp({ clear })

    expect(getVaultSession().phase).toBe('locked')
    expect(clear).toHaveBeenCalledTimes(2)
  })
})

describe('connectOtherTabs', () => {
  it('locks this tab on a lock message without re-broadcasting', () => {
    const channel = fakeChannel()
    const clear = vi.fn()
    const onWiped = vi.fn()
    connectOtherTabs({ clear }, { channel, onWiped })
    setVaultPhase('unlocked')

    fire(channel, { type: 'lock' })

    expect(lockVault).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(getVaultSession().phase).toBe('locked')
    expect(channel.postMessage).not.toHaveBeenCalled()
    expect(onWiped).not.toHaveBeenCalled()
  })

  it('leaves phase none unchanged on a lock message', () => {
    const channel = fakeChannel()
    connectOtherTabs({ clear: vi.fn() }, { channel })
    setVaultPhase('none')

    fire(channel, { type: 'lock' })

    expect(getVaultSession().phase).toBe('none')
  })

  it('locks and then calls onWiped on a wiped message', () => {
    const channel = fakeChannel()
    const clear = vi.fn()
    const onWiped = vi.fn()
    connectOtherTabs({ clear }, { channel, onWiped })
    setVaultPhase('unlocked')

    fire(channel, { type: 'wiped' })

    expect(lockVault).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(onWiped).toHaveBeenCalledTimes(1)
    expect(channel.postMessage).not.toHaveBeenCalled()
    expect(
      vi.mocked(lockVault).mock.invocationCallOrder[0],
    ).toBeLessThan(onWiped.mock.invocationCallOrder[0])
  })

  it('reloads to the home page on wiped by default', () => {
    const channel = fakeChannel()
    connectOtherTabs({ clear: vi.fn() }, { channel })

    fire(channel, { type: 'wiped' })

    expect(reloadToHome).toHaveBeenCalledTimes(1)
  })

  it('does not reload on a plain lock message', () => {
    const channel = fakeChannel()
    connectOtherTabs({ clear: vi.fn() }, { channel })

    fire(channel, { type: 'lock' })

    expect(reloadToHome).not.toHaveBeenCalled()
  })

  it('returns an unsubscribe function that removes the listener', () => {
    const channel = fakeChannel()
    const unsubscribe = connectOtherTabs({ clear: vi.fn() }, { channel })
    const listener = channel.addEventListener.mock.calls[0][1]

    unsubscribe()

    expect(channel.removeEventListener).toHaveBeenCalledWith('message', listener)
  })

  it('uses the default sync channel when none is passed', () => {
    const channel = fakeChannel()
    setSyncChannel(channel)
    const clear = vi.fn()
    connectOtherTabs({ clear })
    setVaultPhase('unlocked')

    fire(channel, { type: 'lock' })

    expect(clear).toHaveBeenCalledTimes(1)
    expect(getVaultSession().phase).toBe('locked')
  })
})
