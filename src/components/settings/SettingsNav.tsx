import { ChevronRight } from 'lucide-react'

import type { SyncIndicatorValue } from '@/components/SyncIndicator'
import type {
  SettingsGroupId,
  SettingsGroupView,
  SettingsSectionDef,
  SettingsTab,
} from '@/lib/settingsSections'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'

export interface SettingsNavProps {
  variant: 'list' | 'sidebar'
  groups: ReadonlyArray<SettingsGroupView>
  activeId: SettingsTab | null
  onSelect: (id: SettingsTab) => void
  budgetSpaceName: string | null
  familyRequestCount: number
  syncIndicator: SyncIndicatorValue | null
}

const DOT_CLASS: Record<SyncIndicatorValue, string> = {
  synced: 'bg-chart-positive',
  syncing: 'bg-chart-accent animate-pulse',
  offline: 'bg-muted-foreground',
  problem: 'bg-destructive',
}

// The Settings sections as a grouped list (phone) or a sidebar (desktop).
// Presentational: the route owns the data and the navigation.
export function SettingsNav({
  variant,
  groups,
  activeId,
  onSelect,
  budgetSpaceName,
  familyRequestCount,
  syncIndicator,
}: SettingsNavProps) {
  const { t } = useT()
  const isList = variant === 'list'

  const groupTitle = (group: SettingsGroupId): string => {
    if (group === 'budget') {
      return budgetSpaceName !== null
        ? t('settings.groups.budgetFor', { name: budgetSpaceName })
        : t('settings.groups.budget')
    }
    return group === 'device' ? t('settings.groups.device') : t('settings.groups.cloud')
  }

  const indicator = (id: SettingsTab) => {
    if (id === 'sync' && syncIndicator !== null) {
      return (
        <span
          data-testid="settings-item-sync-status"
          data-sync-indicator={syncIndicator}
          className="inline-flex shrink-0 items-center"
        >
          <span
            aria-hidden="true"
            className={cn('h-2.5 w-2.5 rounded-full', DOT_CLASS[syncIndicator])}
          />
          <span className="sr-only">{t(`sync.indicator.${syncIndicator}`)}</span>
        </span>
      )
    }
    if (id === 'family' && familyRequestCount > 0) {
      return <Badge data-testid="settings-item-family-badge">{familyRequestCount}</Badge>
    }
    return null
  }

  const item = (section: SettingsSectionDef) => {
    const Icon = section.icon
    const active = !isList && activeId === section.id
    return (
      <li key={section.id}>
        <button
          type="button"
          data-testid={`settings-item-${section.id}`}
          aria-current={active ? 'page' : undefined}
          onClick={() => onSelect(section.id)}
          className={cn(
            'flex w-full items-center gap-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            isList ? 'min-h-11 px-4 py-3' : 'rounded-md px-3 py-2',
            active && 'bg-accent text-accent-foreground',
          )}
        >
          <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium break-words">{t(section.labelKey)}</span>
            <span className="text-sm text-muted-foreground break-words">
              {t(section.descriptionKey)}
            </span>
          </span>
          {indicator(section.id)}
          {isList && (
            <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
        </button>
      </li>
    )
  }

  return (
    <nav
      data-testid={isList ? 'settings-index' : 'settings-sidebar'}
      aria-label={t('settings.nav.label')}
      className={cn('flex flex-col', isList ? 'gap-6' : 'gap-4')}
    >
      {groups.map(({ group, sections }) => (
        <section key={group} data-testid={`settings-group-${group}`} className="flex flex-col gap-2">
          <h2
            data-testid={`settings-group-${group}-title`}
            className={cn(
              'font-medium text-muted-foreground break-words',
              isList ? 'px-1 text-sm' : 'px-3 text-xs uppercase tracking-wide',
            )}
          >
            {groupTitle(group)}
          </h2>
          <ul
            className={cn(
              isList
                ? 'divide-y overflow-hidden rounded-xl border bg-card'
                : 'flex flex-col gap-1',
            )}
          >
            {sections.map(item)}
          </ul>
        </section>
      ))}
    </nav>
  )
}
