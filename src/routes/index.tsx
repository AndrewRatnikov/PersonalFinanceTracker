import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import dayjs from 'dayjs'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Route as RootRoute } from './__root'

import type { CreateExpenseInput } from '@/lib/domain'

import DashboardSummarySection from '@/components/index/DashboardSummarySection'
import RecentActivityList from '@/components/index/RecentActivityList'
import SpeedEntryForm from '@/components/index/SpeedEntryForm'
import LandingPage from '@/components/LandingPage'
import PageShell from '@/components/PageShell'
import { Card, CardContent } from '@/components/ui/card'
import { computeDashboardSummary } from '@/lib/dashboardSummary'
import {
  addExpense,
  getAllBudgets,
  getAllCategories,
  getAllIncome,
  getExpensesForRange,
} from '@/lib/localDb'

export const Route = createFileRoute('/')({
  component: IndexRoute,
})

function IndexRoute() {
  const { auth } = RootRoute.useRouteContext()
  return auth.user ? <Dashboard /> : <LandingPage />
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

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: getAllCategories,
  })

  const { data: expenses = [] } = useQuery({
    queryKey: ['expenses', from, to],
    queryFn: () => getExpensesForRange(from, to),
  })

  const { data: income = [] } = useQuery({
    queryKey: ['income'],
    queryFn: getAllIncome,
  })

  const { data: budgets = [] } = useQuery({
    queryKey: ['budgets'],
    queryFn: getAllBudgets,
  })

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

  return (
    <PageShell>
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
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
