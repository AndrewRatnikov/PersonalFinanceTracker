import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'

import { CategoryRow } from './CategoryRow'
import type { Category } from '@/lib/domain'
import {
  addCategory,
  addIncomeCategory,
  getAllCategories,
  getAllIncomeCategories,
} from '@/lib/localDb'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { QueryErrorState } from '@/components/QueryErrorState'

type CategoryKind = 'expense' | 'income'

interface CategorySectionProps {
  kind: CategoryKind
  categories: Array<Category>
  isError: boolean
  onRetry: () => void
  onAdd: (input: { name: string; icon: string | null }) => Promise<unknown>
  onMutate: () => Promise<unknown>
  onError: (msg: string | null) => void
}

// One list (expense or income categories) with its add card and rows.
function CategorySection({
  kind,
  categories,
  isError,
  onRetry,
  onAdd,
  onMutate,
  onError,
}: CategorySectionProps) {
  const [isPending, setIsPending] = useState(false)
  const [newName, setNewName] = useState('')
  const [newIcon, setNewIcon] = useState('')
  const isIncome = kind === 'income'

  const handleAdd = async () => {
    onError(null)
    setIsPending(true)
    try {
      await onAdd({ name: newName, icon: newIcon || null })
      setNewName('')
      setNewIcon('')
      await onMutate()
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setIsPending(false)
    }
  }

  const refreshRows = () => {
    void onMutate()
  }

  return (
    <section
      data-testid={
        isIncome ? 'income-categories-section' : 'expense-categories-section'
      }
      className="flex flex-col gap-4"
    >
      <h2 className="text-base font-semibold">
        {isIncome ? 'Income categories' : 'Expense categories'}
      </h2>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {isIncome ? 'Add Income Category' : 'Add Category'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isIncome ? (
            <div className="flex gap-2">
              <Input
                id="new-income-category-name"
                data-testid="income-category-add-input"
                type="text"
                placeholder="Name (e.g. Salary)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={40}
                className="flex-1"
              />
              <Input
                id="new-income-category-icon"
                data-testid="income-category-add-icon"
                type="text"
                placeholder="Icon (optional)"
                value={newIcon}
                onChange={(e) => setNewIcon(e.target.value)}
                className="w-32"
              />
              <Button
                data-testid="income-category-add-btn"
                type="button"
                onClick={handleAdd}
                disabled={isPending || !newName.trim()}
                className="px-3"
                aria-label="Add income category"
              >
                <Plus className="w-5 h-5" />
              </Button>
            </div>
          ) : (
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
          )}
        </CardContent>
      </Card>

      {isError ? (
        <QueryErrorState onRetry={onRetry} />
      ) : (
        <div className="flex flex-col gap-3">
          {categories.length === 0 &&
            (isIncome ? (
              <p
                data-testid="income-categories-empty"
                className="text-muted-foreground text-sm text-center py-10 italic"
              >
                No income categories yet.
              </p>
            ) : (
              <p className="text-muted-foreground text-sm text-center py-10 italic">
                No categories yet. Add one above to get started.
              </p>
            ))}
          {categories.map((cat) => (
            <CategoryRow
              key={cat.id}
              kind={kind}
              category={cat}
              onMutate={refreshRows}
              onError={onError}
            />
          ))}
        </div>
      )}
    </section>
  )
}

export function CategoriesTab() {
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: getAllCategories,
  })
  const incomeCategoriesQuery = useQuery({
    queryKey: ['incomeCategories'],
    queryFn: getAllIncomeCategories,
  })

  const refreshExpense = () =>
    queryClient.invalidateQueries({ queryKey: ['categories'] })

  const refreshIncome = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['incomeCategories'] }),
      queryClient.invalidateQueries({ queryKey: ['income'] }),
    ])

  if (categoriesQuery.isError) {
    return (
      <div data-testid="categories-tab" className="flex flex-col gap-6">
        <QueryErrorState onRetry={() => void categoriesQuery.refetch()} />
      </div>
    )
  }

  return (
    <div data-testid="categories-tab" className="flex flex-col gap-6">
      {error && (
        <Alert data-testid="categories-error" variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <CategorySection
        kind="expense"
        categories={categoriesQuery.data ?? []}
        isError={false}
        onRetry={() => void categoriesQuery.refetch()}
        onAdd={(input) => addCategory(input)}
        onMutate={refreshExpense}
        onError={setError}
      />

      <CategorySection
        kind="income"
        categories={incomeCategoriesQuery.data ?? []}
        isError={incomeCategoriesQuery.isError}
        onRetry={() => void incomeCategoriesQuery.refetch()}
        onAdd={(input) => addIncomeCategory(input)}
        onMutate={refreshIncome}
        onError={setError}
      />
    </div>
  )
}
