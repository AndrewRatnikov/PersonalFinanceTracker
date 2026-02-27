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
      <section>
        <DashboardStats data={monthlyStats} />
      </section>

      <section>
        <h2 className="text-xl font-bold text-white mb-4">Quick Add</h2>
        {categories.length > 0 ? (
          <SpeedEntryForm
            categories={categories}
            onSubmit={handleCreateExpense}
            isPending={isPending}
          />
        ) : (
          <div className="p-6 bg-slate-800/40 rounded-2xl border border-dashed border-slate-700/50 text-center text-slate-400">
            No categories found. Please create some categories first.
          </div>
        )}
      </section>

      <section>
        <RecentHistoryList expenses={recentExpenses} />
      </section>
    </PageShell>
  )
}
