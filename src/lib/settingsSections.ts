import { Cloud, Coins, Database, Shield, Tag, UserRound, Users, Wallet } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type { MessageKey } from '@/i18n/core'

// Settings section registry: ids, groups, icons, label keys and visibility.
// Pure data and rules; the route reads the feature flags and passes them in.

export type SettingsTab =
  | 'general'
  | 'categories'
  | 'budget'
  | 'security'
  | 'data'
  | 'account'
  | 'sync'
  | 'family'

export const SETTINGS_TABS: ReadonlyArray<SettingsTab> = [
  'general',
  'categories',
  'budget',
  'security',
  'data',
  'account',
  'sync',
  'family',
]

export type SettingsGroupId = 'budget' | 'device' | 'cloud'

export const SETTINGS_GROUPS: ReadonlyArray<SettingsGroupId> = ['budget', 'device', 'cloud']

export interface SettingsSectionDef {
  id: SettingsTab
  group: SettingsGroupId
  icon: LucideIcon
  labelKey: MessageKey
  descriptionKey: MessageKey
}

function section(id: SettingsTab, group: SettingsGroupId, icon: LucideIcon): SettingsSectionDef {
  return {
    id,
    group,
    icon,
    labelKey: `settings.tabs.${id}` as MessageKey,
    descriptionKey: `settings.descriptions.${id}` as MessageKey,
  }
}

export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSectionDef> = [
  section('general', 'budget', Coins),
  section('categories', 'budget', Tag),
  section('budget', 'budget', Wallet),
  section('security', 'device', Shield),
  section('data', 'device', Database),
  section('account', 'cloud', UserRound),
  section('sync', 'cloud', Cloud),
  section('family', 'cloud', Users),
]

export interface SettingsVisibility {
  accountsVisible: boolean
  syncVisible: boolean
  familyVisible: boolean
}

export function isSettingsTabVisible(id: SettingsTab, v: SettingsVisibility): boolean {
  switch (id) {
    case 'account':
      return v.accountsVisible
    case 'sync':
      return v.syncVisible
    case 'family':
      return v.familyVisible
    default:
      return true
  }
}

export interface SettingsGroupView {
  group: SettingsGroupId
  sections: ReadonlyArray<SettingsSectionDef>
}

/** Groups in display order, without hidden sections; empty groups are dropped. */
export function visibleSettingsGroups(v: SettingsVisibility): Array<SettingsGroupView> {
  const views: Array<SettingsGroupView> = []
  for (const group of SETTINGS_GROUPS) {
    const sections = SETTINGS_SECTIONS.filter(
      (s) => s.group === group && isSettingsTabVisible(s.id, v),
    )
    if (sections.length > 0) views.push({ group, sections })
  }
  return views
}

/**
 * The section to show for a requested `?tab=`. A visible request wins;
 * otherwise desktop shows General and phone shows the list (`null`).
 */
export function resolveSettingsTab(
  requested: SettingsTab | undefined,
  v: SettingsVisibility,
  isDesktop: boolean,
): SettingsTab | null {
  if (requested !== undefined && isSettingsTabVisible(requested, v)) return requested
  return isDesktop ? 'general' : null
}
