import { useEffect, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { downloadBackup } from '@/lib/backup'
import { reloadToHome, wipeLocalData } from '@/lib/localWipe'
import { VaultError, verifyPassword } from '@/lib/vault'
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

interface RemoveDataDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // 'password' while unlocked; 'typed-delete' when both the password and the
  // recovery key are lost (nothing can be decrypted, so no backup either).
  confirmWith?: 'password' | 'typed-delete'
}

const DELETE_CONFIRMATION = 'DELETE'

// Remove data from this device (spec §2.5).
export function RemoveDataDialog({
  open,
  onOpenChange,
  confirmWith = 'password',
}: RemoveDataDialogProps) {
  const [password, setPassword] = useState('')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const { t } = useT()

  useEffect(() => {
    if (!open) {
      setPassword('')
      setTyped('')
      setError(null)
    }
  }, [open])

  const withPassword = confirmWith === 'password'
  const inputValid = withPassword
    ? password.length > 0
    : typed === DELETE_CONFIRMATION
  const canConfirm = inputValid && !pending

  const handleBackup = async () => {
    setBackingUp(true)
    try {
      const result = await downloadBackup()
      if (result.status === 'saved') toast.success(t('toasts.backupSaved'))
    } catch (err) {
      toast.error(t('toasts.backupDownloadFailed', { error: errorMessage(err) }))
    } finally {
      setBackingUp(false)
    }
  }

  const handleConfirm = async () => {
    if (!canConfirm) return
    setError(null)
    setPending(true)
    try {
      if (withPassword) {
        try {
          await verifyPassword(password)
        } catch (err) {
          setError(
            err instanceof VaultError
              ? errorMessage(err)
              : t('backup.remove.checkPasswordFailed', { error: errorMessage(err) }),
          )
          return
        }
      }
      try {
        await wipeLocalData()
      } catch (err) {
        setError(t('backup.remove.failed', { error: errorMessage(err) }))
        return
      }
      reloadToHome()
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="remove-data-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('backup.remove.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('backup.remove.description')}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-4">
          {withPassword && (
            <Button
              type="button"
              variant="outline"
              data-testid="remove-data-backup-btn"
              onClick={() => void handleBackup()}
              disabled={backingUp || pending}
              className="flex items-center gap-2"
            >
              {backingUp ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {t('backup.remove.backupFirst')}
            </Button>
          )}

          {withPassword ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="remove-data-password">{t('vault.password')}</Label>
              <Input
                id="remove-data-password"
                data-testid="remove-data-password-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={pending}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="remove-data-delete">
                {t('common.typeToConfirm', { word: DELETE_CONFIRMATION })}
              </Label>
              <Input
                id="remove-data-delete"
                data-testid="remove-data-delete-input"
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                disabled={pending}
              />
            </div>
          )}

          {error && (
            <p
              data-testid="remove-data-error"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel data-testid="remove-data-cancel-btn">
            {t('common.cancel')}
          </AlertDialogCancel>
          {/* A plain Button, so the dialog stays open while it verifies. */}
          <Button
            type="button"
            variant="destructive"
            data-testid="remove-data-confirm-btn"
            disabled={!canConfirm}
            onClick={() => void handleConfirm()}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('backup.remove.confirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
