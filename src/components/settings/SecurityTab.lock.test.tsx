// No CONTRACT_GAPs: SecurityTab and lock-now-btn are in the Interface Contract.
// Uses the real @/lib/vaultSession with an injected sync channel.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncChannel } from '@/lib/syncChannel'
import { getAppSettings } from '@/lib/appSettings'
import { setSyncChannel } from '@/lib/syncChannel'
import { lockVault } from '@/lib/vault'
import { getVaultSession, setVaultPhase } from '@/lib/vaultSession'
import { SecurityTab } from '@/components/settings/SecurityTab'

vi.mock('@/lib/vault', () => ({
  changePassword: vi.fn(),
  regenerateRecoveryKey: vi.fn(),
  lockVault: vi.fn(),
  VaultError: class VaultError extends Error {},
}))
vi.mock('@/lib/appSettings', () => ({
  APP_SETTINGS_QUERY_KEY: ['settings'],
  AUTO_LOCK_OPTIONS: [0, 1, 5, 15, 60],
  DEFAULT_AUTO_LOCK_MINUTES: 15,
  getAppSettings: vi.fn(),
  updateAppSettings: vi.fn(),
}))

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
  vi.mocked(getAppSettings).mockResolvedValue({
    autoLockMinutes: 15,
    installHintDismissed: false,
    persistRequestedAt: null,
    recoveryKeyConfirmed: true,
  })
  setVaultPhase('unlocked')
})

afterEach(() => {
  cleanup()
  setSyncChannel(undefined)
})

describe('SecurityTab Lock now (real vaultSession)', () => {
  it("locks this tab and posts exactly one { type: 'lock' } message", () => {
    const channel = fakeChannel()
    setSyncChannel(channel)
    const client = new QueryClient()
    const clear = vi.spyOn(client, 'clear')
    render(
      <QueryClientProvider client={client}>
        <SecurityTab />
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByTestId('lock-now-btn'))

    expect(lockVault).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(getVaultSession().phase).toBe('locked')
    expect(channel.postMessage).toHaveBeenCalledTimes(1)
    expect(channel.postMessage).toHaveBeenCalledWith({ type: 'lock' })
  })

  it('posts nothing until Lock now is clicked', () => {
    const channel = fakeChannel()
    setSyncChannel(channel)
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SecurityTab />
      </QueryClientProvider>,
    )

    expect(channel.postMessage).not.toHaveBeenCalled()
    expect(getVaultSession().phase).toBe('unlocked')
  })
})
