import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Tag, Database } from 'lucide-react'

import { getUserCategories } from '../lib/categories'
import type { Category } from '../lib/domain'
import { TabButton } from '../components/settings/TabButton'
import { CategoriesTab } from '../components/settings/CategoriesTab'
import { DataToolsTab } from '../components/settings/DataToolsTab'

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/settings')({
  loader: async (): Promise<{ categories: Category[] }> => {
    const categories = await getUserCategories()
    return { categories }
  },
  component: SettingsPage,
})

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

type Tab = 'categories' | 'data'

function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('categories')

  return (
    <div className="min-h-screen bg-slate-900 pb-20">
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-6 pb-12">
        <h1 className="text-2xl font-bold text-white">Settings</h1>

        {/* Tab switcher */}
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
    </div>
  )
}
