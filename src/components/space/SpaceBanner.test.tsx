// CONTRACT_GAP: the people icon of the title cue is not asserted (no testid);
//   the cue is checked by its text.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { ActiveSpaceState } from '@/lib/spaces/switcher'
import { setLang, translate } from '@/i18n/core'
import { SpaceSwitchProvider } from '@/lib/spaces/switcher'
import { SpaceBanner } from '@/components/space/SpaceBanner'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode } & Record<string, unknown>) => (
    <a href={to} data-testid={rest['data-testid'] as string | undefined}>
      {children}
    </a>
  ),
}))

const FAMILY = { id: 'fam-1', name: 'Our home', role: 'owner' as const, readOnly: false }

function renderBanner(value: Partial<ActiveSpaceState>) {
  return render(
    <SpaceSwitchProvider value={value}>
      <SpaceBanner />
    </SpaceSwitchProvider>,
  )
}

beforeEach(() => setLang('en', { persist: false }))
afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('Personal or no Family', () => {
  it('renders nothing', () => {
    const { container } = renderBanner({ spaceId: 'personal', family: null })
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing in Personal even when a Family is held (and read-only flags are ignored)', () => {
    const { container } = renderBanner({ spaceId: 'personal', family: FAMILY, readOnly: true, paused: true })
    expect(container.innerHTML).toBe('')
  })
})

describe('Family active', () => {
  it('shows the title cue with the Family name and nothing else when healthy', () => {
    renderBanner({ spaceId: 'fam-1', family: FAMILY })

    expect(screen.getByTestId('space-title-cue').textContent).toContain('Our home')
    expect(screen.queryByTestId('space-readonly-banner')).toBeNull()
    expect(screen.queryByTestId('space-paused-banner')).toBeNull()
  })

  it('the cue follows the name', () => {
    renderBanner({ spaceId: 'fam-1', family: { ...FAMILY, name: 'Flat 7' } })

    expect(screen.getByTestId('space-title-cue').textContent).toContain('Flat 7')
    expect(screen.getByTestId('space-title-cue').textContent).not.toContain('Our home')
  })

  it('read-only: banner with the name and a link to Settings → Family', () => {
    renderBanner({ spaceId: 'fam-1', family: FAMILY, readOnly: true })

    const banner = screen.getByTestId('space-readonly-banner')
    expect(banner.textContent).toContain(translate('en', 'space.readOnlyBanner', { name: 'Our home' }))
    const link = screen.getByTestId('space-readonly-settings-link')
    expect(link.getAttribute('href')).toContain('/settings')
    expect(link.textContent).toContain(translate('en', 'space.readOnlyLink'))
    expect(screen.queryByTestId('space-paused-banner')).toBeNull()
  })

  it('paused: a small banner with the name, no read-only banner', () => {
    renderBanner({ spaceId: 'fam-1', family: FAMILY, paused: true })

    expect(screen.getByTestId('space-paused-banner').textContent).toContain(
      translate('en', 'space.pausedBanner', { name: 'Our home' }),
    )
    expect(screen.queryByTestId('space-readonly-banner')).toBeNull()
    expect(screen.queryByTestId('space-readonly-settings-link')).toBeNull()
  })

  it('the banners are translated', () => {
    setLang('uk', { persist: false })
    renderBanner({ spaceId: 'fam-1', family: FAMILY, readOnly: true })

    expect(screen.getByTestId('space-readonly-banner').textContent).toContain(
      translate('uk', 'space.readOnlyBanner', { name: 'Our home' }),
    )
    expect(translate('uk', 'space.readOnlyBanner', { name: 'X' })).not.toBe(
      translate('en', 'space.readOnlyBanner', { name: 'X' }),
    )
  })
})
