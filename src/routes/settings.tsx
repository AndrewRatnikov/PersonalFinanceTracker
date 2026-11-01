import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'

import type { SettingsTab, SettingsVisibility } from '@/lib/settingsSections'
import { useT } from '@/i18n'
import { useAccountsVisible } from '@/lib/accountSession'
import { ENABLE_SPACES, ENABLE_SYNC } from '@/lib/featureFlags'
import {
  SETTINGS_SECTIONS,
  SETTINGS_TABS,
  resolveSettingsTab,
  visibleSettingsGroups,
} from '@/lib/settingsSections'
import { spaceQueryKey, useActiveSpace, useSpaceDb } from '@/lib/spaces/react'
import { useSpaceSwitch } from '@/lib/spaces/switcher'
import { useFamilySyncState, useSyncState } from '@/lib/sync/react'
import { useIsDesktop } from '@/lib/useIsDesktop'
import { syncIndicatorValue } from '@/components/SyncIndicator'
import { AccountTab } from '@/components/settings/AccountTab'
import { CategoriesTab } from '@/components/settings/CategoriesTab'
import { DataToolsTab } from '@/components/settings/DataToolsTab'
import { FamilyTab } from '@/components/settings/FamilyTab'
import { GeneralTab } from '@/components/settings/GeneralTab'
import { BudgetTab } from '@/components/settings/BudgetTab'
import { SecurityTab } from '@/components/settings/SecurityTab'
import { SettingsNav } from '@/components/settings/SettingsNav'
import { SyncTab } from '@/components/settings/SyncTab'
import PageShell from '@/components/PageShell'
import { QueryErrorState } from '@/components/QueryErrorState'
import { Button } from '@/components/ui/button'

export type { SettingsTab }

export type SettingsSearch = {
  tab?: SettingsTab
}

export const Route = createFileRoute('/settings')({
  validateSearch: (search: Record<string, unknown>): SettingsSearch => {
    const result: SettingsSearch = {}
    const tab = SETTINGS_TABS.find((t) => t === search.tab)
    if (tab) result.tab = tab
    return result
  },
  component: SettingsPage,
})

function SettingsPage() {
  const search = Route.useSearch()
  const accountsVisible = useAccountsVisible()
  const { t } = useT()
  // Settings → Sync only with ENABLE_SYNC and visible accounts.
  const syncVisible = ENABLE_SYNC && accountsVisible
  // Settings → Family also needs ENABLE_SPACES.
  const familyVisible = ENABLE_SPACES && syncVisible
  const family = useFamilySyncState()
  // Pending join requests, shown to the owner only.
  const requestCount =
    family.space?.role === 'owner'
      ? family.space.members.filter((m) => m.status === 'pending').length
      : 0
  const visibility: SettingsVisibility = { accountsVisible, syncVisible, familyVisible }
  const syncState = useSyncState()
  const syncIndicator =
    syncVisible && syncState.status !== 'off' ? syncIndicatorValue(syncState.status) : null
  // "Budget · <space>" only while a Family is held (same rule as SpaceSettingsHeader).
  const space = useSpaceSwitch()
  const budgetSpaceName =
    space.family === null ? null : space.isFamily ? space.family.name : t('space.personal')
  const isDesktop = useIsDesktop()
  const navigate = Route.useNavigate()
  // Phone: null = the list. Desktop: always a section (General by default).
  const active = resolveSettingsTab(search.tab, visibility, isDesktop)
  // Push on the phone (Back returns to the list), replace on desktop.
  const select = (id: SettingsTab) => {
    void navigate({ search: { tab: id }, replace: isDesktop })
  }
  const backToList = () => {
    void navigate({ search: {}, replace: true })
  }
  const spaceId = useActiveSpace()
  const db = useSpaceDb()
  const categoriesQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'categories'),
    queryFn: () => db.getAllCategories(),
  })
  const categories = categoriesQuery.data ?? []

  const content = (id: SettingsTab) => {
    switch (id) {
      case 'general':
        return <GeneralTab />
      case 'categories':
        return <CategoriesTab />
      case 'budget':
        return categoriesQuery.isError ? (
          <QueryErrorState onRetry={() => void categoriesQuery.refetch()} />
        ) : (
          <BudgetTab categories={categories} />
        )
      case 'security':
        return <SecurityTab />
      case 'data':
        return <DataToolsTab />
      case 'account':
        return <AccountTab />
      case 'sync':
        return <SyncTab />
      case 'family':
        return <FamilyTab onOpenSyncTab={() => select('sync')} />
    }
  }

  const sectionLabel = (id: SettingsTab) => {
    const def = SETTINGS_SECTIONS.find((s) => s.id === id)
    return def ? t(def.labelKey) : ''
  }

  const nav = (variant: 'list' | 'sidebar') => (
    <SettingsNav
      variant={variant}
      groups={visibleSettingsGroups(visibility)}
      activeId={variant === 'sidebar' ? active : null}
      onSelect={select}
      budgetSpaceName={budgetSpaceName}
      familyRequestCount={requestCount}
      syncIndicator={syncIndicator}
    />
  )

  const pageTitle = (
    <h1 className="text-3xl font-bold tracking-tight text-foreground">{t('settings.title')}</h1>
  )

  let body: ReactNode
  if (isDesktop) {
    body = (
      <>
        {pageTitle}
        <div className="md:grid md:grid-cols-[16rem_minmax(0,1fr)] md:gap-8">
          <aside className="md:sticky md:top-20 self-start">{nav('sidebar')}</aside>
          {active !== null && (
            <div className="flex min-w-0 flex-col gap-6">
              <h2
                data-testid="settings-section-title"
                className="text-2xl font-semibold tracking-tight text-foreground"
              >
                {sectionLabel(active)}
              </h2>
              <div data-testid="settings-section" data-section={active}>
                {content(active)}
              </div>
            </div>
          )}
        </div>
      </>
    )
  } else if (active === null) {
    body = (
      <>
        {pageTitle}
        {nav('list')}
      </>
    )
  } else {
    body = (
      <>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            data-testid="settings-back"
            aria-label={t('settings.nav.back')}
            onClick={backToList}
            className="-ml-2 shrink-0"
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <h1
            data-testid="settings-section-title"
            className="min-w-0 text-2xl font-bold tracking-tight text-foreground break-words"
          >
            {sectionLabel(active)}
          </h1>
        </div>
        <div data-testid="settings-section" data-section={active}>
          {content(active)}
        </div>
      </>
    )
  }

  return (
    <PageShell>
      <div
        data-testid="settings-page"
        className="max-w-xl md:max-w-5xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8"
      >
        {body}
      </div>
    </PageShell>
  )
}
