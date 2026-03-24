import { useState } from 'react'
import { useLoaderData, useRouter } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { createCategory } from '../../lib/categories'
import { CategoryRow } from './CategoryRow'
import type { Category } from '../../lib/domain'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'

export function CategoriesTab() {
  const { categories } = useLoaderData({ from: '/settings' })
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
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Add new category */}
      <div className="bg-slate-800/60 rounded-2xl p-4 border border-slate-700/40 flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">
          Add Category
        </h3>
        <div className="flex gap-2">
          <Input
            id="new-category-name"
            type="text"
            placeholder="Name (e.g. Coffee)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={40}
            className="flex-1 bg-slate-900 border-slate-700 text-white placeholder:text-slate-500 focus-visible:ring-cyan-500 focus-visible:border-cyan-500"
          />
          <Input
            id="new-category-icon"
            type="text"
            placeholder="Icon (optional)"
            value={newIcon}
            onChange={(e) => setNewIcon(e.target.value)}
            className="w-32 bg-slate-900 border-slate-700 text-white placeholder:text-slate-500 focus-visible:ring-cyan-500 focus-visible:border-cyan-500"
          />
          <Button
            id="add-category-btn"
            type="button"
            onClick={handleAdd}
            disabled={isPending || !newName.trim()}
            className="p-2 bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 rounded-xl text-white"
            aria-label="Add category"
          >
            <Plus size={20} />
          </Button>
        </div>
      </div>

      {/* Category list */}
      <div className="flex flex-col gap-2">
        {categories.length === 0 && (
          <p className="text-slate-500 text-sm text-center py-6">
            No categories yet. Add one below.
          </p>
        )}
        {categories.map((cat: Category) => (
          <CategoryRow
            key={cat.id}
            category={cat}
            onMutate={refresh}
            onError={setError}
          />
        ))}
      </div>
    </div>
  )
}
