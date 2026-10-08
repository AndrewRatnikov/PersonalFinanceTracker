import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, LogOut, Mail, UserRound } from 'lucide-react'
import { toast } from 'sonner'

import {
  ACCOUNT_SESSION_QUERY_KEY,
  signOutAccount,
  useAccountSession,
} from '@/lib/accountSession'
import { DeleteAccountDialog } from '@/components/settings/DeleteAccountDialog'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

// Settings → Account (spec §2.6). Signing out ends the Supabase session only;
// data on this device is never touched.
export function AccountTab() {
  const session = useAccountSession()
  const queryClient = useQueryClient()
  const [signingOut, setSigningOut] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOutAccount()
      await queryClient.invalidateQueries({
        queryKey: ACCOUNT_SESSION_QUERY_KEY,
      })
      toast.success('Signed out')
    } catch (err) {
      console.error('Sign out failed:', err)
      toast.error(
        err instanceof Error && err.message
          ? `Could not sign out: ${err.message}`
          : 'Could not sign out.',
      )
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div data-testid="account-tab" className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <UserRound className="h-4 w-4 text-muted-foreground" />
            <CardTitle>Account</CardTitle>
          </div>
          <CardDescription>
            An account is optional. Your data stays on this device either way.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {session ? (
            <>
              <p
                data-testid="account-email"
                className="flex items-center gap-2 text-sm"
              >
                <Mail className="h-4 w-4 text-muted-foreground" />
                {session.email ?? 'Signed in'}
              </p>
              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  variant="outline"
                  data-testid="account-sign-out-btn"
                  disabled={signingOut}
                  onClick={() => void handleSignOut()}
                  className="flex items-center gap-2"
                >
                  {signingOut ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <LogOut className="h-4 w-4" />
                  )}
                  Sign out
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  data-testid="delete-account-btn"
                  onClick={() => setDeleteOpen(true)}
                >
                  Delete account
                </Button>
              </div>
            </>
          ) : (
            <Link
              to="/login"
              data-testid="account-sign-in-link"
              className={buttonVariants({ variant: 'outline' })}
            >
              Sign in
            </Link>
          )}
        </CardContent>
      </Card>

      {session && (
        <DeleteAccountDialog open={deleteOpen} onOpenChange={setDeleteOpen} />
      )}
    </div>
  )
}
