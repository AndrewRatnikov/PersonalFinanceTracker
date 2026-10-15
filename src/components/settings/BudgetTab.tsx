import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import type { BudgetEntry, Category, Currency } from '@/lib/domain'
import { DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import { deleteBudget, getAllBudgets, upsertBudget } from '@/lib/localDb'
import { useCurrencySettings } from '@/lib/useCurrencySettings'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Card, CardContent } from '@/components/ui/card'
import { QueryErrorState } from '@/components/QueryErrorState'

interface BudgetRowProps {
  category: Category
  existingBudget:
    | (BudgetEntry & { categoryName: string; categoryIcon: string | null })
    | undefined
  // Budgets are always saved in the main currency.
  mainCurrency: Currency
  settingsReady: boolean
}

function BudgetRow({
  category,
  existingBudget,
  mainCurrency,
  settingsReady,
}: BudgetRowProps) {
  const queryClient = useQueryClient()
  const [limit, setLimit] = useState(
    existingBudget ? String(existingBudget.monthlyLimit) : '',
  )

  const saveMutation = useMutation({
    mutationFn: () =>
      upsertBudget({
        categoryId: category.id,
        monthlyLimit: Number(limit),
        currency: mainCurrency,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      toast.success('Budget saved')
    },
    onError: (error: any) => {
      toast.error(`Failed to save budget: ${error.message}`)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteBudget(existingBudget!.id),
    onSuccess: () => {
      setLimit('')
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      toast.success('Budget removed')
    },
    onError: (error: any) => {
      toast.error(`Failed to remove budget: ${error.message}`)
    },
  })

  const isPending = saveMutation.isPending || deleteMutation.isPending
  const canSave =
    settingsReady && limit.trim() !== '' && Number(limit) > 0 && !isPending
  // A budget saved in another currency waits for the one-time conversion.
  const storedElsewhere =
    existingBudget !== undefined && existingBudget.currency !== mainCurrency

  return (
    <Card className="border-border bg-card/40">
      <CardContent className="px-3 py-2.5 flex items-center gap-3">
        {category.icon && (
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-secondary/50 text-base shadow-sm flex-shrink-0">
            {category.icon}
          </div>
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          <span className="text-sm font-medium text-foreground truncate">
            {category.name}
          </span>
          {storedElsewhere && (
            <span className="text-xs text-muted-foreground">
              {`Saved in ${existingBudget.currency}; converted to ${mainCurrency} when today's rate is available`}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Input
            type="number"
            min="0.01"
            step="0.01"
            placeholder="Limit"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            disabled={isPending}
            className="w-28 h-8 text-sm"
          />
          <span
            data-testid="budget-row-currency"
            className="w-10 text-xs font-medium text-muted-foreground"
          >
            {mainCurrency}
          </span>

          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={!canSave}
            className="h-8 px-3 text-xs"
          >
            {saveMutation.isPending ? 'Saving…' : 'Save'}
          </Button>

          {existingBudget && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={isPending}
                  className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-transparent transition-colors"
                  aria-label="Remove budget"
                >
                  <Trash2 size={14} />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove Budget</AlertDialogTitle>
                  <AlertDialogDescription>
                    Remove the monthly limit for{' '}
                    <strong>{category.name}</strong>? This will stop tracking
                    budget vs. actual for this category.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => deleteMutation.mutate()}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Remove
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

interface BudgetTabProps {
  categories: Array<Category>
}

export function BudgetTab({ categories }: BudgetTabProps) {
  const budgetsQuery = useQuery({
    queryKey: ['budgets'],
    queryFn: () => getAllBudgets(),
  })
  const budgets = budgetsQuery.data ?? []
  const settingsQuery = useCurrencySettings()
  const mainCurrency = settingsQuery.data?.mainCurrency ?? DEFAULT_MAIN_CURRENCY
  const settingsReady = settingsQuery.data !== undefined

  const budgetMap = new Map(budgets.map((b) => [b.categoryId, b]))

  // Never show empty limits for budgets that failed to load.
  if (budgetsQuery.isError) {
    return <QueryErrorState onRetry={() => void budgetsQuery.refetch()} />
  }

  if (budgetsQuery.isLoading) {
    return (
      <p className="text-muted-foreground text-sm text-center py-10 italic">
        Loading budgets…
      </p>
    )
  }

  if (categories.length === 0) {
    return (
      <p
        data-testid="budget-tab"
        className="text-muted-foreground text-sm text-center py-10 italic"
      >
        No categories yet. Add some in the Categories tab first.
      </p>
    )
  }

  return (
    <div data-testid="budget-tab" className="flex flex-col gap-3">
      {categories.map((cat) => (
        <BudgetRow
          key={`${cat.id}-${budgetMap.get(cat.id)?.id ?? 'new'}`}
          category={cat}
          existingBudget={budgetMap.get(cat.id)}
          mainCurrency={mainCurrency}
          settingsReady={settingsReady}
        />
      ))}
    </div>
  )
}
