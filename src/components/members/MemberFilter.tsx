// The "Member" filter of the Family lists and analytics (spec §23).

import { useId } from 'react'

import type { MemberFilterOption } from '@/lib/memberStats'
import { useT } from '@/i18n'

export function MemberFilter({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (value: string) => void
  options: ReadonlyArray<MemberFilterOption>
}) {
  const { t } = useT()
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm text-muted-foreground">
        {t('members.member')}
      </label>
      <select
        id={id}
        data-testid="member-filter"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}
