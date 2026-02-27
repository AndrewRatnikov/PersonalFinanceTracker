import { useState } from 'react'
import { useRouter, useLoaderData } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { createCategory } from '../../lib/categories'
import { CategoryRow } from './CategoryRow'
import type { Category } from '../../lib/domain'

export function CategoriesTab() {
  // Use useLoaderData with 'from' to avoid circular dependency with Route object
  const { categories } = useLoaderData({ from: '/settings' }) as {
    categories: Category[]
  }
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  const [newName, setNewName] = useState('')
  const [newIcon, setNewIcon] = useState('')

  const refresh = () => router.invalidate()

  const withPending = async (fn: () => Promise<void>) => {
    setError(null)
    setIsPending(true)
    try {
      await fn()
      await refresh()
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong')
    } finally {
      setIsPending(false)
    }
  }

  const handleAdd = () =>
    withPending(async () => {
      await createCategory({ data: { name: newName, icon: newIcon || null } })
      setNewName('')
      setNewIcon('')
    })

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="p-3 bg-red-900/40 border border-red-700/50 rounded-xl text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Category list */}
      <div className="flex flex-col gap-2">
        {categories.length === 0 && (
          <p className="text-slate-500 text-sm text-center py-6">
            No categories yet. Add one below.
          </p>
        )}
        {categories.map((cat) => (
          <CategoryRow
            key={cat.id}
            category={cat}
            onMutate={refresh}
            onError={setError}
          />
        ))}
      </div>

      {/* Add new category */}
      <div className="bg-slate-800/60 rounded-2xl p-4 border border-slate-700/40 flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">
          Add Category
        </h3>
        <div className="flex gap-2">
          <input
            id="new-category-name"
            type="text"
            placeholder="Name (e.g. Coffee)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={40}
            className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500"
          />
          <input
            id="new-category-icon"
            type="text"
            placeholder="Icon (optional)"
            value={newIcon}
            onChange={(e) => setNewIcon(e.target.value)}
            className="w-32 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500"
          />
          <button
            id="add-category-btn"
            onClick={handleAdd}
            disabled={isPending || !newName.trim()}
            className="p-2 bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-white transition-colors"
            aria-label="Add category"
          >
            <Plus size={20} />
          </button>
        </div>
      </div>
    </div>
  )
}
