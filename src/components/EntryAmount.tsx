import type { Currency, Expense } from '@/lib/domain'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { currencyLabel, formatDay } from '@/i18n/format'
import { formatMoney, formatRate, isConverted } from '@/lib/money'
import { cn } from '@/lib/utils'

export interface EntryAmountProps {
  entry: Pick<Expense, 'amount' | 'currency' | 'conversion'>
  mainCurrency: Currency
  sign?: '+' | '-'
  className?: string
}

const SOURCE_KEYS: Record<string, MessageKey> = {
  nbu: 'common.rateSource.nbu',
  manual: 'common.rateSource.manual',
  identity: 'common.rateSource.identity',
}

// "NBU" / "НБУ", "Manual rate", ...; an unknown provider id is shown as is.
export function rateSourceLabel(
  source: string,
  t: (key: MessageKey) => string,
): string {
  const key = Object.prototype.hasOwnProperty.call(SOURCE_KEYS, source)
    ? SOURCE_KEYS[source]
    : undefined
  return key ? t(key) : source
}

// The typed amount of an entry, plus its main-currency amount when converted
// ("20.00 USD ≈ 830.40 UAH", rate details in the title) or "rate pending".
function EntryAmount({ entry, mainCurrency, sign, className }: EntryAmountProps) {
  const { t } = useT()
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
    title = t('common.rateTitle', {
      from: currencyLabel(entry.currency),
      rate: formatRate(conversion.rate),
      to: currencyLabel(mainCurrency),
      source: rateSourceLabel(conversion.source, t),
      date: formatDay(conversion.rateDate),
    })
  } else {
    state = 'pending'
    text = t('common.ratePendingAmount', { amount: typed })
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
