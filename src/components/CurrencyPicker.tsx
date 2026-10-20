import type { Currency } from '@/lib/domain'
import { CURRENCIES } from '@/lib/domain'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface CurrencyPickerProps {
  value: Currency
  /** Called on every tap, also for the already selected code. */
  onChange: (currency: Currency) => void
  testIdPrefix: string
  disabled?: boolean
  label?: string
  className?: string
}

// Segmented currency buttons (no Radix Select), shared by the expense drawer
// and the dashboard Quick Add.
export function CurrencyPicker({
  value,
  onChange,
  testIdPrefix,
  disabled,
  label,
  className,
}: CurrencyPickerProps) {
  return (
    <div
      role="group"
      aria-label={label ?? 'Currency'}
      data-testid={`${testIdPrefix}-currency`}
      className={cn('flex flex-wrap gap-2', className)}
    >
      {CURRENCIES.map((code) => {
        const pressed = value === code
        return (
          <Button
            key={code}
            type="button"
            data-testid={`${testIdPrefix}-currency-${code}`}
            aria-pressed={pressed}
            variant={pressed ? 'default' : 'outline'}
            disabled={disabled}
            onClick={() => onChange(code)}
            className="min-h-11 min-w-14 flex-1 font-semibold sm:min-h-9"
          >
            {code}
          </Button>
        )
      })}
    </div>
  )
}
