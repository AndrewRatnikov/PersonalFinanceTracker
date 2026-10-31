import { Copy, Share2 } from 'lucide-react'
import { toast } from 'sonner'

import type { CreatedFamilyInvite } from '@/lib/sync/types'
import { useT } from '@/i18n'
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
import { Input } from '@/components/ui/input'

interface FamilyInviteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  invite: CreatedFamilyInvite | null
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

// The invite link (Settings → Family → Invite member). The link carries the
// one-time secret in its fragment; it is shown and copied here only, never
// stored or sent anywhere by the app.
export function FamilyInviteDialog({ open, onOpenChange, invite }: FamilyInviteDialogProps) {
  const { t } = useT()
  const url = invite?.url ?? ''
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const handleCopy = async () => {
    if (url === '') return
    try {
      await navigator.clipboard.writeText(url)
      toast(t('family.inviteDialog.copied'))
    } catch {
      // Clipboard refused (permissions): the link stays selectable in the input.
    }
  }

  const handleShare = async () => {
    if (url === '' || typeof navigator.share !== 'function') return
    try {
      await navigator.share({ url })
    } catch (err) {
      // AbortError: the user closed the share sheet; nothing to show. Any
      // other failure: the link is still in the input, and Copy works.
      if (isAbortError(err)) return
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="family-invite-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('family.inviteDialog.title')}</AlertDialogTitle>
          <AlertDialogDescription data-testid="family-invite-note">
            {t('family.inviteDialog.note')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {invite && (
          <Input
            data-testid="family-invite-link"
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>{t('family.inviteDialog.close')}</AlertDialogCancel>
          {canShare && (
            <Button
              type="button"
              variant="outline"
              data-testid="family-invite-share-btn"
              disabled={url === ''}
              onClick={() => void handleShare()}
            >
              <Share2 className="mr-2 h-4 w-4" />
              {t('family.inviteDialog.share')}
            </Button>
          )}
          <Button
            type="button"
            data-testid="family-invite-copy-btn"
            disabled={url === ''}
            onClick={() => void handleCopy()}
          >
            <Copy className="mr-2 h-4 w-4" />
            {t('family.inviteDialog.copy')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
