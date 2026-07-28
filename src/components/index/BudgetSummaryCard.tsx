import type { Currency } from '@/lib/domain'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

interface BudgetSummaryCardProps {
  income: number
  expenses: number
  currency?: Currency
}

export default function BudgetSummaryCard({
  income,
  expenses,
  currency = 'UAH',
}: BudgetSummaryCardProps) {
  const netBalance = income - expenses

  return (
    <div className="w-full flex justify-around gap-3">
      <Card className="w-1/3 gap-1">
        <CardHeader>
          <CardTitle className="text-sm text-muted-foreground">
            Income
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CardDescription className="text-2xl font-semibold text-black dark:text-white">
            {income.toLocaleString()} {currency}
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
          <CardDescription className="text-2xl font-semibold text-black dark:text-white">
            {expenses.toLocaleString()} {currency}
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
          <CardDescription className="text-2xl font-semibold text-black dark:text-white">
            {netBalance.toLocaleString()} {currency}
          </CardDescription>
        </CardContent>
      </Card>
    </div>
  )
}
