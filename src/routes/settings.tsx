import { createFileRoute } from '@tanstack/react-router'
import { Database, Tag, Wallet } from 'lucide-react'

import { getUserCategories } from '@/lib/categories'
import { getOfflineCache, setOfflineCache } from '@/lib/offlineCache'
import { CategoriesTab } from '@/components/settings/CategoriesTab'
import { DataToolsTab } from '@/components/settings/DataToolsTab'
import { BudgetTab } from '@/components/settings/BudgetTab'
import type { Category } from '@/lib/domain'
import PageShell from '@/components/PageShell'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export const Route = createFileRoute('/settings')({
  loader: async (): Promise<{ categories: Array<Category> }> => {
    try {
      const categories = await getUserCategories()
      if (typeof window !== 'undefined') {
        void setOfflineCache('categories', categories)
      }
      return { categories }
    } catch (err) {
      if (typeof window !== 'undefined' && !navigator.onLine) {
        const categories = await getOfflineCache('categories')
        if (categories) return { categories }
      }
      throw err
    }
  },
  component: SettingsPage,
})

function SettingsPage() {
  const { categories } = Route.useLoaderData()

  return (
    <PageShell>
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Settings</h1>

        <Tabs defaultValue="categories" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="categories">
              <Tag size={16} className="mr-2" />
              Categories
            </TabsTrigger>
            <TabsTrigger value="budget">
              <Wallet size={16} className="mr-2" />
              Budget
            </TabsTrigger>
            <TabsTrigger value="data">
              <Database size={16} className="mr-2" />
              Data Tools
            </TabsTrigger>
          </TabsList>

          <TabsContent value="categories" className="mt-6">
            <CategoriesTab />
          </TabsContent>
          <TabsContent value="budget" className="mt-6">
            <BudgetTab categories={categories} />
          </TabsContent>
          <TabsContent value="data" className="mt-6">
            <DataToolsTab />
          </TabsContent>
        </Tabs>
      </div>
    </PageShell>
  )
}
