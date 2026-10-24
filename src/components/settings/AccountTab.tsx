import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, LogOut, Mail, UserRound } from 'lucide-react'
import { toast } from 'sonner'

import type { MessageKey } from '@/i18n'
import type { SyncStatusView } from '@/lib/cloud/entitlements'
import {
  ACCOUNT_SESSION_QUERY_KEY,
  signOutAccount,
  useAccountSession,
} from '@/lib/accountSession'
import { useT } from '@/i18n'
import { hasFeature, useSyncStatus } from '@/lib/cloud/entitlements'
import { DeleteAccountDialog } from '@/components/settings/DeleteAccountDialog'
import { LegalLinks } from '@/components/LegalLinks'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

// Display names only, by plan id. Permissions never depend on the plan id:
// they come from hasFeature (the server's plans.features).
const PLAN_NAME_KEYS: Record<string, MessageKey | undefined> = {
  free: 'cloud.plan.names.free',
  beta: 'cloud.plan.names.beta',
  sync: 'cloud.plan.names.sync',
}

function PlanCard({ view }: { view: SyncStatusView }) {
  const { t } = useT()

  let body
  if (view.state === 'ready') {
    const { status } = view
    const nameKey = PLAN_NAME_KEYS[status.plan_id]
    const sync = hasFeature(status, 'sync')
    body = (
      <>
        <p data-testid="account-plan-name" className="text-lg font-semibold">
          {nameKey ? t(nameKey) : status.plan_id}
        </p>
        {sync && status.granted_by === 'free_for_all' ? (
          <p
            data-testid="account-plan-beta"
            className="text-sm text-muted-foreground"
          >
            {t('cloud.plan.beta')}
          </p>
        ) : sync ? (
          <p
            data-testid="account-plan-included"
            className="text-sm text-muted-foreground"
          >
            {t('cloud.plan.included')}
          </p>
        ) : (
          <p
            data-testid="account-plan-free"
            className="text-sm text-muted-foreground"
          >
            {t('cloud.plan.notIncluded')}
          </p>
        )}
      </>
    )
  } else if (view.state === 'offline') {
    body = (
      <p
        data-testid="account-plan-offline"
        className="text-sm text-muted-foreground"
      >
        {t('cloud.plan.offline')}
      </p>
    )
  } else if (view.state === 'error') {
    body = (
      <div className="flex flex-col items-start gap-3">
        <p
          data-testid="account-plan-error"
          className="text-sm text-destructive"
        >
          {t('cloud.plan.error')}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="account-plan-retry-btn"
          onClick={() => view.retry()}
        >
          {t('common.retry')}
        </Button>
      </div>
    )
  } else {
    body = (
      <p
        data-testid="account-plan-loading"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('cloud.plan.loading')}
      </p>
    )
  }

  return (
    <Card data-testid="account-plan-card">
      <CardHeader>
        <CardTitle>{t('cloud.plan.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">{body}</CardContent>
    </Card>
  )
}

// Settings → Account (spec §2.6, §18). Signing out ends the Supabase session
// only; data on this device is never touched. There are no sync controls yet.
export function AccountTab() {
  const session = useAccountSession()
  const syncStatus = useSyncStatus()
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

  if (!session) {
    return (
      <div data-testid="account-tab" className="flex flex-col gap-6">
        <Card data-testid="account-optional-card">
          <CardHeader>
            <div className="flex items-center gap-2">
              <UserRound className="h-4 w-4 text-muted-foreground" />
              <CardTitle>{t('settings.account.optionalTitle')}</CardTitle>
            </div>
            <CardDescription>
              {t('settings.account.optionalBody')}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-4">
            <Link
              to="/login"
              search={{ redirect: '/settings?tab=account' }}
              data-testid="account-sign-in-link"
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('settings.account.signInGoogle')}
            </Link>
            <div data-testid="account-legal-links">
              <LegalLinks />
            </div>
          </CardContent>
        </Card>
      </div>
    )
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
          <div data-testid="account-legal-links">
            <LegalLinks />
          </div>
        </CardContent>
      </Card>

      <PlanCard view={syncStatus} />

      <DeleteAccountDialog open={deleteOpen} onOpenChange={setDeleteOpen} />
    </div>
  )
}
