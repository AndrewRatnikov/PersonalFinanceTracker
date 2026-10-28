import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import dayjs from 'dayjs'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import type { CreateExpenseInput, QuickRepeat } from '@/lib/domain'
import type { ExpenseDrawerInitial } from '@/lib/expenseDraft'
import { useT } from '@/i18n'

import { BackupReminderBanner } from '@/components/index/BackupReminderBanner'
import DashboardSummarySection from '@/components/index/DashboardSummarySection'
import RecentActivityList from '@/components/index/RecentActivityList'
import RecurringDashboardSection from '@/components/index/RecurringDashboardSection'
import { RecoveryKeyBanner } from '@/components/index/RecoveryKeyBanner'
import { RepeatLastChips } from '@/components/index/RepeatLastChips'
import SpeedEntryForm from '@/components/index/SpeedEntryForm'
import { InstallHintCard } from '@/components/InstallHintCard'
import LandingPage from '@/components/LandingPage'
import PageShell from '@/components/PageShell'
import { QueryErrorState } from '@/components/QueryErrorState'
import { ExpenseDrawer } from '@/components/transactions/ExpenseDrawer'
import { Card, CardContent } from '@/components/ui/card'
import { computeDashboardSummary } from '@/lib/dashboardSummary'
import { DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import { spaceQueryKey, useActiveSpace, useSpaceDb } from '@/lib/spaces/react'
import { useCurrencySettings } from '@/lib/useCurrencySettings'
import { useVaultSession } from '@/lib/vaultSession'

export const Route = createFileRoute('/')({
  component: IndexRoute,
})

// The landing page until this device's vault is unlocked (spec §2.2).
function IndexRoute() {
  const { phase } = useVaultSession()
  return phase === 'unlocked' ? <Dashboard /> : <LandingPage />
}

function Dashboard() {
  const queryClient = useQueryClient()
  const { t, lang } = useT()
  const [isPending, setIsPending] = useState(false)
  // The repeat-last "…" / long-press opens the drawer here, prefilled (local
  // state, not the URL: the user stays on the dashboard).
  const [drawerInitial, setDrawerInitial] =
    useState<ExpenseDrawerInitial | null>(null)

  const todayStr = dayjs().format('YYYY-MM-DD')
  const { from, to } = useMemo(
    () => ({
      from: dayjs(todayStr)
        .subtract(11, 'month')
        .startOf('month')
        .toISOString(),
      to: dayjs(todayStr).endOf('day').toISOString(),
    }),
    [todayStr],
  )

  const spaceId = useActiveSpace()
  const db = useSpaceDb()

  const categoriesQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'categories'),
    queryFn: () => db.getAllCategories(),
  })
  const categories = categoriesQuery.data ?? []

  const expensesQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'expenses', from, to),
    queryFn: () => db.getExpensesForRange(from, to),
  })
  const expenses = expensesQuery.data ?? []

  const incomeQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'income'),
    queryFn: () => db.getAllIncome(),
  })
  const income = incomeQuery.data ?? []

  const budgetsQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'budgets'),
    queryFn: () => db.getAllBudgets(),
  })
  const budgets = budgetsQuery.data ?? []

  const currencySettingsQuery = useCurrencySettings()
  const mainCurrency =
    currencySettingsQuery.data?.mainCurrency ?? DEFAULT_MAIN_CURRENCY
  const fetchExchangeRates =
    currencySettingsQuery.data?.fetchExchangeRates ?? true

  // Never show default zeros for data that failed to load.
  const failedQueries = [
    categoriesQuery,
    expensesQuery,
    incomeQuery,
    budgetsQuery,
  ].filter((q) => q.isError)

  const summary = useMemo(
    () =>
      computeDashboardSummary({
        expenses,
        income,
        budgets,
        categories,
        now: new Date(),
        mainCurrency,
      }),
    // todayStr recomputes the summary when the day changes; lang re-labels
    // the "Uncategorized" fallback.
    [expenses, income, budgets, categories, mainCurrency, todayStr, lang],
  )

  const addMutation = useMutation({
    mutationFn: ({
      data,
      repeat,
    }: {
      data: CreateExpenseInput
      repeat: QuickRepeat
    }) =>
      repeat === 'none'
        ? db.addExpense(data)
        : db.addRepeatingExpense(data, repeat),
    onSuccess: (_saved, { repeat }) => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      // A repeat also created a recurring item.
      if (repeat !== 'none') {
        void queryClient.invalidateQueries({ queryKey: ['recurring'] })
      }
      toast.success(t('toasts.expenseSaved'))
    },
    onError: (error: any) => {
      console.error('Failed to create expense:', error)
      toast.error(t('toasts.expenseSaveFailed'))
    },
  })

  const handleCreateExpense = async (
    data: CreateExpenseInput,
    repeat: QuickRepeat,
  ) => {
    setIsPending(true)
    try {
      await addMutation.mutateAsync({ data, repeat })
    } finally {
      setIsPending(false)
    }
  }

  if (failedQueries.length > 0) {
    return (
      <PageShell>
        <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
          <QueryErrorState
            onRetry={() => failedQueries.forEach((q) => void q.refetch())}
          />
        </div>
      </PageShell>
    )
  }

  // Until every query has settled, render no data content: default zeros
  // would be misleading, and the summary's links must not mount before the
  // data they describe exists.
  const isLoading = [
    categoriesQuery,
    expensesQuery,
    incomeQuery,
    budgetsQuery,
    currencySettingsQuery,
  ].some((q) => q.isPending)

  if (isLoading) {
    return (
      <PageShell>
        <div
          className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8"
          aria-busy="true"
        />
      </PageShell>
    )
  }

  return (
    <PageShell>
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
        <InstallHintCard />
        <RecoveryKeyBanner />
        <BackupReminderBanner />
        <DashboardSummarySection
          summary={summary}
          fetchExchangeRates={fetchExchangeRates}
        />
        <RecurringDashboardSection today={todayStr} />

        <section>
          <h2 className="text-xl font-bold mb-4">{t('dashboard.quickAdd.title')}</h2>
          {categories.length > 0 ? (
            <div className="flex flex-col gap-4">
              <RepeatLastChips
                expenses={expenses}
                categories={categories}
                onCustomize={setDrawerInitial}
              />
              <SpeedEntryForm
                categories={categories}
                onSubmit={handleCreateExpense}
                isPending={isPending}
                defaultCurrency={mainCurrency}
                entries={expenses}
              />
            </div>
          ) : (
            <Card className="border-dashed bg-transparent">
              <CardContent className="flex items-center justify-center py-10 text-muted-foreground">
                {t('dashboard.quickAdd.noCategories')}
              </CardContent>
            </Card>
          )}
        </section>

        <section>
          <RecentActivityList
            items={summary.recent}
            mainCurrency={mainCurrency}
          />
        </section>
      </div>

      <ExpenseDrawer
        key={JSON.stringify(drawerInitial)}
        mode="add"
        open={drawerInitial !== null}
        onOpenChange={(open) => {
          if (!open) setDrawerInitial(null)
        }}
        initial={drawerInitial ?? undefined}
        categories={categories}
        mainCurrency={mainCurrency}
        entries={expenses}
      />
    </PageShell>
  )
}
