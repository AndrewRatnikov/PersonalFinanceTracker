import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { CategoryRow } from './CategoryRow'
import type { Category } from '@/lib/domain'
import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { copyCategoriesFromSpace } from '@/lib/localDb'
import { spaceQueryKey, useActiveSpace, useSpaceDb } from '@/lib/spaces/react'
import { useSpaceSwitch } from '@/lib/spaces/switcher'
import { PERSONAL_SPACE_ID } from '@/lib/spaces/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { QueryErrorState } from '@/components/QueryErrorState'
import { SpaceSettingsHeader } from '@/components/space/SpaceSettingsHeader'

type CategoryKind = 'expense' | 'income'

interface CategorySectionProps {
  kind: CategoryKind
  categories: Array<Category>
  isError: boolean
  onRetry: () => void
  onAdd: (input: { name: string; icon: string | null }) => Promise<unknown>
  onMutate: () => Promise<unknown>
  onError: (msg: string | null) => void
  /** A read-only Family copy: adding is disabled. */
  readOnly: boolean
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
  readOnly,
}: CategorySectionProps) {
  const [isPending, setIsPending] = useState(false)
  const [newName, setNewName] = useState('')
  const [newIcon, setNewIcon] = useState('')
  const isIncome = kind === 'income'
  const { t } = useT()

  const handleAdd = async () => {
    onError(null)
    setIsPending(true)
    try {
      await onAdd({ name: newName, icon: newIcon || null })
      setNewName('')
      setNewIcon('')
      await onMutate()
    } catch (e: unknown) {
      onError(errorMessage(e))
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
        {isIncome ? t('settings.categories.income') : t('settings.categories.expense')}
      </h2>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {isIncome ? t('settings.categories.addIncome') : t('settings.categories.add')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isIncome ? (
            <div className="flex gap-2">
              <Input
                id="new-income-category-name"
                data-testid="income-category-add-input"
                type="text"
                placeholder={t('settings.categories.incomeNamePlaceholder')}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={40}
                className="flex-1"
              />
              <Input
                id="new-income-category-icon"
                data-testid="income-category-add-icon"
                type="text"
                placeholder={t('settings.categories.iconPlaceholder')}
                value={newIcon}
                onChange={(e) => setNewIcon(e.target.value)}
                className="w-32"
              />
              <Button
                data-testid="income-category-add-btn"
                type="button"
                onClick={handleAdd}
                disabled={isPending || readOnly || !newName.trim()}
                className="px-3"
                aria-label={t('settings.categories.addIncomeLabel')}
              >
                <Plus className="w-5 h-5" />
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                id="new-category-name"
                type="text"
                placeholder={t('settings.categories.expenseNamePlaceholder')}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={40}
                className="flex-1"
              />
              <Input
                id="new-category-icon"
                type="text"
                placeholder={t('settings.categories.iconPlaceholder')}
                value={newIcon}
                onChange={(e) => setNewIcon(e.target.value)}
                className="w-32"
              />
              <Button
                id="add-category-btn"
                data-testid="category-add-btn"
                type="button"
                onClick={handleAdd}
                disabled={isPending || readOnly || !newName.trim()}
                className="px-3"
                aria-label={t('settings.categories.addLabel')}
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
                {t('settings.categories.incomeEmpty')}
              </p>
            ) : (
              <p className="text-muted-foreground text-sm text-center py-10 italic">
                {t('settings.categories.expenseEmpty')}
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

  const spaceId = useActiveSpace()
  const db = useSpaceDb()
  const { t, plural } = useT()
  const { isFamily, readOnly } = useSpaceSwitch()
  const [copying, setCopying] = useState(false)

  const categoriesQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'categories'),
    queryFn: () => db.getAllCategories(),
  })
  const incomeCategoriesQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'incomeCategories'),
    queryFn: () => db.getAllIncomeCategories(),
  })

  const refreshExpense = () =>
    queryClient.invalidateQueries({ queryKey: ['categories'] })

  const refreshIncome = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['incomeCategories'] }),
      queryClient.invalidateQueries({ queryKey: ['income'] }),
    ])

  // Family only: adds every Personal category whose name is missing here.
  const copyFromPersonal = async () => {
    setError(null)
    setCopying(true)
    try {
      const result = await copyCategoriesFromSpace({ from: PERSONAL_SPACE_ID, to: spaceId })
      const added = result.categories + result.incomeCategories
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['categories'] }),
        queryClient.invalidateQueries({ queryKey: ['incomeCategories'] }),
      ])
      if (added > 0) toast.success(plural('move.copyCategoriesDone', added))
      else toast(t('move.copyCategoriesNone'))
    } catch (e: unknown) {
      setError(errorMessage(e))
    } finally {
      setCopying(false)
    }
  }

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

      <SpaceSettingsHeader />

      {isFamily && (
        <div>
          <Button
            type="button"
            variant="outline"
            data-testid="categories-copy-from-personal"
            onClick={() => void copyFromPersonal()}
            disabled={copying || readOnly}
            className="min-h-11 sm:min-h-9"
          >
            <Copy className="h-4 w-4" />
            {t('move.copyCategories')}
          </Button>
        </div>
      )}

      <CategorySection
        kind="expense"
        categories={categoriesQuery.data ?? []}
        isError={false}
        onRetry={() => void categoriesQuery.refetch()}
        onAdd={(input) => db.addCategory(input)}
        onMutate={refreshExpense}
        onError={setError}
        readOnly={readOnly}
      />

      <CategorySection
        kind="income"
        categories={incomeCategoriesQuery.data ?? []}
        isError={incomeCategoriesQuery.isError}
        onRetry={() => void incomeCategoriesQuery.refetch()}
        onAdd={(input) => db.addIncomeCategory(input)}
        onMutate={refreshIncome}
        onError={setError}
        readOnly={readOnly}
      />
    </div>
  )
}
