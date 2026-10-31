// CONTRACT_GAP: the aria-label wording of the buttons is not fixed; they are
//   asserted to be non-empty and, for Personal, to contain the catalog text of
//   space.personal.
// CONTRACT_GAP: the 44 px touch target is asserted through the min-h-11 class
//   named in the plan for the chip, and by the absence of the class for no one
//   else (not asserted).

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

import type { ActiveSpaceState } from '@/lib/spaces/switcher'
import { setLang, translate } from '@/i18n/core'
import { SpaceSwitchProvider } from '@/lib/spaces/switcher'
import { SpaceChip, SpaceSwitcher } from '@/components/space/SpaceSwitcher'

const FAMILY = { id: 'fam-1', name: 'Our home', role: 'owner' as const, readOnly: false }
const switchTo = vi.fn()

function renderWith(value: Partial<ActiveSpaceState>, ui: ReactElement) {
  return render(<SpaceSwitchProvider value={{ switchTo, ...value }}>{ui}</SpaceSwitchProvider>)
}

beforeEach(() => {
  switchTo.mockReset()
  setLang('en', { persist: false })
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('without a Family', () => {
  it('renders nothing for any variant or the chip', () => {
    const { container } = renderWith(
      { spaceId: 'personal', family: null },
      <>
        <SpaceSwitcher variant="header" />
        <SpaceSwitcher variant="nav" />
        <SpaceChip />
      </>,
    )

    expect(container.innerHTML).toBe('')
    expect(screen.queryByTestId('space-switcher')).toBeNull()
    expect(screen.queryByTestId('nav-space-switcher')).toBeNull()
    expect(screen.queryByTestId('space-chip')).toBeNull()
  })
})

describe('header variant', () => {
  it('is a group of two buttons with the Personal label and the Family name', () => {
    renderWith({ spaceId: 'personal', family: FAMILY }, <SpaceSwitcher variant="header" />)

    const group = screen.getByTestId('space-switcher')
    expect(group.getAttribute('role')).toBe('group')
    expect(screen.getByTestId('space-switch-personal').textContent).toContain(translate('en', 'space.personal'))
    expect(screen.getByTestId('space-switch-family').textContent).toContain('Our home')
    expect(screen.getByTestId('space-switch-personal').getAttribute('aria-label')).toBeTruthy()
    expect(screen.getByTestId('space-switch-family').getAttribute('aria-label')).toContain('Our home')
  })

  it('marks the active space with aria-pressed', () => {
    const { unmount } = renderWith({ spaceId: 'personal', family: FAMILY }, <SpaceSwitcher variant="header" />)
    expect(screen.getByTestId('space-switch-personal').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('space-switch-family').getAttribute('aria-pressed')).toBe('false')
    unmount()

    renderWith({ spaceId: 'fam-1', family: FAMILY }, <SpaceSwitcher variant="header" />)
    expect(screen.getByTestId('space-switch-personal').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('space-switch-family').getAttribute('aria-pressed')).toBe('true')
  })

  it('clicking an option switches to that space', () => {
    renderWith({ spaceId: 'personal', family: FAMILY }, <SpaceSwitcher variant="header" />)

    fireEvent.click(screen.getByTestId('space-switch-family'))
    expect(switchTo).toHaveBeenLastCalledWith('fam-1')
    fireEvent.click(screen.getByTestId('space-switch-personal'))
    expect(switchTo).toHaveBeenLastCalledWith('personal')
  })

  it('uses native buttons so they are keyboard operable', () => {
    renderWith({ spaceId: 'personal', family: FAMILY }, <SpaceSwitcher variant="header" />)

    expect(screen.getByTestId('space-switch-personal').tagName).toBe('BUTTON')
    expect(screen.getByTestId('space-switch-family').tagName).toBe('BUTTON')
  })

  it('is hidden on mobile (md:flex only)', () => {
    renderWith({ spaceId: 'personal', family: FAMILY }, <SpaceSwitcher variant="header" />)

    const className = screen.getByTestId('space-switcher').className
    expect(className).toContain('hidden')
    expect(className).toContain('md:flex')
  })

  it('shows the Family name in uk too, with the Personal label translated', () => {
    setLang('uk', { persist: false })
    renderWith({ spaceId: 'personal', family: FAMILY }, <SpaceSwitcher variant="header" />)

    expect(screen.getByTestId('space-switch-personal').textContent).toContain(translate('uk', 'space.personal'))
    expect(translate('uk', 'space.personal')).toBe('Особисте')
    expect(screen.getByTestId('space-switch-family').textContent).toContain('Our home')
  })
})

describe('sync state icon', () => {
  it.each(['synced', 'syncing', 'paused', 'rotation-pending', 'offline'] as const)(
    'carries the Family status %s',
    (status) => {
      renderWith({ spaceId: 'fam-1', family: FAMILY, familyStatus: status }, <SpaceSwitcher variant="header" />)

      const icon = screen.getByTestId('space-sync-state')
      expect(icon.getAttribute('data-status')).toBe(status)
      expect(icon.getAttribute('aria-label')).toBeTruthy()
    },
  )

  it('paused and synced get different accessible labels', () => {
    const { unmount } = renderWith(
      { spaceId: 'fam-1', family: FAMILY, familyStatus: 'paused' },
      <SpaceSwitcher variant="header" />,
    )
    const paused = screen.getByTestId('space-sync-state').getAttribute('aria-label')
    unmount()
    renderWith({ spaceId: 'fam-1', family: FAMILY, familyStatus: 'synced' }, <SpaceSwitcher variant="header" />)

    expect(screen.getByTestId('space-sync-state').getAttribute('aria-label')).not.toBe(paused)
  })
})

describe('nav variant', () => {
  it('uses the nav-space-* ids so both can live in the DOM', () => {
    renderWith(
      { spaceId: 'fam-1', family: FAMILY },
      <>
        <SpaceSwitcher variant="header" />
        <SpaceSwitcher variant="nav" />
      </>,
    )

    expect(screen.getByTestId('nav-space-switcher')).toBeTruthy()
    expect(screen.getByTestId('nav-space-switch-family').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('nav-space-switch-personal').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('space-switcher')).toBeTruthy()
  })

  it('switches from the nav buttons', () => {
    renderWith({ spaceId: 'fam-1', family: FAMILY }, <SpaceSwitcher variant="nav" />)

    fireEvent.click(screen.getByTestId('nav-space-switch-personal'))

    expect(switchTo).toHaveBeenCalledWith('personal')
  })
})

describe('SpaceChip', () => {
  it('shows the current space name and switches to the other space on tap', () => {
    const { unmount } = renderWith({ spaceId: 'personal', family: FAMILY }, <SpaceChip />)
    const chip = screen.getByTestId('space-chip')
    expect(chip.textContent).toContain(translate('en', 'space.personal'))
    fireEvent.click(chip)
    expect(switchTo).toHaveBeenLastCalledWith('fam-1')
    unmount()

    renderWith({ spaceId: 'fam-1', family: FAMILY }, <SpaceChip />)
    expect(screen.getByTestId('space-chip').textContent).toContain('Our home')
    fireEvent.click(screen.getByTestId('space-chip'))
    expect(switchTo).toHaveBeenLastCalledWith('personal')
  })

  it('is mobile only, a native button with a 44 px target and an accessible label', () => {
    renderWith({ spaceId: 'fam-1', family: FAMILY }, <SpaceChip />)

    const chip = screen.getByTestId('space-chip')
    expect(chip.tagName).toBe('BUTTON')
    expect(chip.className).toContain('md:hidden')
    expect(chip.className).toContain('min-h-11')
    expect(chip.getAttribute('aria-label')).toContain('Our home')
  })
})
