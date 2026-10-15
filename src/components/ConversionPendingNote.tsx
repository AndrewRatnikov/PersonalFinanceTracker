import { Link } from '@tanstack/react-router'

import { pendingLabel } from '@/lib/money'

export interface ConversionPendingNoteProps {
  /** Entries left out of the totals until their exchange rate is known. */
  count: number
  /** Budgets in another currency, left out until today's rate is known. */
  budgetsExcluded?: number
  fetchExchangeRates: boolean
}

function budgetsLabel(n: number): string {
  return n === 1
    ? "1 budget in another currency isn't compared until today's exchange rate is available"
    : `${n} budgets in another currency aren't compared until today's exchange rate is available`
}

// Explains what the totals above leave out. Renders nothing when nothing is
// left out.
function ConversionPendingNote({
  count,
  budgetsExcluded = 0,
  fetchExchangeRates,
}: ConversionPendingNoteProps) {
  if (count <= 0 && budgetsExcluded <= 0) return null
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      {count > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <p data-testid="conversion-pending-note">{pendingLabel(count)}</p>
          {!fetchExchangeRates && (
            <Link
              to="/settings"
              search={{ tab: 'general' }}
              data-testid="conversion-pending-settings-link"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Turn on exchange rates in Settings → General
            </Link>
          )}
        </div>
      )}
      {budgetsExcluded > 0 && (
        <p data-testid="budget-conversion-pending-note">
          {budgetsLabel(budgetsExcluded)}
        </p>
      )}
    </div>
  )
}

export default ConversionPendingNote
