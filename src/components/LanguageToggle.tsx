import { useT } from '@/i18n'
import { LANGS } from '@/i18n/lang'
import { cn } from '@/lib/utils'

interface LanguageToggleProps {
  // The group's testid; the buttons are `${testId}-uk` and `${testId}-en`.
  testId: string
  className?: string
}

// A compact UK | EN switch (landing header, vault screens). A click switches
// the UI immediately, persists the choice and updates <html lang>.
export function LanguageToggle({ testId, className }: LanguageToggleProps) {
  const { lang, setLang, t } = useT()

  return (
    <div
      role="group"
      aria-label={t('common.language')}
      data-testid={testId}
      className={cn(
        'inline-flex shrink-0 items-center rounded-md border border-border p-0.5 text-xs font-medium',
        className,
      )}
    >
      {LANGS.map((option) => {
        const active = option === lang
        return (
          <button
            key={option}
            type="button"
            data-testid={option === 'uk' ? `${testId}-uk` : `${testId}-en`}
            aria-pressed={active}
            onClick={() => setLang(option)}
            className={cn(
              'rounded px-2 py-1 transition-colors',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option === 'uk' ? t('common.languageShort.uk') : t('common.languageShort.en')}
          </button>
        )
      })}
    </div>
  )
}
