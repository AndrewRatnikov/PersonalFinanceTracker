import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'

import type { CreateRecurringInput, RecurringItem } from '@/lib/domain'
import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import {
  addRecurring,
  deleteRecurring,
  getAllCategories,
  getAllIncomeCategories,
  getAllRecurring,
  setRecurringPaused,
  updateRecurring,
} from '@/lib/localDb'
import { formatMoney } from '@/lib/money'
import { rateProvider } from '@/lib/rates'
import {
  addDaysToDate,
  formatRecurringAmount,
  monthlyTotals,
  monthlyTotalsInMain,
  nextOccurrence,
  nextUnhandledOccurrence,
  toLocalDateString,
} from '@/lib/recurrence'
import { useCurrencySettings } from '@/lib/useCurrencySettings'
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

function RecurringPage() {
  const queryClient = useQueryClient()
  const { t } = useT()
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
  const currencySettingsQuery = useCurrencySettings()
  const mainCurrency =
    currencySettingsQuery.data?.mainCurrency ?? DEFAULT_MAIN_CURRENCY
  const fetchExchangeRates =
    currencySettingsQuery.data?.fetchExchangeRates ?? true
  const queries = [
    recurringQuery,
    categoriesQuery,
    incomeCategoriesQuery,
    currencySettingsQuery,
  ]
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

  // Today's rates, only when an active item is in another currency. Kept in
  // the in-memory query cache only; nothing is persisted.
  const needsRates = useMemo(() => {
    const yesterday = addDaysToDate(today, -1)
    return (items ?? []).some(
      (item) =>
        !item.paused &&
        item.currency !== mainCurrency &&
        nextOccurrence(item, yesterday) !== null,
    )
  }, [items, today, mainCurrency])
  const ratesQuery = useQuery({
    queryKey: ['rates', today],
    queryFn: () => rateProvider.getRates(today),
    enabled:
      currencySettingsQuery.data !== undefined &&
      fetchExchangeRates &&
      needsRates,
    retry: false,
    staleTime: Infinity,
  })
  const mainTotals = useMemo(
    () =>
      monthlyTotalsInMain(
        items ?? [],
        today,
        mainCurrency,
        ratesQuery.data ?? null,
      ),
    [items, today, mainCurrency, ratesQuery.data],
  )
  // Shown with the per-currency fallback once it's clear no rates will come.
  const ratesUnavailable =
    mainTotals === null && (ratesQuery.isError || !fetchExchangeRates)

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
      toast.success(t('toasts.recurringSaved'))
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
      toast.success(t('toasts.recurringDeleted'))
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
              {t('recurring.committedPerMonth')}
            </h3>
            {totals.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('recurring.nothingCommitted')}
              </p>
            ) : mainTotals !== null ? (
              <ul className="flex flex-col gap-1">
                {mainTotals.map(({ kind, total, approximate }) => (
                  <li
                    key={kind}
                    data-testid={`recurring-monthly-main-${kind}`}
                    className="flex items-baseline justify-between gap-4 text-sm"
                  >
                    <span className="text-muted-foreground">
                      {kind === 'expense' ? t('recurring.expenses') : t('recurring.income')}
                    </span>
                    <span
                      className={`font-semibold ${kind === 'income' ? 'text-emerald-600' : 'text-foreground'}`}
                    >
                      {`${approximate ? '≈ ' : ''}${formatMoney(total, mainCurrency)}`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="flex flex-col gap-1">
                {totals.map(({ kind, currency, total }) => (
                  <li
                    key={`${kind}-${currency}`}
                    data-testid={`recurring-monthly-total-${kind}-${currency}`}
                    className="flex items-baseline justify-between gap-4 text-sm"
                  >
                    <span className="text-muted-foreground">
                      {kind === 'expense' ? t('recurring.expenses') : t('recurring.income')}
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
            {totals.length > 0 && ratesUnavailable && (
              <p
                data-testid="recurring-rates-unavailable"
                className="text-xs text-muted-foreground"
              >
                {t('recurring.ratesUnavailable')}
              </p>
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
            defaultCurrency={mainCurrency}
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
              {t('recurring.empty')}
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
              {t('recurring.title')}
            </h2>
            <p className="text-muted-foreground">{t('recurring.subtitle')}</p>
          </div>
          <Button
            type="button"
            data-testid="recurring-add-btn"
            onClick={() => setForm({ mode: 'create' })}
            className="bg-[#6366f1] hover:bg-[#4f46e5] text-white border-0"
          >
            <Plus size={16} />
            {t('common.add')}
          </Button>
        </div>

        {content}
      </div>
    </PageShell>
  )
}
