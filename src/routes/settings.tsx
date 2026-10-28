import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Cloud, Coins, Database, Shield, Tag, UserRound, Wallet } from 'lucide-react'

import { useT } from '@/i18n'
import { useAccountsVisible } from '@/lib/accountSession'
import { ENABLE_SYNC } from '@/lib/featureFlags'
import { spaceQueryKey, useActiveSpace, useSpaceDb } from '@/lib/spaces/react'
import { AccountTab } from '@/components/settings/AccountTab'
import { CategoriesTab } from '@/components/settings/CategoriesTab'
import { DataToolsTab } from '@/components/settings/DataToolsTab'
import { GeneralTab } from '@/components/settings/GeneralTab'
import { BudgetTab } from '@/components/settings/BudgetTab'
import { SecurityTab } from '@/components/settings/SecurityTab'
import { SyncTab } from '@/components/settings/SyncTab'
import PageShell from '@/components/PageShell'
import { QueryErrorState } from '@/components/QueryErrorState'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export type SettingsTab =
  | 'general'
  | 'categories'
  | 'budget'
  | 'security'
  | 'data'
  | 'account'
  | 'sync'

export type SettingsSearch = {
  tab?: SettingsTab
}

const SETTINGS_TABS: ReadonlyArray<SettingsTab> = [
  'general',
  'categories',
  'budget',
  'security',
  'data',
  'account',
  'sync',
]

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
  const requestedTab = search.tab ?? 'general'
  const initialTab =
    (requestedTab === 'account' && !accountsVisible) ||
    (requestedTab === 'sync' && !syncVisible)
      ? 'general'
      : requestedTab
  const columns = 5 + (accountsVisible ? 1 : 0) + (syncVisible ? 1 : 0)
  const gridClass =
    columns === 7 ? 'grid-cols-7' : columns === 6 ? 'grid-cols-6' : 'grid-cols-5'
  const spaceId = useActiveSpace()
  const db = useSpaceDb()
  const categoriesQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'categories'),
    queryFn: () => db.getAllCategories(),
  })
  const categories = categoriesQuery.data ?? []

  return (
    <PageShell>
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          {t('settings.title')}
        </h1>

        {/* Remounts when the Account or Sync tab appears (the session loads async). */}
        <Tabs
          key={`${accountsVisible ? 'with-account' : 'without-account'}-${syncVisible ? 'with-sync' : 'without-sync'}`}
          defaultValue={initialTab}
          className="w-full"
        >
          <TabsList
            className={`grid w-full ${gridClass}`}
          >
            <TabsTrigger value="general" data-testid="settings-tab-general">
              <Coins size={16} className="mr-2 hidden sm:block" />
              {t('settings.tabs.general')}
            </TabsTrigger>
            <TabsTrigger value="categories">
              <Tag size={16} className="mr-2 hidden sm:block" />
              {t('settings.tabs.categories')}
            </TabsTrigger>
            <TabsTrigger value="budget">
              <Wallet size={16} className="mr-2 hidden sm:block" />
              {t('settings.tabs.budget')}
            </TabsTrigger>
            <TabsTrigger value="security">
              <Shield size={16} className="mr-2 hidden sm:block" />
              {t('settings.tabs.security')}
            </TabsTrigger>
            <TabsTrigger value="data">
              <Database size={16} className="mr-2 hidden sm:block" />
              {t('settings.tabs.data')}
            </TabsTrigger>
            {accountsVisible && (
              <TabsTrigger value="account" data-testid="settings-tab-account">
                <UserRound size={16} className="mr-2 hidden sm:block" />
                  {t('settings.tabs.account')}
              </TabsTrigger>
            )}
            {syncVisible && (
              <TabsTrigger value="sync" data-testid="settings-tab-sync">
                <Cloud size={16} className="mr-2 hidden sm:block" />
                {t('settings.tabs.sync')}
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="general" className="mt-6">
            <GeneralTab />
          </TabsContent>
          <TabsContent value="categories" className="mt-6">
            <CategoriesTab />
          </TabsContent>
          <TabsContent value="budget" className="mt-6">
            {categoriesQuery.isError ? (
              <QueryErrorState onRetry={() => void categoriesQuery.refetch()} />
            ) : (
              <BudgetTab categories={categories} />
            )}
          </TabsContent>
          <TabsContent value="security" className="mt-6">
            <SecurityTab />
          </TabsContent>
          <TabsContent value="data" className="mt-6">
            <DataToolsTab />
          </TabsContent>
          {accountsVisible && (
            <TabsContent value="account" className="mt-6">
              <AccountTab />
            </TabsContent>
          )}
          {syncVisible && (
            <TabsContent value="sync" className="mt-6">
              <SyncTab />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </PageShell>
  )
}
