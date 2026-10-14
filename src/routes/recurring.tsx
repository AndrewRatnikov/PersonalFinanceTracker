import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'

import type { CreateRecurringInput, RecurringItem } from '@/lib/domain'
import {
  addRecurring,
  deleteRecurring,
  getAllCategories,
  getAllIncomeCategories,
  getAllRecurring,
  setRecurringPaused,
  updateRecurring,
} from '@/lib/localDb'
import {
  formatRecurringAmount,
  monthlyTotals,
  nextUnhandledOccurrence,
  toLocalDateString,
} from '@/lib/recurrence'
import PageShell from '@/components/PageShell'
import { QueryErrorState } from '@/components/QueryErrorState'
import RecurringForm from '@/components/recurring/RecurringForm'
import RecurringRow from '@/components/recurring/RecurringRow'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

export const Route = createFileRoute('/recurring')({
  component: RecurringPage,
})

// Generation can add expenses and income, so every recurring change refreshes
// those views too.
const RECURRING_QUERY_KEYS = [
  ['recurring'],
  ['expenses'],
  ['income'],
  ['analytics'],
]

type FormState = { mode: 'create' } | { mode: 'edit'; item: RecurringItem }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function RecurringPage() {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<FormState | null>(null)
  const today = toLocalDateString()

  const recurringQuery = useQuery({
    queryKey: ['recurring'],
    queryFn: getAllRecurring,
  })
  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: getAllCategories,
  })
  const incomeCategoriesQuery = useQuery({
    queryKey: ['incomeCategories'],
    queryFn: getAllIncomeCategories,
  })
  const queries = [recurringQuery, categoriesQuery, incomeCategoriesQuery]
  const failedQueries = queries.filter((q) => q.isError)
  const isPending = queries.some((q) => q.isPending)

  const items = recurringQuery.data
  const expenseCategories = categoriesQuery.data
  const incomeCategories = incomeCategoriesQuery.data

  const sortedItems = useMemo(() => {
    // Soonest next occurrence first; ended items (no next date) last.
    const withNext = (items ?? []).map((item) => ({
      item,
      next: nextUnhandledOccurrence(item),
    }))
    withNext.sort((a, b) => {
      if (a.next === b.next) return 0
      if (a.next === null) return 1
      if (b.next === null) return -1
      return a.next.localeCompare(b.next)
    })
    return withNext.map((w) => w.item)
  }, [items])

  const totals = useMemo(
    () => monthlyTotals(items ?? [], today),
    [items, today],
  )

  const invalidateAll = () => {
    for (const queryKey of RECURRING_QUERY_KEYS) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }

  const saveMutation = useMutation({
    mutationFn: async ({
      input,
      createThroughToday,
      editing,
    }: {
      input: CreateRecurringInput
      createThroughToday: boolean
      editing: RecurringItem | null
    }) => {
      if (editing) await updateRecurring(editing.id, input)
      else await addRecurring(input, { createThroughToday })
    },
    onSuccess: () => {
      setForm(null)
      invalidateAll()
      toast.success('Recurring item saved')
    },
    onError: (error) => {
      toast.error(errorMessage(error))
    },
  })

  const pauseMutation = useMutation({
    mutationFn: (item: RecurringItem) =>
      setRecurringPaused(item.id, !item.paused),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recurring'] })
    },
    onError: (error) => {
      toast.error(errorMessage(error))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (item: RecurringItem) => deleteRecurring(item.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recurring'] })
      toast.success('Recurring item deleted')
    },
    onError: (error) => {
      toast.error(errorMessage(error))
    },
  })

  const handleSubmit = async (
    input: CreateRecurringInput,
    options: { createThroughToday: boolean },
  ) => {
    await saveMutation.mutateAsync({
      input,
      createThroughToday: options.createThroughToday,
      editing: form?.mode === 'edit' ? form.item : null,
    })
  }

  const categoryOf = (item: RecurringItem) =>
    (item.kind === 'income' ? incomeCategories : expenseCategories)?.find(
      (c) => c.id === item.categoryId,
    )

  const rowsBusy = pauseMutation.isPending || deleteMutation.isPending

  let content: React.ReactNode = null
  if (failedQueries.length > 0) {
    content = (
      <QueryErrorState
        onRetry={() => failedQueries.forEach((q) => void q.refetch())}
      />
    )
  } else if (!isPending && items && expenseCategories && incomeCategories) {
    content = (
      <div className="flex flex-col gap-6">
        <Card
          data-testid="recurring-monthly-total"
          className="border-border bg-card/50"
        >
          <CardContent className="py-4 flex flex-col gap-2">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Committed per month
            </h3>
            {totals.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing committed yet
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {totals.map(({ kind, currency, total }) => (
                  <li
                    key={`${kind}-${currency}`}
                    data-testid={`recurring-monthly-total-${kind}-${currency}`}
                    className="flex items-baseline justify-between gap-4 text-sm"
                  >
                    <span className="text-muted-foreground">
                      {kind === 'expense' ? 'Expenses' : 'Income'}
                    </span>
                    <span
                      className={`font-semibold ${kind === 'income' ? 'text-emerald-600' : 'text-foreground'}`}
                    >
                      {formatRecurringAmount(total, currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {form && (
          <RecurringForm
            key={form.mode === 'edit' ? form.item.id : 'new'}
            expenseCategories={expenseCategories}
            incomeCategories={incomeCategories}
            today={today}
            initial={form.mode === 'edit' ? form.item : undefined}
            isPending={saveMutation.isPending}
            onSubmit={handleSubmit}
            onCancel={() => setForm(null)}
          />
        )}

        {sortedItems.length === 0 ? (
          <Card className="border-dashed bg-transparent">
            <CardContent
              data-testid="recurring-empty"
              className="flex items-center justify-center py-10 text-muted-foreground"
            >
              No recurring items yet
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {sortedItems.map((item) => (
              <RecurringRow
                key={item.id}
                item={item}
                category={categoryOf(item)}
                isBusy={rowsBusy}
                onEdit={(i) => setForm({ mode: 'edit', item: i })}
                onTogglePaused={(i) => pauseMutation.mutate(i)}
                onDelete={(i) => deleteMutation.mutate(i)}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <PageShell>
      <div
        data-testid="recurring-page"
        className="p-4 md:p-8 max-w-3xl mx-auto min-h-screen animate-in fade-in duration-500"
      >
        <div className="flex items-start justify-between gap-4 mb-8">
          <div className="space-y-1">
            <h2 className="text-3xl font-bold tracking-tight text-foreground">
              Recurring
            </h2>
            <p className="text-muted-foreground">
              Subscriptions, rent, salary: added for you when they're due.
            </p>
          </div>
          <Button
            type="button"
            data-testid="recurring-add-btn"
            onClick={() => setForm({ mode: 'create' })}
            className="bg-[#6366f1] hover:bg-[#4f46e5] text-white border-0"
          >
            <Plus size={16} />
            Add
          </Button>
        </div>

        {content}
      </div>
    </PageShell>
  )
}
