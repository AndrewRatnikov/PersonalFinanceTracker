import type { Currency } from '@/lib/domain'
import { DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import { formatMoney } from '@/lib/money'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface BudgetSummaryCardProps {
  income: number
  expenses: number
  currency?: Currency
}

export default function BudgetSummaryCard({
  income,
  expenses,
  currency = DEFAULT_MAIN_CURRENCY,
}: BudgetSummaryCardProps) {
  const netBalance = income - expenses

  return (
    <div
      className="w-full flex justify-around gap-3"
      data-testid="budget-summary-card"
    >
      <Card className="w-1/3 gap-1">
        <CardHeader>
          <CardTitle className="text-sm text-muted-foreground">
            Income
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CardDescription
            className="text-2xl font-semibold text-black dark:text-white"
            data-testid="budget-summary-income"
          >
            {formatMoney(income, currency)}
          </CardDescription>
        </CardContent>
      </Card>
      <Card className="w-1/3 gap-1">
        <CardHeader>
          <CardTitle className="text-sm text-muted-foreground">
            Expenses
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CardDescription
            className="text-2xl font-semibold text-black dark:text-white"
            data-testid="budget-summary-expenses"
          >
            {formatMoney(expenses, currency)}
          </CardDescription>
        </CardContent>
      </Card>
      <Card className="w-1/3 gap-1">
        <CardHeader>
          <CardTitle className="text-sm text-muted-foreground">
            Balance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CardDescription
            className={cn(
              'text-2xl font-semibold',
              netBalance < 0
                ? 'text-destructive'
                : 'text-black dark:text-white',
            )}
            data-testid="budget-summary-net-balance"
          >
            {formatMoney(netBalance, currency)}
          </CardDescription>
        </CardContent>
      </Card>
    </div>
  )
}
