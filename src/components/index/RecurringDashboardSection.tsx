import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'

import type { Category, RecurringItem } from '@/lib/domain'
import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { currencyLabel, formatFullDate } from '@/i18n/format'
import { spaceQueryKey, useActiveSpace, useSpaceDb } from '@/lib/spaces/react'
import {
  dueOccurrences,
  formatRecurringAmount,
  upcomingOccurrences,
} from '@/lib/recurrence'
import { QueryErrorState } from '@/components/QueryErrorState'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const RECURRING_QUERY_KEYS = [
  ['recurring'],
  ['expenses'],
  ['income'],
  ['analytics'],
]

function formatDate(date: string): string {
  return formatFullDate(date)
}

function occurrenceKey(itemId: string, date: string): string {
  return `${itemId}:${date}`
}

// Dashboard cards for recurring items: "Due" (ask-mode occurrences waiting
// for Add or Skip) and "Upcoming" (the next 7 days). Renders nothing when
// there are no recurring items.
export default function RecurringDashboardSection({
  today,
}: {
  today: string
}) {
  const queryClient = useQueryClient()
  const { t } = useT()
  // Amount inputs per due occurrence, as typed.
  const [amounts, setAmounts] = useState<Partial<Record<string, string>>>(
    {},
  )

  const spaceId = useActiveSpace()
  const db = useSpaceDb()

  const recurringQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'recurring'),
    queryFn: () => db.getAllRecurring(),
  })
  const categoriesQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'categories'),
    queryFn: () => db.getAllCategories(),
  })
  const incomeCategoriesQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'incomeCategories'),
    queryFn: () => db.getAllIncomeCategories(),
  })
  const queries = [recurringQuery, categoriesQuery, incomeCategoriesQuery]
  const failedQueries = queries.filter((q) => q.isError)

  const items = recurringQuery.data
  const due = useMemo(() => dueOccurrences(items ?? [], today), [items, today])
  const upcoming = useMemo(
    () => upcomingOccurrences(items ?? [], today),
    [items, today],
  )

  const onDone = () => {
    for (const queryKey of RECURRING_QUERY_KEYS) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }
  const onFailed = (error: Error) => {
    toast.error(errorMessage(error))
  }

  const confirmMutation = useMutation({
    mutationFn: ({
      item,
      date,
      amount,
    }: {
      item: RecurringItem
      date: string
      amount: number
    }) =>
      db.confirmRecurringOccurrence(
        item.id,
        date,
        amount === item.amount ? undefined : { amount },
      ),
    onSuccess: onDone,
    onError: onFailed,
  })

  const skipMutation = useMutation({
    mutationFn: ({ item, date }: { item: RecurringItem; date: string }) =>
      db.skipRecurringOccurrence(item.id, date),
    onSuccess: onDone,
    onError: onFailed,
  })

  if (failedQueries.length > 0) {
    return (
      <QueryErrorState
        onRetry={() => failedQueries.forEach((q) => void q.refetch())}
      />
    )
  }
  if (queries.some((q) => q.isPending)) return null
  if (!items || items.length === 0) return null

  const categoryMaps: Record<RecurringItem['kind'], Map<string, Category>> = {
    expense: new Map((categoriesQuery.data ?? []).map((c) => [c.id, c])),
    income: new Map((incomeCategoriesQuery.data ?? []).map((c) => [c.id, c])),
  }
  const nameOf = (item: RecurringItem) =>
    item.description ||
    categoryMaps[item.kind].get(item.categoryId)?.name ||
    t('recurring.unknownCategory')

  const busy = confirmMutation.isPending || skipMutation.isPending

  const handleAdd = (item: RecurringItem, date: string) => {
    const text = amounts[occurrenceKey(item.id, date)]
    const amount = text === undefined ? item.amount : Number(text)
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(t('errors.validation.amountPositive'))
      return
    }
    confirmMutation.mutate({ item, date, amount })
  }

  return (
    <section className="flex flex-col gap-4">
      {due.length > 0 && (
        <Card data-testid="recurring-due" className="border-border bg-card/50">
          <CardHeader>
            <CardTitle className="text-lg">{t('recurring.due')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {due.map(({ item, occurrenceDate }) => {
              const key = occurrenceKey(item.id, occurrenceDate)
              return (
                <div
                  key={key}
                  data-testid="recurring-due-row"
                  className="flex flex-wrap items-center gap-2"
                >
                  <div className="flex-1 min-w-[8rem]">
                    <p className="text-sm font-medium">{nameOf(item)}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(occurrenceDate)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <input
                      aria-label={t('common.amount')}
                      data-testid="recurring-due-amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={amounts[key] ?? String(item.amount)}
                      onChange={(e) =>
                        setAmounts((prev) => ({
                          ...prev,
                          [key]: e.target.value,
                        }))
                      }
                      disabled={busy}
                      className="h-9 w-24 rounded-md border border-input bg-background px-2 text-sm"
                    />
                    <span className="text-xs text-muted-foreground">
                      {currencyLabel(item.currency)}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      data-testid="recurring-due-add"
                      onClick={() => handleAdd(item, occurrenceDate)}
                      disabled={busy}
                    >
                      {t('common.add')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid="recurring-due-skip"
                      onClick={() =>
                        skipMutation.mutate({ item, date: occurrenceDate })
                      }
                      disabled={busy}
                    >
                      {t('recurring.skip')}
                    </Button>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      <Card
        data-testid="recurring-upcoming"
        className="border-border bg-card/50"
      >
        <CardHeader>
          <CardTitle className="text-lg">{t('recurring.upcoming')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {upcoming.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('recurring.nothingUpcoming')}
            </p>
          ) : (
            upcoming.map(({ item, occurrenceDate }) => (
              <div
                key={occurrenceKey(item.id, occurrenceDate)}
                data-testid="recurring-upcoming-row"
                className="flex items-baseline justify-between gap-2 text-sm"
              >
                <span className="flex-1 truncate">{nameOf(item)}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {formatDate(occurrenceDate)}
                </span>
                <span className="font-medium whitespace-nowrap">
                  {formatRecurringAmount(item.amount, item.currency)}
                </span>
              </div>
            ))
          )}
          <Link
            to="/recurring"
            data-testid="recurring-upcoming-link"
            className="text-sm text-primary underline-offset-4 hover:underline self-start"
          >
            {t('recurring.allRecurring')}
          </Link>
        </CardContent>
      </Card>
    </section>
  )
}
