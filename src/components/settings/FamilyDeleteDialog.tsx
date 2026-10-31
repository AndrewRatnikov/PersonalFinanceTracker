import { useEffect, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'

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
import { Label } from '@/components/ui/label'

interface FamilyDeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  spaceName: string
  onConfirm: (typedName: string) => Promise<void>
  onDownloadBackup: () => Promise<void>
}

// "Delete Family" (owner): offers a backup first, then asks for the Family
// name (compared after trimming both sides) before Delete is enabled.
export function FamilyDeleteDialog({
  open,
  onOpenChange,
  spaceName,
  onConfirm,
  onDownloadBackup,
}: FamilyDeleteDialogProps) {
  const { t } = useT()
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)
  const [backingUp, setBackingUp] = useState(false)

  useEffect(() => {
    if (!open) {
      setTyped('')
      setPending(false)
      setBackingUp(false)
    }
  }, [open])

  const matches = typed.trim() !== '' && typed.trim() === spaceName.trim()

  const handleConfirm = async () => {
    if (!matches || pending) return
    setPending(true)
    try {
      await onConfirm(typed)
    } catch {
      // The parent shows the error; the dialog stays open for another try.
    } finally {
      setPending(false)
    }
  }

  const handleBackup = async () => {
    if (backingUp) return
    setBackingUp(true)
    try {
      await onDownloadBackup()
    } catch {
      // The backup flow reports its own problems.
    } finally {
      setBackingUp(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="family-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('family.delete.title', { name: spaceName })}</AlertDialogTitle>
          <AlertDialogDescription>{t('family.delete.body')}</AlertDialogDescription>
        </AlertDialogHeader>

        <Button
          type="button"
          variant="outline"
          data-testid="family-delete-backup-btn"
          disabled={backingUp}
          onClick={() => void handleBackup()}
        >
          {backingUp ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          {t('family.delete.backup')}
        </Button>

        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            void handleConfirm()
          }}
        >
          <Label htmlFor="family-delete-name">{t('family.delete.typeName')}</Label>
          <Input
            id="family-delete-name"
            data-testid="family-delete-name-input"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={pending}
          />
        </form>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('family.cancel')}</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            data-testid="family-delete-confirm"
            disabled={!matches || pending}
            onClick={() => void handleConfirm()}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('family.delete.confirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
