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
import { useT } from '@/i18n'
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
  const { t } = useT()

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOutAccount()
      await queryClient.invalidateQueries({
        queryKey: ACCOUNT_SESSION_QUERY_KEY,
      })
      toast.success(t('toasts.signedOut'))
    } catch (err) {
      console.error('Sign out failed:', err)
      toast.error(
        err instanceof Error && err.message
          ? t('toasts.signOutFailedWith', { error: err.message })
          : t('toasts.signOutFailed'),
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
            <CardTitle>{t('settings.account.title')}</CardTitle>
          </div>
          <CardDescription>{t('settings.account.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {session ? (
            <>
              <p
                data-testid="account-email"
                className="flex items-center gap-2 text-sm"
              >
                <Mail className="h-4 w-4 text-muted-foreground" />
                {session.email ?? t('settings.account.signedIn')}
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
                  {t('settings.account.signOut')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  data-testid="delete-account-btn"
                  onClick={() => setDeleteOpen(true)}
                >
                  {t('settings.account.deleteAccount')}
                </Button>
              </div>
            </>
          ) : (
            <Link
              to="/login"
              data-testid="account-sign-in-link"
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('nav.signIn')}
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
