// No CONTRACT_GAPs: LockButton and header-lock-btn are in the Interface Contract.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncChannel } from '@/lib/syncChannel'
import { setSyncChannel } from '@/lib/syncChannel'
import { lockVault } from '@/lib/vault'
import { getVaultSession, setVaultPhase } from '@/lib/vaultSession'
import { LockButton } from '@/components/LockButton'

vi.mock('@/lib/vault', () => ({ lockVault: vi.fn() }))

function fakeChannel() {
  return {
    postMessage: vi.fn<SyncChannel['postMessage']>(),
    addEventListener: vi.fn<SyncChannel['addEventListener']>(),
    removeEventListener: vi.fn<SyncChannel['removeEventListener']>(),
    close: vi.fn<SyncChannel['close']>(),
  }
}

beforeEach(() => {
  vi.mocked(lockVault).mockReset()
  setVaultPhase('unlocked')
})

afterEach(() => {
  cleanup()
  setSyncChannel(undefined)
})

describe('LockButton', () => {
  it("locks this tab and posts exactly one { type: 'lock' } message", () => {
    const channel = fakeChannel()
    setSyncChannel(channel)
    const client = new QueryClient()
    const clear = vi.spyOn(client, 'clear')
    render(
      <QueryClientProvider client={client}>
        <LockButton />
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByTestId('header-lock-btn'))

    expect(lockVault).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(getVaultSession().phase).toBe('locked')
    expect(channel.postMessage).toHaveBeenCalledTimes(1)
    expect(channel.postMessage).toHaveBeenCalledWith({ type: 'lock' })
  })

  it('posts nothing before it is clicked', () => {
    const channel = fakeChannel()
    setSyncChannel(channel)
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LockButton />
      </QueryClientProvider>,
    )

    expect(channel.postMessage).not.toHaveBeenCalled()
    expect(getVaultSession().phase).toBe('unlocked')
  })
})
