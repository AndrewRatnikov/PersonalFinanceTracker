import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Database, Tag } from 'lucide-react'

import { getUserCategories } from '../lib/categories'
import { TabButton } from '../components/settings/TabButton'
import { CategoriesTab } from '../components/settings/CategoriesTab'
import { DataToolsTab } from '../components/settings/DataToolsTab'
import type { Category } from '../lib/domain'
import PageShell from '@/components/PageShell'

export const Route = createFileRoute('/settings')({
  loader: async (): Promise<{ categories: Array<Category> }> => {
    const categories = await getUserCategories()
    return { categories }
  },
  component: SettingsPage,
})

type Tab = 'categories' | 'data'

function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('categories')

  return (
    <PageShell>
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
        <h1 className="text-2xl font-bold text-white">Settings</h1>

        <div className="flex gap-2">
          <TabButton
            label="Categories"
            icon={<Tag size={16} />}
            active={activeTab === 'categories'}
            onClick={() => setActiveTab('categories')}
          />
          <TabButton
            label="Data Tools"
            icon={<Database size={16} />}
            active={activeTab === 'data'}
            onClick={() => setActiveTab('data')}
          />
        </div>

        {activeTab === 'categories' ? <CategoriesTab /> : <DataToolsTab />}
      </div>
    </PageShell>
  )
}
