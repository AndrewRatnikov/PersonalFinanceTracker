import { Link } from '@tanstack/react-router'

import type { BudgetStatus, DashboardSummary } from '@/lib/dashboardSummary'
import { useT } from '@/i18n'
import BudgetSummaryCard from '@/components/index/BudgetSummaryCard'
import ConversionPendingNote from '@/components/ConversionPendingNote'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatAmount, formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'

interface DashboardSummarySectionProps {
  summary: DashboardSummary
  /** Whether NBU rates are fetched; off adds a link to Settings → General. */
  fetchExchangeRates?: boolean
}

const BAR_COLOR: Record<BudgetStatus, string> = {
  ok: 'bg-primary',
  warning: 'bg-amber-500',
  over: 'bg-destructive',
}

// Every amount is in the main currency; entries still waiting for a rate are
// left out of the totals and counted by the note under the hero.
export default function DashboardSummarySection({
  summary,
  fetchExchangeRates = true,
}: DashboardSummarySectionProps) {
  const cur = summary.mainCurrency
  const { leftToSpend, dailyAllowance, pace, budgetWatch } = summary
  const { t } = useT()

  return (
    <div className="flex flex-col gap-8" data-testid="dashboard-summary">
      <section className="flex flex-col gap-3">
        <Card data-testid="dashboard-hero">
          {leftToSpend !== null ? (
            <>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">
                  {t('dashboard.leftToSpend')}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1">
                <p
                  className={cn(
                    'text-4xl font-bold tabular-nums break-words',
                    leftToSpend < 0 && 'text-destructive',
                  )}
                  data-testid="dashboard-left-to-spend"
                >
                  {formatMoney(leftToSpend, cur)}
                </p>
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="dashboard-daily-allowance"
                >
                  {t('dashboard.perDay', { amount: formatMoney(dailyAllowance ?? 0, cur) })}
                </p>
              </CardContent>
            </>
          ) : (
            <CardContent
              className="flex flex-col gap-4"
              data-testid="dashboard-no-budget-fallback"
            >
              <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col min-w-0">
                  <span className="text-xs text-muted-foreground">
                    {t('dashboard.summary.income')}
                  </span>
                  <span
                    className="font-semibold tabular-nums break-words"
                    data-testid="dashboard-month-income"
                  >
                    {formatMoney(summary.monthIncome, cur)}
                  </span>
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs text-muted-foreground">
                    {t('dashboard.summary.expenses')}
                  </span>
                  <span
                    className="font-semibold tabular-nums break-words"
                    data-testid="dashboard-month-expenses"
                  >
                    {formatMoney(summary.monthExpenses, cur)}
                  </span>
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs text-muted-foreground">
                    {t('dashboard.summary.net')}
                  </span>
                  <span
                    className={cn(
                      'font-semibold tabular-nums break-words',
                      summary.net < 0 && 'text-destructive',
                    )}
                    data-testid="dashboard-month-net"
                  >
                    {formatMoney(summary.net, cur)}
                  </span>
                </div>
              </div>
              <Link
                to="/settings"
                search={{ tab: 'budget' }}
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                data-testid="dashboard-budget-setup-link"
              >
                {t('dashboard.setUpBudget')}
              </Link>
            </CardContent>
          )}
        </Card>

        {pace.changePct !== null && (
          <p
            className="text-sm text-muted-foreground"
            data-testid="dashboard-pace"
          >
            {t(pace.changePct < 0 ? 'dashboard.paceLess' : 'dashboard.paceMore', {
              amount: formatMoney(pace.spentSoFar, cur),
              percent: Math.abs(Math.round(pace.changePct)),
            })}
          </p>
        )}
      </section>

      <ConversionPendingNote
        count={summary.pendingCount}
        budgetsExcluded={summary.budgetsExcluded}
        fetchExchangeRates={fetchExchangeRates}
      />

      {leftToSpend !== null && (
        <section className="flex flex-col gap-2">
          <BudgetSummaryCard
            income={summary.monthIncome}
            expenses={summary.monthExpenses}
            currency={cur}
          />
        </section>
      )}

      {budgetWatch.length > 0 && (
        <section data-testid="budget-watch">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg font-semibold tracking-tight">
                {t('dashboard.budgetWatch')}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {budgetWatch.map((item) => (
                <div
                  key={item.categoryId}
                  className="flex flex-col gap-1.5"
                  data-testid="budget-watch-item"
                  data-status={item.status}
                  data-category-id={item.categoryId}
                >
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium truncate">{item.name}</span>
                    <span className="text-muted-foreground tabular-nums shrink-0">
                      {`${formatAmount(item.spent)} / ${formatMoney(item.limit, cur)}`}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        BAR_COLOR[item.status],
                      )}
                      style={{ width: `${Math.min(item.ratio, 1) * 100}%` }}
                      data-testid="budget-watch-bar"
                    />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  )
}
