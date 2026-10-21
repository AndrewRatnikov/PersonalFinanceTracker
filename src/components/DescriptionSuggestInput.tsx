import { useMemo, useState } from 'react'
import type * as React from 'react'

import type { DescriptionSuggestion, SuggestionEntry } from '@/lib/suggestions'
import { useT } from '@/i18n'
import { formatShortMoney } from '@/lib/money'
import { suggestDescriptions } from '@/lib/suggestions'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'

interface DescriptionSuggestInputProps {
  id: string
  testIdPrefix: string
  value: string
  onChange: (value: string) => void
  /** Entries the suggestions are computed from (already decrypted, in memory). */
  entries: ReadonlyArray<SuggestionEntry>
  /** That category's descriptions rank first. */
  categoryId?: string
  /** After onChange(description); withAmount is true for the hint chip. */
  onPick: (
    suggestion: DescriptionSuggestion,
    options: { withAmount: boolean },
  ) => void
  /** Enter without an active option. Without it, Enter submits the form. */
  onEnter?: () => void
  placeholder?: string
  maxLength?: number
  disabled?: boolean
  'aria-invalid'?: boolean
  'aria-label'?: string
  className?: string
  inputRef?: React.Ref<HTMLInputElement>
}

const SUGGESTION_LIMIT = 5

// An accessible combobox (input + listbox) for descriptions. No <datalist>:
// Safari's is unreliable.
export function DescriptionSuggestInput({
  id,
  testIdPrefix,
  value,
  onChange,
  entries,
  categoryId,
  onPick,
  onEnter,
  placeholder,
  maxLength,
  disabled,
  'aria-invalid': ariaInvalid,
  'aria-label': ariaLabel,
  className,
  inputRef,
}: DescriptionSuggestInputProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const { t } = useT()

  const suggestions = useMemo(
    () =>
      suggestDescriptions(entries, {
        query: value,
        categoryId,
        limit: SUGGESTION_LIMIT,
      }),
    [entries, value, categoryId],
  )

  const expanded = open && !disabled && suggestions.length > 0
  const activeIndex =
    expanded && active >= 0 && active < suggestions.length ? active : -1
  const listboxId = `${id}-listbox`
  const optionId = (i: number) => `${id}-option-${i}`

  const close = () => {
    setOpen(false)
    setActive(-1)
  }

  const pick = (s: DescriptionSuggestion, withAmount: boolean) => {
    onChange(s.description)
    onPick(s, { withAmount })
    close()
  }

  const move = (step: 1 | -1) => {
    const n = suggestions.length
    if (n === 0) return
    if (!expanded) {
      setOpen(true)
      setActive(step === 1 ? 0 : n - 1)
      return
    }
    if (activeIndex < 0) {
      setActive(step === 1 ? 0 : n - 1)
    } else {
      setActive((activeIndex + step + n) % n)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault()
        move(e.key === 'ArrowDown' ? 1 : -1)
        return
      case 'Enter': {
        if (activeIndex >= 0) {
          e.preventDefault()
          pick(suggestions[activeIndex], false)
          return
        }
        if (onEnter) {
          e.preventDefault()
          onEnter()
        }
        return
      }
      case 'Escape':
        if (expanded) {
          e.preventDefault()
          close()
        }
        return
      default:
        return
    }
  }

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listboxId}
        aria-activedescendant={
          activeIndex >= 0 ? optionId(activeIndex) : undefined
        }
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        data-testid={`${testIdPrefix}-description`}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        className={className}
      />
      {expanded && (
        <ul
          role="listbox"
          id={listboxId}
          data-testid={`${testIdPrefix}-suggestions`}
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {suggestions.map((s, i) => {
            const money = formatShortMoney(s.amount, s.currency)
            return (
              <li
                key={`${s.description}-${i}`}
                role="option"
                id={optionId(i)}
                aria-selected={i === activeIndex}
                data-testid={`${testIdPrefix}-suggestion`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s, false)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm sm:min-h-9',
                  i === activeIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/60',
                )}
              >
                <span className="truncate">{s.description}</span>
                <button
                  type="button"
                  tabIndex={-1}
                  data-testid={`${testIdPrefix}-suggestion-amount`}
                  aria-label={t('common.suggestion.useAmount', { money })}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation()
                    pick(s, true)
                  }}
                  className="shrink-0 rounded-full border border-border bg-muted px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-secondary-foreground"
                >
                  {t('common.suggestion.last', { money })}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
