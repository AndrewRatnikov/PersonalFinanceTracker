import type { Currency } from '@/lib/domain'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface BudgetSummaryCardProps {
  totalIncome: number
  totalExpenses: number
  currency?: Currency
}

export default function BudgetSummaryCard({
  totalIncome,
  totalExpenses,
  currency = 'UAH',
}: BudgetSummaryCardProps) {
  const netBalance = totalIncome - totalExpenses
  const isPositive = netBalance >= 0

  return (
    <Card data-testid="budget-summary-card" className="w-full">
      <CardHeader>
        <CardTitle>Budget Summary</CardTitle>
        <CardDescription>Income, expenses, and net balance</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div data-testid="budget-summary-income">
          Total Income: {totalIncome.toLocaleString()} {currency}
        </div>
        <div data-testid="budget-summary-expenses">
          Total Expenses: {totalExpenses.toLocaleString()} {currency}
        </div>
        <div
          data-testid="budget-summary-net-balance"
          className={cn(
            'font-semibold',
            isPositive ? 'text-emerald-600' : 'text-destructive',
          )}
        >
          Net Balance: {netBalance.toLocaleString()} {currency}
        </div>
      </CardContent>
    </Card>
  )
}
