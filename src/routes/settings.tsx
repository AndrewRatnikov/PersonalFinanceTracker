import { createFileRoute } from '@tanstack/react-router'
import { Database, Tag } from 'lucide-react'

import { getUserCategories } from '@/lib/categories'
import { CategoriesTab } from '@/components/settings/CategoriesTab'
import { DataToolsTab } from '@/components/settings/DataToolsTab'
import type { Category } from '@/lib/domain'
import PageShell from '@/components/PageShell'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export const Route = createFileRoute('/settings')({
  loader: async (): Promise<{ categories: Array<Category> }> => {
    const categories = await getUserCategories()
    return { categories }
  },
  component: SettingsPage,
})

function SettingsPage() {
  return (
    <PageShell>
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Settings</h1>

        <Tabs defaultValue="categories" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger 
              value="categories" 
            >
              <Tag size={16} className="mr-2" />
              Categories
            </TabsTrigger>
            <TabsTrigger 
              value="data" 
            >
              <Database size={16} className="mr-2" />
              Data Tools
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="categories" className="mt-6">
            <CategoriesTab />
          </TabsContent>
          <TabsContent value="data" className="mt-6">
            <DataToolsTab />
          </TabsContent>
        </Tabs>
      </div>
    </PageShell>
  )
}
