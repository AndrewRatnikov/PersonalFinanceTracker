// No CONTRACT_GAPs: the registry exports and their rules are specified in the
// Interface Contract (Module: settingsSections). The module is pure, so no
// mocks are needed.

import { describe, expect, it } from 'vitest'

import type { SettingsTab, SettingsVisibility } from '@/lib/settingsSections'
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  SETTINGS_TABS,
  isSettingsTabVisible,
  resolveSettingsTab,
  visibleSettingsGroups,
} from '@/lib/settingsSections'

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
const ACCOUNTS_ONLY: SettingsVisibility = { ...NONE, accountsVisible: true }
const ACCOUNTS_AND_SYNC: SettingsVisibility = { ...ACCOUNTS_ONLY, syncVisible: true }

const ORDER: Array<SettingsTab> = [
  'general',
  'categories',
  'budget',
  'security',
  'data',
  'account',
  'sync',
  'family',
]

function ids(v: SettingsVisibility): Array<Array<string>> {
  return visibleSettingsGroups(v).map((g) => g.sections.map((s) => s.id))
}

describe('the registry constants', () => {
  it('lists the eight tabs in the old order', () => {
    expect([...SETTINGS_TABS]).toEqual(ORDER)
  })

  it('lists the groups in order', () => {
    expect([...SETTINGS_GROUPS]).toEqual(['budget', 'device', 'cloud'])
  })

  it('has one section per tab, in tab order', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual(ORDER)
  })

  it('puts each section in its group', () => {
    const groupOf = Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s.id, s.group]))
    expect(groupOf).toEqual({
      general: 'budget',
      categories: 'budget',
      budget: 'budget',
      security: 'device',
      data: 'device',
      account: 'cloud',
      sync: 'cloud',
      family: 'cloud',
    })
  })

  it('derives the label and description keys from the id', () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(s.labelKey).toBe(`settings.tabs.${s.id}`)
      expect(s.descriptionKey).toBe(`settings.descriptions.${s.id}`)
    }
  })

  it('gives every section an icon component', () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(['function', 'object']).toContain(typeof s.icon)
      expect(s.icon).toBeTruthy()
    }
  })

  it('gives different sections different icons', () => {
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.icon)).size).toBe(SETTINGS_SECTIONS.length)
  })
})

describe('isSettingsTabVisible', () => {
  it.each(['general', 'categories', 'budget', 'security', 'data'] as const)(
    '%s is always visible',
    (id) => {
      expect(isSettingsTabVisible(id, NONE)).toBe(true)
      expect(isSettingsTabVisible(id, ALL)).toBe(true)
    },
  )

  it('account follows accountsVisible only', () => {
    expect(isSettingsTabVisible('account', NONE)).toBe(false)
    expect(isSettingsTabVisible('account', ACCOUNTS_ONLY)).toBe(true)
    expect(isSettingsTabVisible('account', { ...NONE, syncVisible: true, familyVisible: true })).toBe(false)
  })

  it('sync follows syncVisible only', () => {
    expect(isSettingsTabVisible('sync', ACCOUNTS_ONLY)).toBe(false)
    expect(isSettingsTabVisible('sync', ACCOUNTS_AND_SYNC)).toBe(true)
    expect(isSettingsTabVisible('sync', { ...NONE, syncVisible: true })).toBe(true)
  })

  it('family follows familyVisible only', () => {
    expect(isSettingsTabVisible('family', ACCOUNTS_AND_SYNC)).toBe(false)
    expect(isSettingsTabVisible('family', ALL)).toBe(true)
  })
})

describe('visibleSettingsGroups', () => {
  it('lists three groups with everything visible', () => {
    const groups = visibleSettingsGroups(ALL)

    expect(groups.map((g) => g.group)).toEqual(['budget', 'device', 'cloud'])
    expect(ids(ALL)).toEqual([
      ['general', 'categories', 'budget'],
      ['security', 'data'],
      ['account', 'sync', 'family'],
    ])
  })

  it('drops the cloud group when nothing in it is visible', () => {
    expect(visibleSettingsGroups(NONE).map((g) => g.group)).toEqual(['budget', 'device'])
    expect(ids(NONE)).toEqual([
      ['general', 'categories', 'budget'],
      ['security', 'data'],
    ])
  })

  it('leaves out hidden items but keeps the group', () => {
    expect(ids(ACCOUNTS_ONLY)).toEqual([
      ['general', 'categories', 'budget'],
      ['security', 'data'],
      ['account'],
    ])
    expect(ids(ACCOUNTS_AND_SYNC)[2]).toEqual(['account', 'sync'])
  })

  it('keeps the section definitions from the registry', () => {
    const cloud = visibleSettingsGroups(ALL)[2]
    const sync = cloud.sections.find((s) => s.id === 'sync')

    expect(sync).toBe(SETTINGS_SECTIONS.find((s) => s.id === 'sync'))
  })

  it('never returns an empty group', () => {
    for (const v of [ALL, NONE, ACCOUNTS_ONLY, ACCOUNTS_AND_SYNC]) {
      for (const g of visibleSettingsGroups(v)) expect(g.sections.length).toBeGreaterThan(0)
    }
  })
})

describe('resolveSettingsTab', () => {
  it.each(ORDER)('returns the requested visible tab %s on both layouts', (id) => {
    expect(resolveSettingsTab(id, ALL, true)).toBe(id)
    expect(resolveSettingsTab(id, ALL, false)).toBe(id)
  })

  it('no request: General on desktop, the list (null) on phone', () => {
    expect(resolveSettingsTab(undefined, ALL, true)).toBe('general')
    expect(resolveSettingsTab(undefined, ALL, false)).toBeNull()
  })

  it('a hidden account falls back per layout', () => {
    expect(resolveSettingsTab('account', NONE, true)).toBe('general')
    expect(resolveSettingsTab('account', NONE, false)).toBeNull()
  })

  it('a hidden sync falls back per layout', () => {
    expect(resolveSettingsTab('sync', ACCOUNTS_ONLY, true)).toBe('general')
    expect(resolveSettingsTab('sync', ACCOUNTS_ONLY, false)).toBeNull()
  })

  it('a hidden family falls back per layout', () => {
    expect(resolveSettingsTab('family', ACCOUNTS_AND_SYNC, true)).toBe('general')
    expect(resolveSettingsTab('family', ACCOUNTS_AND_SYNC, false)).toBeNull()
  })

  it('a visible always-on tab is kept even with everything else hidden', () => {
    expect(resolveSettingsTab('data', NONE, false)).toBe('data')
    expect(resolveSettingsTab('security', NONE, true)).toBe('security')
  })
})
