import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import type {
  Category,
  CreateExpenseInput,
  Expense,
  MonthlyExpenseSummary,
} from '@/lib/domain'
import { getMonthlyExpenses } from '@/lib/analytics'
import { getUserCategories } from '@/lib/categories'
import { createExpense, getRecentExpenses } from '@/lib/expenses'
import DashboardStats from '@/components/index/DashboardStats'
import SpeedEntryForm from '@/components/index/SpeedEntryForm'
import RecentHistoryList from '@/components/index/RecentHistoryList'
import PageShell from '@/components/PageShell'
import { Card, CardContent } from '@/components/ui/card'

export const Route = createFileRoute('/')({
  loader: async (): Promise<{
    monthlyStats: Array<MonthlyExpenseSummary>
    recentExpenses: Array<Expense>
    categories: Array<Category>
  }> => {
    const [monthlyStats, recentExpenses, categories] = await Promise.all([
      getMonthlyExpenses(),
      getRecentExpenses(),
      getUserCategories(),
    ])
    return {
      monthlyStats,
      recentExpenses,
      categories,
    }
  },
  component: Dashboard,
})

function Dashboard() {
  const { monthlyStats, recentExpenses, categories } = Route.useLoaderData()
  const router = useRouter()
  const [isPending, setIsPending] = useState(false)

  const handleCreateExpense = async (data: CreateExpenseInput) => {
    setIsPending(true)
    try {
      // Execute the server function to insert the record
      await createExpense(data)
      // Invalidate the router to trigger a re-fetch of the loader data
      await router.invalidate()
    } catch (error) {
      console.error('Failed to create expense:', error)
      alert('Failed to save expense. Please try again.')
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
