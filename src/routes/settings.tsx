import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Database, Shield, Tag, Wallet } from 'lucide-react'

import { getAllCategories } from '@/lib/localDb'
import { CategoriesTab } from '@/components/settings/CategoriesTab'
import { DataToolsTab } from '@/components/settings/DataToolsTab'
import { BudgetTab } from '@/components/settings/BudgetTab'
import { SecurityTab } from '@/components/settings/SecurityTab'
import PageShell from '@/components/PageShell'
import { QueryErrorState } from '@/components/QueryErrorState'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export type SettingsTab = 'categories' | 'budget' | 'security' | 'data'

export type SettingsSearch = {
  tab?: SettingsTab
}

const SETTINGS_TABS: ReadonlyArray<SettingsTab> = [
  'categories',
  'budget',
  'security',
  'data',
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
  const { auth } = Route.useRouteContext()
  const search = Route.useSearch()
  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: getAllCategories,
  })
  const categories = categoriesQuery.data ?? []

  return (
    <PageShell>
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          Settings
        </h1>

        <Tabs defaultValue={search.tab ?? 'categories'} className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="categories">
              <Tag size={16} className="mr-2 hidden sm:block" />
              Categories
            </TabsTrigger>
            <TabsTrigger value="budget">
              <Wallet size={16} className="mr-2 hidden sm:block" />
              Budget
            </TabsTrigger>
            <TabsTrigger value="security">
              <Shield size={16} className="mr-2 hidden sm:block" />
              Security
            </TabsTrigger>
            <TabsTrigger value="data">
              <Database size={16} className="mr-2 hidden sm:block" />
              Data Tools
            </TabsTrigger>
          </TabsList>

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
            <DataToolsTab userId={auth.user!.id} />
          </TabsContent>
        </Tabs>
      </div>
    </PageShell>
  )
}
