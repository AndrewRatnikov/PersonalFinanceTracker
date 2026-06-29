import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
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
import { createBrowserSupabaseClient } from '@/lib/supabase'
import { clearLocalDb, wipeLocalDbKey } from '@/lib/localDb'

const OFFLINE_USER_KEY = 'minima_offline_user'

interface DeleteAccountDialogProps {
  userId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DeleteAccountDialog({
  userId,
  open,
  onOpenChange,
}: DeleteAccountDialogProps) {
  const navigate = useNavigate()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleDelete = async () => {
    setDeleting(true)
    setError(null)

    try {
      await deleteCurrentUserAccount()

      wipeLocalDbKey()
      await clearLocalDb()

      localStorage.removeItem(`minima_migrated_${userId}`)
      localStorage.removeItem(OFFLINE_USER_KEY)

      const supabase = createBrowserSupabaseClient()
      await supabase.auth.signOut()

      navigate({ to: '/login' })
    } catch (e: any) {
      const message = e?.message ?? 'Account deletion failed'
      setError(message)
      toast.error(message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="delete-account-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete account?</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure? All your data will be deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error && (
          <p data-testid="delete-account-error" className="text-sm text-destructive">
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
            onClick={handleDelete}
          >
            {deleting ? 'Deleting…' : 'Yes'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
