import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import type { MemberProfile } from '@/lib/spaces/types'
import type { FamilySyncState } from '@/lib/sync/types'
import { useT } from '@/i18n'
import { formatFullDate } from '@/i18n/format'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

// The server's member row (taken from the Family state so the UI never names
// the Family client module).
export type FamilyMember = NonNullable<FamilySyncState['space']>['members'][number]

interface FamilyMembersListProps {
  members: Array<FamilyMember>
  profiles: Array<MemberProfile>
  myUserId: string
  isOwner: boolean
  onRemove: (userId: string) => void | Promise<void>
  onTransfer: (userId: string) => void | Promise<void>
}

// Display name: the member's profile name, else the email, else a short id.
export function memberDisplayName(member: FamilyMember, profiles: Array<MemberProfile>): string {
  const profile = profiles.find((p) => p.id === member.user_id && !p.deletedAt)
  const name = profile?.displayName.trim()
  if (name) return name
  if (member.email) return member.email
  return member.user_id.slice(0, 8)
}

type Pending = { kind: 'remove' | 'transfer'; userId: string; name: string } | null

export function FamilyMembersList({
  members,
  profiles,
  myUserId,
  isOwner,
  onRemove,
  onTransfer,
}: FamilyMembersListProps) {
  const { t } = useT()
  const [confirm, setConfirm] = useState<Pending>(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    if (!confirm || busy) return
    setBusy(true)
    try {
      if (confirm.kind === 'remove') await onRemove(confirm.userId)
      else await onTransfer(confirm.userId)
    } catch {
      // The parent shows action errors.
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }

  const close = (open: boolean) => {
    if (!open && !busy) setConfirm(null)
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-foreground">{t('family.members.title')}</h3>
      <ul data-testid="family-members" className="flex flex-col divide-y rounded-md border">
        {members.map((member) => {
          const isMe = member.user_id === myUserId
          const name = memberDisplayName(member, profiles)
          return (
            <li
              key={member.user_id}
              data-testid="family-member-row"
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span data-testid="family-member-name" className="truncate font-medium">
                    {name}
                  </span>
                  {isMe && (
                    <span
                      data-testid="family-member-you"
                      className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                    >
                      {t('family.members.you')}
                    </span>
                  )}
                </div>
                <span data-testid="family-member-email" className="truncate text-sm text-muted-foreground">
                  {member.email ?? ''}
                </span>
                <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                  <span data-testid="family-member-role">
                    {member.role === 'owner' ? t('family.members.owner') : t('family.members.member')}
                  </span>
                  {member.joined_at && (
                    <span data-testid="family-member-joined">
                      {t('family.members.joined', { date: formatFullDate(member.joined_at) })}
                    </span>
                  )}
                </span>
              </div>
              {isOwner && !isMe && (
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="family-member-transfer-btn"
                    onClick={() => setConfirm({ kind: 'transfer', userId: member.user_id, name })}
                  >
                    {t('family.members.transfer')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    data-testid="family-member-remove-btn"
                    onClick={() => setConfirm({ kind: 'remove', userId: member.user_id, name })}
                  >
                    {t('family.members.remove')}
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <AlertDialog open={confirm?.kind === 'remove'} onOpenChange={close}>
        <AlertDialogContent data-testid="family-remove-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('family.remove.title', { name: confirm?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('family.remove.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('family.cancel')}</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              data-testid="family-remove-confirm"
              disabled={busy}
              onClick={() => void run()}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('family.remove.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm?.kind === 'transfer'} onOpenChange={close}>
        <AlertDialogContent data-testid="family-transfer-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('family.transfer.title', { name: confirm?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('family.transfer.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('family.cancel')}</AlertDialogCancel>
            <Button
              type="button"
              data-testid="family-transfer-confirm"
              disabled={busy}
              onClick={() => void run()}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('family.transfer.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
