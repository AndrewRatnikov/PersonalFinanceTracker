import dayjs from 'dayjs'

import type { Currency, Expense } from '@/lib/domain'
import { formatMoney, formatRate, isConverted } from '@/lib/money'
import { cn } from '@/lib/utils'

export interface EntryAmountProps {
  entry: Pick<Expense, 'amount' | 'currency' | 'conversion'>
  mainCurrency: Currency
  sign?: '+' | '-'
  className?: string
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'nbu':
      return 'NBU'
    case 'manual':
      return 'Manual rate'
    case 'identity':
      return 'Same currency'
    default:
      return source
  }
}

// The typed amount of an entry, plus its main-currency amount when converted
// ("20.00 USD ≈ 830.40 UAH", rate details in the title) or "rate pending".
function EntryAmount({ entry, mainCurrency, sign, className }: EntryAmountProps) {
  const typed = formatMoney(Number(entry.amount), entry.currency)
  const prefix = sign ?? ''

  let state: 'main' | 'converted' | 'pending'
  let text: string
  let title: string | undefined
  const conversion = entry.conversion
  if (entry.currency === mainCurrency) {
    state = 'main'
    text = typed
  } else if (conversion && isConverted(entry, mainCurrency)) {
    state = 'converted'
    text = `${typed} ≈ ${formatMoney(conversion.mainAmount, mainCurrency)}`
    title = `1 ${entry.currency} = ${formatRate(conversion.rate)} ${mainCurrency} · ${sourceLabel(conversion.source)} · ${dayjs(conversion.rateDate).format('D MMM')}`
  } else {
    state = 'pending'
    text = `${typed} · rate pending`
  }

  return (
    <span
      data-testid="entry-amount"
      data-state={state}
      title={title}
      className={cn(
        'tabular-nums',
        state === 'pending' && 'text-muted-foreground',
        className,
      )}
    >
      {prefix}
      {text}
    </span>
  )
}

export default EntryAmount
