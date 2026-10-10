// No CONTRACT_GAPs: RecoveryKeyBanner testids, texts and mocks are fully
// specified in the Interface Contract (component: RecoveryKeyBanner).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { getAppSettings } from '@/lib/appSettings'
import { RecoveryKeyBanner } from '@/components/index/RecoveryKeyBanner'

vi.mock('@/lib/appSettings', () => ({
  APP_SETTINGS_QUERY_KEY: ['settings'],
  getAppSettings: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...rest
  }: {
    to: string
    search?: { tab?: string }
    children?: ReactNode
  }) => (
    <a href={`${to}?tab=${search?.tab}`} {...rest}>
      {children}
    </a>
  ),
}))

const SETTINGS = {
  autoLockMinutes: 15,
  installHintDismissed: false,
  persistRequestedAt: null,
  recoveryKeyConfirmed: true,
}

function renderBanner() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <RecoveryKeyBanner />
    </QueryClientProvider>,
  )
  return { client, ...view }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getAppSettings).mockResolvedValue(SETTINGS)
})

afterEach(() => {
  cleanup()
})

describe('RecoveryKeyBanner', () => {
  it('shows the banner when recoveryKeyConfirmed is false', async () => {
    vi.mocked(getAppSettings).mockResolvedValue({
      ...SETTINGS,
      recoveryKeyConfirmed: false,
    })
    renderBanner()

    await screen.findByTestId('recovery-key-unconfirmed-banner')
    expect(screen.getByTestId('recovery-key-unconfirmed-text').textContent).toBe(
      "You haven't saved a recovery key for this device",
    )
  })

  it('has a "Create a new recovery key" link to /settings?tab=security', async () => {
    vi.mocked(getAppSettings).mockResolvedValue({
      ...SETTINGS,
      recoveryKeyConfirmed: false,
    })
    renderBanner()

    const action = await screen.findByTestId('recovery-key-unconfirmed-action')
    expect(action.textContent).toContain('Create a new recovery key')
    expect(action.getAttribute('href')).toBe('/settings?tab=security')
  })

  it('has no dismiss control', async () => {
    vi.mocked(getAppSettings).mockResolvedValue({
      ...SETTINGS,
      recoveryKeyConfirmed: false,
    })
    renderBanner()

    const banner = await screen.findByTestId('recovery-key-unconfirmed-banner')
    expect(banner.querySelectorAll('button')).toHaveLength(0)
  })

  it('renders nothing when recoveryKeyConfirmed is true', async () => {
    const { client } = renderBanner()

    await waitFor(() => {
      expect(client.getQueryState(['settings'])?.status).toBe('success')
    })
    expect(screen.queryByTestId('recovery-key-unconfirmed-banner')).toBeNull()
    expect(screen.queryByTestId('recovery-key-unconfirmed-text')).toBeNull()
    expect(screen.queryByTestId('recovery-key-unconfirmed-action')).toBeNull()
  })

  it('renders nothing while the settings are still loading', () => {
    vi.mocked(getAppSettings).mockReturnValue(new Promise(() => {}))
    renderBanner()

    expect(screen.queryByTestId('recovery-key-unconfirmed-banner')).toBeNull()
  })

  it('disappears once the settings change to confirmed', async () => {
    vi.mocked(getAppSettings).mockResolvedValue({
      ...SETTINGS,
      recoveryKeyConfirmed: false,
    })
    const { client } = renderBanner()
    await screen.findByTestId('recovery-key-unconfirmed-banner')

    vi.mocked(getAppSettings).mockResolvedValue(SETTINGS)
    await client.invalidateQueries({ queryKey: ['settings'] })

    await waitFor(() => {
      expect(screen.queryByTestId('recovery-key-unconfirmed-banner')).toBeNull()
    })
  })
})
