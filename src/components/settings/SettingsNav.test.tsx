// No CONTRACT_GAPs: SettingsNav's props, variants and every testid used here
// (settings-index, settings-sidebar, settings-group-{group}, its -title,
// settings-item-{id}, settings-item-sync-status, settings-item-family-badge)
// are specified in the Interface Contract (Component: SettingsNav). The groups
// come from the real registry (visibleSettingsGroups), so the component is
// tested against the same data the route passes. The wrap and 44 px classes are
// styling and are not asserted; the tests check that items are buttons.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SettingsTab, SettingsVisibility } from '@/lib/settingsSections'
import type { SettingsNavProps } from '@/components/settings/SettingsNav'
import { setLang, translate } from '@/i18n/core'
import { visibleSettingsGroups } from '@/lib/settingsSections'
import { SettingsNav } from '@/components/settings/SettingsNav'

const ALL: SettingsVisibility = {
  accountsVisible: true,
  syncVisible: true,
  familyVisible: true,
}
const NONE: SettingsVisibility = {
  accountsVisible: false,
  syncVisible: false,
  familyVisible: false,
}

const IDS: Array<SettingsTab> = [
  'general',
  'categories',
  'budget',
  'security',
  'data',
  'account',
  'sync',
  'family',
]

const CYRILLIC = /[Ѐ-ӿ]/

function renderNav(overrides: Partial<SettingsNavProps> = {}) {
  const onSelect = vi.fn<(id: SettingsTab) => void>()
  const props: SettingsNavProps = {
    variant: 'list',
    groups: visibleSettingsGroups(ALL),
    activeId: null,
    onSelect,
    budgetSpaceName: null,
    familyRequestCount: 0,
    syncIndicator: null,
    ...overrides,
  }
  render(<SettingsNav {...props} />)
  return { onSelect }
}

