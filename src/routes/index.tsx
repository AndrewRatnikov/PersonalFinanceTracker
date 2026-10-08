import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import dayjs from 'dayjs'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import type { CreateExpenseInput } from '@/lib/domain'

import DashboardSummarySection from '@/components/index/DashboardSummarySection'
import RecentActivityList from '@/components/index/RecentActivityList'
import SpeedEntryForm from '@/components/index/SpeedEntryForm'
import { InstallHintCard } from '@/components/InstallHintCard'
import LandingPage from '@/components/LandingPage'
import PageShell from '@/components/PageShell'
import { QueryErrorState } from '@/components/QueryErrorState'
import { Card, CardContent } from '@/components/ui/card'
import { computeDashboardSummary } from '@/lib/dashboardSummary'
import {
  addExpense,
  getAllBudgets,
  getAllCategories,
  getAllIncome,
  getExpensesForRange,
} from '@/lib/localDb'
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
  const [isPending, setIsPending] = useState(false)

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

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: getAllCategories,
  })
  const categories = categoriesQuery.data ?? []

  const expensesQuery = useQuery({
    queryKey: ['expenses', from, to],
    queryFn: () => getExpensesForRange(from, to),
  })
  const expenses = expensesQuery.data ?? []

  const incomeQuery = useQuery({
    queryKey: ['income'],
    queryFn: getAllIncome,
  })
  const income = incomeQuery.data ?? []

  const budgetsQuery = useQuery({
    queryKey: ['budgets'],
    queryFn: getAllBudgets,
  })
  const budgets = budgetsQuery.data ?? []

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
      }),
    // todayStr recomputes the summary when the day changes.
    [expenses, income, budgets, categories, todayStr],
  )

  const addMutation = useMutation({
    mutationFn: (data: CreateExpenseInput) => addExpense(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      toast.success('Expense saved')
    },
    onError: (error: any) => {
      console.error('Failed to create expense:', error)
      toast.error('Failed to save expense. Please try again.')
    },
  })

  const handleCreateExpense = async (data: CreateExpenseInput) => {
    setIsPending(true)
    try {
      await addMutation.mutateAsync(data)
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
        <DashboardSummarySection summary={summary} />

        <section>
          <h2 className="text-xl font-bold mb-4">Quick Add</h2>
          {categories.length > 0 ? (
            <SpeedEntryForm
              categories={categories}
              onSubmit={handleCreateExpense}
              isPending={isPending}
            />
          ) : (
            <Card className="border-dashed bg-transparent">
              <CardContent className="flex items-center justify-center py-10 text-muted-foreground">
                No categories found. Please create some categories first.
              </CardContent>
            </Card>
          )}
        </section>

        <section>
          <RecentActivityList items={summary.recent} />
        </section>
      </div>
    </PageShell>
  )
}
