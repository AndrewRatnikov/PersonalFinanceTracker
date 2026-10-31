// "Paid by" / "Received by" (spec §23): the active members, plus me as "You"
// without an active profile, plus the current value when that member has left
// (so an edit never changes the payer silently).

import { useId } from 'react'

import type { MemberDirectory } from '@/lib/memberStats'
import { useT } from '@/i18n'
import { memberLabel } from '@/lib/memberStats'

export function PaidBySelect({
  value,
  onChange,
  label,
  directory,
  memberId,
  disabled = false,
}: {
  value: string
  onChange: (memberId: string) => void
  label: string
  directory: MemberDirectory
  memberId: string | null
  disabled?: boolean
}) {
  const { t } = useT()
  const id = useId()

  const options: Array<{ value: string; label: string }> = directory.members
    .filter((m) => m.active)
    .map((m) => ({ value: m.id, label: m.displayName }))
  if (memberId !== null && !options.some((o) => o.value === memberId)) {
    options.push({ value: memberId, label: t('members.you') })
  }
  if (value !== '' && !options.some((o) => o.value === value)) {
    const info = directory.byId.get(value)
    options.push({
      value,
      label: info ? t('members.left', { name: info.displayName }) : memberLabel(directory, value),
    })
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        data-testid="paid-by-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 sm:h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
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
