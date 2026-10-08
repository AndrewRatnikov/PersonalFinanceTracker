// No CONTRACT_GAPs: InstallHintCard selectors and mocks are fully specified in
// the Interface Contract (component: InstallHintCard).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getAppSettings, updateAppSettings } from '@/lib/appSettings'
import { shouldShowInstallHint } from '@/lib/installHint'
import { InstallHintCard } from '@/components/InstallHintCard'

vi.mock('@/lib/installHint', () => ({ shouldShowInstallHint: vi.fn() }))
vi.mock('@/lib/appSettings', () => ({
  APP_SETTINGS_QUERY_KEY: ['settings'],
  getAppSettings: vi.fn(),
  updateAppSettings: vi.fn(),
}))

const SETTINGS = {
  autoLockMinutes: 15,
  installHintDismissed: false,
  persistRequestedAt: null,
}

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <InstallHintCard />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(shouldShowInstallHint).mockReturnValue(true)
  vi.mocked(getAppSettings).mockResolvedValue(SETTINGS)
  vi.mocked(updateAppSettings).mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe('InstallHintCard', () => {
  it('shows the card on iOS Safari when not dismissed', async () => {
    renderCard()

    const card = await screen.findByTestId('install-hint')
    expect(card.textContent).toContain('Add to Home Screen')
    expect(screen.getByTestId('install-hint-dismiss')).toBeTruthy()
  })

  it('renders nothing when the environment is not iOS Safari', async () => {
    vi.mocked(shouldShowInstallHint).mockReturnValue(false)
    renderCard()

    await Promise.resolve()
    expect(screen.queryByTestId('install-hint')).toBeNull()
    expect(getAppSettings).not.toHaveBeenCalled()
  })

  it('renders nothing when the hint was dismissed before', async () => {
    vi.mocked(getAppSettings).mockResolvedValue({
      ...SETTINGS,
      installHintDismissed: true,
    })
    renderCard()

    await waitFor(() => {
      expect(getAppSettings).toHaveBeenCalled()
    })
    await Promise.resolve()
    expect(screen.queryByTestId('install-hint')).toBeNull()
  })

  it('hides at once on Dismiss and stores installHintDismissed', async () => {
    renderCard()
    await screen.findByTestId('install-hint')

    fireEvent.click(screen.getByTestId('install-hint-dismiss'))

    expect(screen.queryByTestId('install-hint')).toBeNull()
    await waitFor(() => {
      expect(updateAppSettings).toHaveBeenCalledWith({
        installHintDismissed: true,
      })
    })
    expect(updateAppSettings).toHaveBeenCalledTimes(1)
  })

  it('refreshes the settings query after dismissing', async () => {
    renderCard()
    await screen.findByTestId('install-hint')
    expect(getAppSettings).toHaveBeenCalledTimes(1)

    vi.mocked(getAppSettings).mockResolvedValue({
      ...SETTINGS,
      installHintDismissed: true,
    })
    fireEvent.click(screen.getByTestId('install-hint-dismiss'))

    await waitFor(() => {
      expect(getAppSettings).toHaveBeenCalledTimes(2)
    })
    expect(screen.queryByTestId('install-hint')).toBeNull()
  })
})
