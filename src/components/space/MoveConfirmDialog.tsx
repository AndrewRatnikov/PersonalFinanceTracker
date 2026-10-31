// Confirms a move between Personal and the Family (spec §23, D2). The confirm
// button is a plain button, so the dialog stays open while the move runs; the
// page closes it when the move settles.

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
import { useT } from '@/i18n'

export interface MoveConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  count: number
  direction: 'to-family' | 'to-personal'
  familyName: string
  pending?: boolean
  onConfirm: () => void
}

export function MoveConfirmDialog({
  open,
  onOpenChange,
  count,
  direction,
  familyName,
  pending = false,
  onConfirm,
}: MoveConfirmDialogProps) {
  const { t, plural } = useT()
  const toFamily = direction === 'to-family'
  const params = { name: familyName }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="move-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle data-testid="move-confirm-title">
            {plural(toFamily ? 'move.titleToFamily' : 'move.titleToPersonal', count, params)}
          </AlertDialogTitle>
          <AlertDialogDescription data-testid="move-confirm-text">
            {t(toFamily ? 'move.bodyToFamily' : 'move.bodyToPersonal', params)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="move-cancel-btn" disabled={pending}>
            {t('common.cancel')}
          </AlertDialogCancel>
          <Button
            type="button"
            data-testid="move-confirm-btn"
            disabled={pending}
            onClick={onConfirm}
          >
            {t('move.confirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
