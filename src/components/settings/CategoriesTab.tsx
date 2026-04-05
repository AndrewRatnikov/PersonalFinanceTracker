import { useState } from 'react'
import { useLoaderData, useRouter } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { createCategory } from '../../lib/categories'
import { CategoryRow } from './CategoryRow'
import type { Category } from '../../lib/domain'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

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
    <div className="flex flex-col gap-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Add new category */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Add Category
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              id="new-category-name"
              type="text"
              placeholder="Name (e.g. Coffee)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={40}
              className="flex-1"
            />
            <Input
              id="new-category-icon"
              type="text"
              placeholder="Icon (optional)"
              value={newIcon}
              onChange={(e) => setNewIcon(e.target.value)}
              className="w-32"
            />
            <Button
              id="add-category-btn"
              type="button"
              onClick={handleAdd}
              disabled={isPending || !newName.trim()}
              className="px-3"
              aria-label="Add category"
            >
              <Plus className="w-5 h-5" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Category list */}
      <div className="flex flex-col gap-3">
        {categories.length === 0 && (
          <p className="text-muted-foreground text-sm text-center py-10 italic">
            No categories yet. Add one above to get started.
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