beforeEach(() => {
  setLang('en', { persist: false })
})

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('list variant (phone)', () => {
  it('renders the index landmark and not the sidebar', () => {
    renderNav({ variant: 'list' })

    const nav = screen.getByTestId('settings-index')
    expect(nav.tagName).toBe('NAV')
    expect(nav.getAttribute('aria-label')).toBe('Settings sections')
    expect(screen.queryByTestId('settings-sidebar')).toBeNull()
  })

  it('renders the three groups in order with their titles', () => {
    renderNav()

    const nav = screen.getByTestId('settings-index')
    const groups = Array.from(nav.querySelectorAll('[data-testid^="settings-group-"]')).filter(
      (el) => !el.getAttribute('data-testid')?.endsWith('-title'),
    )
    expect(groups.map((g) => g.getAttribute('data-testid'))).toEqual([
      'settings-group-budget',
      'settings-group-device',
      'settings-group-cloud',
    ])
    expect(screen.getByTestId('settings-group-budget-title').textContent.trim()).toBe('Budget')
    expect(screen.getByTestId('settings-group-device-title').textContent.trim()).toBe('This device')
    expect(screen.getByTestId('settings-group-cloud-title').textContent.trim()).toBe(
      'Account & cloud',
    )
  })

  it('puts each item inside its group', () => {
    renderNav()

    const inGroup = (group: string) =>
      within(screen.getByTestId(`settings-group-${group}`))
        .getAllByRole('button')
        .map((b) => b.getAttribute('data-testid'))
    expect(inGroup('budget')).toEqual([
      'settings-item-general',
      'settings-item-categories',
      'settings-item-budget',
    ])
    expect(inGroup('device')).toEqual(['settings-item-security', 'settings-item-data'])
    expect(inGroup('cloud')).toEqual([
      'settings-item-account',
      'settings-item-sync',
      'settings-item-family',
    ])
  })

  it.each(IDS)('item %s is a button of type button with its label and description', (id) => {
    renderNav()

    const item = screen.getByTestId(`settings-item-${id}`)
    expect(item.tagName).toBe('BUTTON')
    expect(item.getAttribute('type')).toBe('button')
    const text = item.textContent
    expect(text).toContain(translate('en', `settings.tabs.${id}`))
    expect(text).toContain(translate('en', `settings.descriptions.${id}`))
  })

  it('has no aria-current on any item', () => {
    renderNav()

    for (const id of IDS) {
      expect(screen.getByTestId(`settings-item-${id}`).hasAttribute('aria-current')).toBe(false)
    }
  })

  it('calls onSelect with the id of the clicked item, and only that one', () => {
    const { onSelect } = renderNav()

    fireEvent.click(screen.getByTestId('settings-item-security'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenLastCalledWith('security')

    fireEvent.click(screen.getByTestId('settings-item-family'))
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(onSelect).toHaveBeenLastCalledWith('family')
  })

  it('leaves out hidden items and empty groups', () => {
    renderNav({ groups: visibleSettingsGroups(NONE) })

    expect(screen.getAllByRole('button')).toHaveLength(5)
    for (const id of ['account', 'sync', 'family']) {
      expect(screen.queryByTestId(`settings-item-${id}`)).toBeNull()
    }
    expect(screen.queryByTestId('settings-group-cloud')).toBeNull()
    expect(screen.getByTestId('settings-group-budget')).toBeTruthy()
    expect(screen.getByTestId('settings-group-device')).toBeTruthy()
  })

  it('shows only the visible cloud items', () => {
    renderNav({ groups: visibleSettingsGroups({ ...NONE, accountsVisible: true }) })

    expect(screen.getByTestId('settings-item-account')).toBeTruthy()
    expect(screen.queryByTestId('settings-item-sync')).toBeNull()
    expect(screen.queryByTestId('settings-item-family')).toBeNull()
    expect(screen.getByTestId('settings-group-cloud')).toBeTruthy()
  })
})

describe('sidebar variant (desktop)', () => {
  it('renders the sidebar landmark and not the index', () => {
    renderNav({ variant: 'sidebar', activeId: 'general' })

    const nav = screen.getByTestId('settings-sidebar')
    expect(nav.tagName).toBe('NAV')
    expect(nav.getAttribute('aria-label')).toBe('Settings sections')
    expect(screen.queryByTestId('settings-index')).toBeNull()
  })

  it('renders the same groups and items as buttons', () => {
    renderNav({ variant: 'sidebar', activeId: 'general' })

    expect(screen.getAllByRole('button')).toHaveLength(IDS.length)
    for (const id of IDS) {
      const item = screen.getByTestId(`settings-item-${id}`)
      expect(item.tagName).toBe('BUTTON')
      expect(item.getAttribute('type')).toBe('button')
    }
    for (const group of ['budget', 'device', 'cloud']) {
      expect(screen.getByTestId(`settings-group-${group}-title`)).toBeTruthy()
    }
  })

  it('marks only the active item with aria-current="page"', () => {
    renderNav({ variant: 'sidebar', activeId: 'data' })

    expect(screen.getByTestId('settings-item-data').getAttribute('aria-current')).toBe('page')
    for (const id of IDS.filter((i) => i !== 'data')) {
      expect(screen.getByTestId(`settings-item-${id}`).hasAttribute('aria-current')).toBe(false)
    }
  })

  it('moves aria-current when activeId changes', () => {
    renderNav({ variant: 'sidebar', activeId: 'general' })
    expect(screen.getByTestId('settings-item-general').getAttribute('aria-current')).toBe('page')
    cleanup()

    renderNav({ variant: 'sidebar', activeId: 'sync' })
    expect(screen.getByTestId('settings-item-sync').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('settings-item-general').hasAttribute('aria-current')).toBe(false)
  })

  it('has no current item when activeId is null', () => {
    renderNav({ variant: 'sidebar', activeId: null })

    expect(document.querySelectorAll('[aria-current]')).toHaveLength(0)
  })

  it('calls onSelect with the clicked id', () => {
    const { onSelect } = renderNav({ variant: 'sidebar', activeId: 'general' })

    fireEvent.click(screen.getByTestId('settings-item-categories'))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('categories')
  })
})

describe.each(['list', 'sidebar'] as const)('%s: the Budget group title', (variant) => {
  it('is "Budget" without a Family', () => {
    renderNav({ variant, budgetSpaceName: null })

    expect(screen.getByTestId('settings-group-budget-title').textContent.trim()).toBe('Budget')
  })

  it('adds the space name when there is a Family', () => {
    renderNav({ variant, budgetSpaceName: 'Home' })

    expect(screen.getByTestId('settings-group-budget-title').textContent.trim()).toBe(
      'Budget · Home',
    )
  })

  it('follows the name', () => {
    renderNav({ variant, budgetSpaceName: 'Personal' })

    expect(screen.getByTestId('settings-group-budget-title').textContent.trim()).toBe(
      'Budget · Personal',
    )
  })

  it('does not change the other group titles', () => {
    renderNav({ variant, budgetSpaceName: 'Home' })

    expect(screen.getByTestId('settings-group-device-title').textContent.trim()).toBe('This device')
    expect(screen.getByTestId('settings-group-cloud-title').textContent.trim()).toBe(
      'Account & cloud',
    )
  })
})

describe.each(['list', 'sidebar'] as const)('%s: the Sync status dot', (variant) => {
  it('is absent without an indicator', () => {
    renderNav({ variant, syncIndicator: null })

    expect(screen.queryByTestId('settings-item-sync-status')).toBeNull()
  })

  it.each(['synced', 'syncing', 'offline', 'problem'] as const)(
    'shows %s inside the Sync item, with a readable state',
    (value) => {
      renderNav({ variant, syncIndicator: value })

      const dot = within(screen.getByTestId('settings-item-sync')).getByTestId(
        'settings-item-sync-status',
      )
      expect(dot.getAttribute('data-sync-indicator')).toBe(value)
      expect(screen.getByTestId('settings-item-sync').textContent).toContain(
        translate('en', `sync.indicator.${value}`),
      )
    },
  )

  it('shows no dot on other items', () => {
    renderNav({ variant, syncIndicator: 'synced' })

    expect(screen.getAllByTestId('settings-item-sync-status')).toHaveLength(1)
    expect(
      within(screen.getByTestId('settings-item-general')).queryByTestId(
        'settings-item-sync-status',
      ),
    ).toBeNull()
  })

  it('a different state gives a different attribute', () => {
    renderNav({ variant, syncIndicator: 'synced' })
    const first = screen.getByTestId('settings-item-sync-status').getAttribute('data-sync-indicator')
    cleanup()
    renderNav({ variant, syncIndicator: 'problem' })
    const second = screen
      .getByTestId('settings-item-sync-status')
      .getAttribute('data-sync-indicator')

    expect(first).not.toBe(second)
  })

  it('is not rendered when the Sync item is hidden', () => {
    renderNav({ variant, groups: visibleSettingsGroups(NONE), syncIndicator: 'synced' })

    expect(screen.queryByTestId('settings-item-sync-status')).toBeNull()
  })
})

describe.each(['list', 'sidebar'] as const)('%s: the Family badge', (variant) => {
  it('is absent when there are no requests', () => {
    renderNav({ variant, familyRequestCount: 0 })

    expect(screen.queryByTestId('settings-item-family-badge')).toBeNull()
  })

  it('shows the count inside the Family item', () => {
    renderNav({ variant, familyRequestCount: 3 })

    const badge = within(screen.getByTestId('settings-item-family')).getByTestId(
      'settings-item-family-badge',
    )
    expect(badge.textContent.trim()).toBe('3')
  })

  it('follows the count', () => {
    renderNav({ variant, familyRequestCount: 1 })
    expect(screen.getByTestId('settings-item-family-badge').textContent.trim()).toBe('1')
    cleanup()

    renderNav({ variant, familyRequestCount: 12 })
    expect(screen.getByTestId('settings-item-family-badge').textContent.trim()).toBe('12')
  })

  it('is absent when the Family item is hidden', () => {
    renderNav({ variant, groups: visibleSettingsGroups(NONE), familyRequestCount: 4 })

    expect(screen.queryByTestId('settings-item-family-badge')).toBeNull()
  })
})

describe('in Ukrainian', () => {
  beforeEach(() => {
    setLang('uk', { persist: false })
  })

  it('translates the landmark, group titles, labels and descriptions', () => {
    renderNav({ variant: 'list', budgetSpaceName: 'Home' })

    expect(screen.getByTestId('settings-index').getAttribute('aria-label')).toBe(
      translate('uk', 'settings.nav.label'),
    )
    expect(screen.getByTestId('settings-index').getAttribute('aria-label')).not.toBe(
      'Settings sections',
    )
    for (const group of ['budget', 'device', 'cloud']) {
      expect(screen.getByTestId(`settings-group-${group}-title`).textContent).toMatch(CYRILLIC)
    }
    expect(screen.getByTestId('settings-group-budget-title').textContent).toContain('Home')
    for (const id of IDS) {
      const text = screen.getByTestId(`settings-item-${id}`).textContent
      expect(text).toContain(translate('uk', `settings.tabs.${id}`))
      expect(text).toContain(translate('uk', `settings.descriptions.${id}`))
      expect(text).toMatch(CYRILLIC)
    }
  })

  it('translates the sync state text', () => {
    renderNav({ variant: 'sidebar', activeId: 'general', syncIndicator: 'offline' })

    const text = screen.getByTestId('settings-item-sync').textContent
    expect(text).toContain(translate('uk', 'sync.indicator.offline'))
    expect(text).not.toContain(translate('en', 'sync.indicator.offline'))
  })
})
