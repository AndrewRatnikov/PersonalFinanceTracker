import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import dayjs from 'dayjs'

import type { CreateExpenseInput, Expense, MonthlyExpenseSummary } from '@/lib/domain'
import { getAllCategories, addExpense, getExpensesForRange } from '@/lib/localDb'
import DashboardStats from '@/components/index/DashboardStats'
import SpeedEntryForm from '@/components/index/SpeedEntryForm'
import RecentHistoryList from '@/components/index/RecentHistoryList'
import PageShell from '@/components/PageShell'
import { Card, CardContent } from '@/components/ui/card'
import { toast } from 'sonner'

export const Route = createFileRoute('/')({
  component: Dashboard,
})

function computeMonthlyStats(expenses: Array<Expense>): Array<MonthlyExpenseSummary> {
  const monthlyMap: Record<string, number> = {}
  for (let i = 11; i >= 0; i--) {
    const d = dayjs().subtract(i, 'month')
    const key = `${d.year()}-${d.format('MMM')}`
    monthlyMap[key] = 0
  }
  for (const e of expenses) {
    const d = dayjs(e.createdAt)
    const key = `${d.year()}-${d.format('MMM')}`
    if (key in monthlyMap) monthlyMap[key] += Number(e.amount)
  }
  return Object.entries(monthlyMap).map(([key, total]) => {
    const [year, month] = key.split('-')
    return { month, year, name: month, total }
  })
}

function Dashboard() {
  const queryClient = useQueryClient()
  const [isPending, setIsPending] = useState(false)

  const todayStr = dayjs().format('YYYY-MM-DD')
  const { from, to } = useMemo(() => ({
    from: dayjs(todayStr).subtract(11, 'month').startOf('month').toISOString(),
    to: dayjs(todayStr).endOf('day').toISOString(),
  }), [todayStr])

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: getAllCategories,
  })

  const { data: expenses = [] } = useQuery({
    queryKey: ['expenses', from, to],
    queryFn: () => getExpensesForRange(from, to),
  })

  const monthlyStats = useMemo(() => computeMonthlyStats(expenses), [expenses])
  const recentExpenses = useMemo(() => expenses.slice(0, 10), [expenses])

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
        <section>
          <DashboardStats data={monthlyStats} />
        </section>

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
          <RecentHistoryList expenses={recentExpenses} />
        </section>
      </div>
    </PageShell>
  )
}
