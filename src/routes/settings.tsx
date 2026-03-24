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
        <h1 className="text-2xl font-bold text-white">Settings</h1>

        <Tabs defaultValue="categories" className="w-full">
          <TabsList className="bg-slate-900 border border-slate-700">
            <TabsTrigger 
              value="categories" 
              className="data-[state=active]:bg-cyan-500 data-[state=active]:text-white text-slate-400"
            >
              <Tag size={16} className="mr-2" />
              Categories
            </TabsTrigger>
            <TabsTrigger 
              value="data" 
              className="data-[state=active]:bg-cyan-500 data-[state=active]:text-white text-slate-400"
            >
              <Database size={16} className="mr-2" />
              Data Tools
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="categories" className="mt-8">
            <CategoriesTab />
          </TabsContent>
          <TabsContent value="data" className="mt-8">
            <DataToolsTab />
          </TabsContent>
        </Tabs>
      </div>
    </PageShell>
  )
}
