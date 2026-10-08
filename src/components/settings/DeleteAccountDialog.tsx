import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { deleteCurrentUserAccount } from '@/lib/account'
import { ACCOUNT_SESSION_QUERY_KEY, signOutAccount } from '@/lib/accountSession'
import { reloadToHome, wipeLocalData } from '@/lib/localWipe'

interface DeleteAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Deletes the Supabase account (spec §2.6). Data on this device is kept
// unless the user ticks "Also remove data from this device".
export function DeleteAccountDialog({
  open,
  onOpenChange,
}: DeleteAccountDialogProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removeLocal, setRemoveLocal] = useState(false)

  useEffect(() => {
    if (!open) {
      setError(null)
      setRemoveLocal(false)
    }
  }, [open])

  const handleDelete = async () => {
    setDeleting(true)
    setError(null)

    try {
      await deleteCurrentUserAccount()
    } catch (e: unknown) {
      const message =
        e instanceof Error && e.message ? e.message : 'Account deletion failed'
      setError(message)
      toast.error(message)
      setDeleting(false)
      return
    }

    try {
      await signOutAccount()
    } catch (e) {
      console.error('Sign-out after account deletion failed:', e)
    }

    toast.success('Account deleted')

    if (removeLocal) {
      try {
        await wipeLocalData()
      } catch (e) {
        console.error('Removing local data after account deletion failed:', e)
      }
      reloadToHome()
      return
    }

    setDeleting(false)
    void queryClient.invalidateQueries({ queryKey: ACCOUNT_SESSION_QUERY_KEY })
    void navigate({ to: '/' })
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="delete-account-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete account?</AlertDialogTitle>
          <AlertDialogDescription>
            Deletes your MinimaSpend account on the server. Data on this device
            is kept unless you tick the box below.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <label
          htmlFor="delete-account-remove-local"
          className="flex items-center gap-2 text-sm"
        >
          <input
            id="delete-account-remove-local"
            data-testid="delete-account-remove-local"
            type="checkbox"
            className="h-4 w-4"
            checked={removeLocal}
            onChange={(e) => setRemoveLocal(e.target.checked)}
            disabled={deleting}
          />
          Also remove data from this device
        </label>

        {error && (
          <p
            data-testid="delete-account-error"
            className="text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel data-testid="delete-account-cancel-btn">
            No
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="delete-account-confirm-btn"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={deleting}
            onClick={() => void handleDelete()}
          >
            {deleting ? 'Deleting…' : 'Yes'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
