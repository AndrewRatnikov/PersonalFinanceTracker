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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import { clearLocalDb, wipeLocalDbKey } from '@/lib/localDb'
import { exportAllLocalData } from '@/lib/localExport'

const OFFLINE_USER_KEY = 'minima_offline_user'

interface Props {
  userId: string
  children: React.ReactNode
}

export function SignOutDialog({ userId, children }: Props) {
  const navigate = useNavigate()
  const [exporting, setExporting] = useState(false)

  const handleExport = async () => {
    setExporting(true)
    try {
      await exportAllLocalData()
    } catch {
      toast.error('Export failed')
    } finally {
      setExporting(false)
    }
  }

  const handleSignOut = async () => {
    wipeLocalDbKey()
    await clearLocalDb()

    localStorage.removeItem(`minima_migrated_${userId}`)
    localStorage.removeItem(OFFLINE_USER_KEY)

    const supabase = createBrowserSupabaseClient()
    await supabase.auth.signOut()

    navigate({ to: '/login' })
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out?</AlertDialogTitle>
          <AlertDialogDescription>
            All locally stored data — expenses, categories, income, and budgets — will be
            permanently deleted from this device. Export your data first if you want to keep a copy.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            variant="outline"
            className="sm:mr-auto"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? 'Exporting…' : 'Export my data'}
          </Button>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={handleSignOut}
          >
            Sign out &amp; delete data
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
