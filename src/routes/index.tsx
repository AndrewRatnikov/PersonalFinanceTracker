import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { getMonthlyExpenses } from '../lib/analytics'
import { getUserCategories } from '../lib/categories'
import { createExpense, getRecentExpenses } from '../lib/expenses'
import type {
  Category,
  CreateExpenseInput,
  Expense,
  MonthlyExpenseSummary,
} from '../lib/domain'
import DashboardStats from '../components/DashboardStats'
import SpeedEntryForm from '../components/SpeedEntryForm'
import RecentHistoryList from '../components/RecentHistoryList'

export const Route = createFileRoute('/')({
  loader: async (): Promise<{
    monthlyStats: MonthlyExpenseSummary[]
    recentExpenses: Expense[]
    categories: Category[]
  }> => {
    // Fetch all necessary dashboard data in parallel
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
    <div className="min-h-screen bg-slate-900 pb-20">
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
        {/* Header / Stats View */}
        <section>
          <DashboardStats data={monthlyStats} />
        </section>

        {/* Speed-Entry Form */}
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

        {/* Recent History */}
        <section>
          <RecentHistoryList expenses={recentExpenses} />
        </section>
      </div>
    </div>
  )
}
