import { useEffect, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

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
      if (result.status === 'saved') toast.success('Backup saved')
    } catch (err) {
      toast.error(`Could not download the backup: ${errorText(err)}`)
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
              ? err.message
              : `Could not check the password: ${errorText(err)}`,
          )
          return
        }
      }
      try {
        await wipeLocalData()
      } catch (err) {
        setError(`Could not remove data: ${errorText(err)}`)
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
          <AlertDialogTitle>Remove data from this device?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes everything MinimaSpend stores on this device: your
            expenses, income, categories and budgets, the password and recovery
            key for this device, and your app settings. This cannot be undone.
          </AlertDialogDescription>
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
              Download backup first
            </Button>
          )}

          {withPassword ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="remove-data-password">Password</Label>
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
              <Label htmlFor="remove-data-delete">Type DELETE to confirm</Label>
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
            Cancel
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
            Remove all data
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
