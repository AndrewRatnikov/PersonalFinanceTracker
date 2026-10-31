// A member's initials on their colour (spec §23). The colour is the profile's
// theme token; an id without a profile uses var(--muted).

import type { MemberDirectory } from '@/lib/memberStats'
import { useT } from '@/i18n'
import { memberInitials, memberLabel } from '@/lib/memberStats'

export function MemberChip({
  memberId,
  directory,
}: {
  memberId: string | undefined
  directory: MemberDirectory
}) {
  useT()
  const info = memberId === undefined ? undefined : directory.byId.get(memberId)
  const label = memberLabel(directory, memberId)
  return (
    <span
      data-testid="member-chip"
      data-member-id={memberId}
      title={label}
      aria-label={label}
      role="img"
      className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-background"
      style={{ background: info ? info.color : 'var(--muted)' }}
    >
      {info ? memberInitials(info.displayName) : '?'}
    </span>
  )
}
