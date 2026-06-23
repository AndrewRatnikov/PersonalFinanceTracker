import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { getAllBudgets, upsertBudget, deleteBudget } from '@/lib/localDb'
import type { BudgetEntry, Category, Currency } from '@/lib/domain'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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

interface BudgetRowProps {
  category: Category
  existingBudget: (BudgetEntry & { categoryName: string; categoryIcon: string | null }) | undefined
}

function BudgetRow({ category, existingBudget }: BudgetRowProps) {
  const queryClient = useQueryClient()
  const [limit, setLimit] = useState(
    existingBudget ? String(existingBudget.monthlyLimit) : '',
  )
  const [currency, setCurrency] = useState<Currency>(
    existingBudget?.currency ?? 'UAH',
  )

  const saveMutation = useMutation({
    mutationFn: () =>
      upsertBudget({
        categoryId: category.id,
        monthlyLimit: Number(limit),
        currency,
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
      setCurrency('UAH')
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      toast.success('Budget removed')
    },
    onError: (error: any) => {
      toast.error(`Failed to remove budget: ${error.message}`)
    },
  })

  const isPending = saveMutation.isPending || deleteMutation.isPending
  const canSave = limit.trim() !== '' && Number(limit) > 0 && !isPending

  return (
    <Card className="border-border bg-card/40">
      <CardContent className="px-3 py-2.5 flex items-center gap-3">
        {category.icon && (
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-secondary/50 text-base shadow-sm flex-shrink-0">
            {category.icon}
          </div>
        )}
        <span className="flex-1 text-sm font-medium text-foreground truncate">
          {category.name}
        </span>

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
          <Select
            value={currency}
            onValueChange={(v) => setCurrency(v as Currency)}
            disabled={isPending}
          >
            <SelectTrigger className="w-[76px] h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="UAH">UAH</SelectItem>
              <SelectItem value="USD">USD</SelectItem>
              <SelectItem value="EUR">EUR</SelectItem>
            </SelectContent>
          </Select>

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
  const { data: budgets = [], isLoading } = useQuery({
    queryKey: ['budgets'],
    queryFn: () => getAllBudgets(),
  })

  const budgetMap = new Map(budgets.map((b) => [b.categoryId, b]))

  if (isLoading) {
    return (
      <p className="text-muted-foreground text-sm text-center py-10 italic">
        Loading budgets…
      </p>
    )
  }

  if (categories.length === 0) {
    return (
      <p className="text-muted-foreground text-sm text-center py-10 italic">
        No categories yet. Add some in the Categories tab first.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {categories.map((cat) => (
        <BudgetRow
          key={`${cat.id}-${budgetMap.get(cat.id)?.id ?? 'new'}`}
          category={cat}
          existingBudget={budgetMap.get(cat.id)}
        />
      ))}
    </div>
  )
}
