// No CONTRACT_GAPs: StorageStatusCard selectors and dependencies are fully
// specified in the Interface Contract (component: StorageStatusCard).

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { InstallEnv } from '@/lib/installHint'
import { bestEffortHint, currentInstallEnv } from '@/lib/installHint'
import { formatBytes, getStorageStatus } from '@/lib/storagePersistence'
import { StorageStatusCard } from '@/components/settings/StorageStatusCard'

vi.mock('@/lib/storagePersistence', () => ({
  getStorageStatus: vi.fn(),
  formatBytes: vi.fn(),
}))
vi.mock('@/lib/installHint', () => ({
  currentInstallEnv: vi.fn(),
  bestEffortHint: vi.fn(),
}))

const ENV: InstallEnv = {
  userAgent: 'test-agent',
  maxTouchPoints: 0,
  navigatorStandalone: false,
  displayModeStandalone: false,
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(formatBytes).mockImplementation((n) => `fmt(${n})`)
  vi.mocked(currentInstallEnv).mockReturnValue(ENV)
  vi.mocked(bestEffortHint).mockReturnValue('Install it, please')
})

afterEach(() => {
  cleanup()
})

describe('StorageStatusCard', () => {
  it('shows Protected with no hint when storage is persisted', async () => {
    vi.mocked(getStorageStatus).mockResolvedValue({
      persisted: true,
      usage: null,
      quota: null,
    })
    render(<StorageStatusCard />)

    await waitFor(() => {
      expect(screen.getByTestId('storage-status-label').textContent).toBe(
        'Protected',
      )
    })
    expect(screen.getByTestId('storage-status')).toBeTruthy()
    expect(screen.queryByTestId('storage-status-hint')).toBeNull()
  })

  it('shows Best-effort with the install hint when storage is not persisted', async () => {
    vi.mocked(getStorageStatus).mockResolvedValue({
      persisted: false,
      usage: null,
      quota: null,
    })
    render(<StorageStatusCard />)

    await waitFor(() => {
      expect(screen.getByTestId('storage-status-label').textContent).toBe(
        'Best-effort',
      )
    })
    expect(screen.getByTestId('storage-status-hint').textContent).toBe(
      'Install it, please',
    )
    expect(bestEffortHint).toHaveBeenCalledWith(ENV)
  })

  it('shows usage and quota when both are known', async () => {
    vi.mocked(getStorageStatus).mockResolvedValue({
      persisted: true,
      usage: 1536,
      quota: 1048576,
    })
    render(<StorageStatusCard />)

    await waitFor(() => {
      expect(screen.getByTestId('storage-status-usage').textContent).toBe(
        'Using fmt(1536) of fmt(1048576)',
      )
    })
    expect(formatBytes).toHaveBeenCalledWith(1536)
    expect(formatBytes).toHaveBeenCalledWith(1048576)
  })

  it('shows usage alone when the quota is unknown', async () => {
    vi.mocked(getStorageStatus).mockResolvedValue({
      persisted: true,
      usage: 2048,
      quota: null,
    })
    render(<StorageStatusCard />)

    await waitFor(() => {
      expect(screen.getByTestId('storage-status-usage').textContent).toBe(
        'Using fmt(2048)',
      )
    })
  })

  it('omits the usage line when usage is unknown', async () => {
    vi.mocked(getStorageStatus).mockResolvedValue({
      persisted: true,
      usage: null,
      quota: 1048576,
    })
    render(<StorageStatusCard />)

    await waitFor(() => {
      expect(screen.getByTestId('storage-status-label').textContent).toBe(
        'Protected',
      )
    })
    expect(screen.queryByTestId('storage-status-usage')).toBeNull()
  })
})
