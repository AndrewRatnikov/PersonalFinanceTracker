import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Cloud, Loader2 } from 'lucide-react'

import type { CloudVault } from '@/lib/cloud/types'
import type { CloudVaultSecret } from '@/lib/vault'
import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { useAccountSession } from '@/lib/accountSession'
import { useSyncState } from '@/lib/sync/react'
import { getSyncRuntime } from '@/lib/sync/runtime'
import { LanguageToggle } from '@/components/LanguageToggle'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface SyncRestoreScreenProps {
  onRestored: () => void
  onCancel: () => void
}

type Lookup =
  | { kind: 'loading' }
  | { kind: 'no-vault' }
  | { kind: 'not-included' }
  | { kind: 'error' }
  | { kind: 'ready'; cloud: CloudVault }

const MIN_PASSWORD_LENGTH = 8

type T = ReturnType<typeof useT>['t']

function failureText(err: unknown, t: T): string {
  if (err instanceof Error && err.name === 'VaultError') return errorMessage(err)
  const code = (err as { code?: unknown } | null)?.code
  return t('sync.errors.actionFailed', { code: typeof code === 'string' ? code : 'unknown' })
}

function RestoreFlow({ onRestored, onCancel }: SyncRestoreScreenProps) {
  const [lookup, setLookup] = useState<Lookup>({ kind: 'loading' })
  const [mode, setMode] = useState<'password' | 'recovery'>('password')
  const [password, setPassword] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const sync = useSyncState()
  const { t } = useT()

  useEffect(() => {
    let cancelled = false
    getSyncRuntime()
      .actions.fetchCloudVault()
      .then(
        (cloud) => {
          if (!cancelled) setLookup(cloud ? { kind: 'ready', cloud } : { kind: 'no-vault' })
        },
        (err: unknown) => {
          if (cancelled) return
          const notIncluded =
            err instanceof Error &&
            err.name === 'SyncActionError' &&
            (err as { code?: unknown }).code === 'sync_not_included'
          setLookup({ kind: notIncluded ? 'not-included' : 'error' })
        },
      )
    return () => {
      cancelled = true
    }
  }, [])

  const restore = async (cloud: CloudVault, secret: CloudVaultSecret) => {
    setRunning(true)
    setError(null)
    try {
      await getSyncRuntime().actions.restoreFromCloud(cloud, secret)
    } catch (err) {
      setError(failureText(err, t))
      setRunning(false)
      return
    }
    setRunning(false)
    onRestored()
  }

  const errorText = error && (
    <p data-testid="sync-restore-error" className="text-sm text-destructive">
      {error}
    </p>
  )

  const progress = running && (
    <p
      data-testid="sync-restore-progress"
      className="flex items-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2 className="h-4 w-4 animate-spin" />
      {sync.progress?.phase === 'pull'
        ? t('sync.progress.download', { done: sync.progress.done })
        : t('sync.restore.progress')}
    </p>
  )

  const cancelButton = (
    <Button
      type="button"
      variant="ghost"
      className="w-full"
      data-testid="sync-restore-cancel"
      onClick={onCancel}
      disabled={running}
    >
      {t('sync.restore.cancel')}
    </Button>
  )

  if (lookup.kind !== 'ready') {
    return (
      <>
        <CardContent className="flex flex-col gap-4 mb-4">
          {lookup.kind === 'loading' && (
            <p
              data-testid="sync-restore-loading"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('sync.restore.loading')}
            </p>
          )}
          {lookup.kind === 'no-vault' && (
            <p data-testid="sync-restore-no-vault" className="text-sm">
              {t('sync.restore.noVault')}
            </p>
          )}
          {lookup.kind === 'not-included' && (
            <p data-testid="sync-restore-not-included" className="text-sm">
              {t('cloud.plan.notIncluded')}
            </p>
          )}
          {lookup.kind === 'error' && (
            <p data-testid="sync-restore-error" className="text-sm text-destructive">
              {t('sync.restore.error')}
            </p>
          )}
        </CardContent>
        <CardFooter>{cancelButton}</CardFooter>
      </>
    )
  }

  const { cloud } = lookup

  if (mode === 'password') {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (password === '' || running) return
          void restore(cloud, { password })
        }}
      >
        <CardContent className="flex flex-col gap-4 mb-4">
          <p className="text-sm text-muted-foreground">{t('sync.restore.body')}</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sync-restore-password">{t('vault.password')}</Label>
            <Input
              id="sync-restore-password"
              data-testid="sync-restore-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
              disabled={running}
            />
          </div>
          {errorText}
          {progress}
        </CardContent>
        <CardFooter className="flex flex-col gap-2">
          <Button
            type="submit"
            className="w-full"
            data-testid="sync-restore-submit"
            disabled={running}
          >
            {t('sync.restore.submit')}
          </Button>
          <Button
            type="button"
            variant="link"
            className="w-full"
            data-testid="sync-restore-use-recovery"
            disabled={running}
            onClick={() => {
              setError(null)
              setMode('recovery')
            }}
          >
            {t('sync.restore.useRecovery')}
          </Button>
          {cancelButton}
        </CardFooter>
      </form>
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (running) return
        setError(null)
        if (newPassword.length < MIN_PASSWORD_LENGTH) {
          setError(t('vault.passwordTooShort'))
          return
        }
        if (newPassword !== confirm) {
          setError(t('vault.passwordsDontMatch'))
          return
        }
        void restore(cloud, { recoveryKey, newPassword })
      }}
    >
      <CardContent className="flex flex-col gap-4 mb-4">
        <p className="text-sm text-muted-foreground">{t('sync.restore.recoveryBody')}</p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sync-restore-recovery-key">{t('vault.recoveryKey')}</Label>
          <Input
            id="sync-restore-recovery-key"
            data-testid="sync-restore-recovery-key"
            type="text"
            value={recoveryKey}
            onChange={(e) => setRecoveryKey(e.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            disabled={running}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sync-restore-new-password">{t('vault.newPassword')}</Label>
          <Input
            id="sync-restore-new-password"
            data-testid="sync-restore-new-password"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            disabled={running}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sync-restore-confirm-password">{t('vault.confirmNewPassword')}</Label>
          <Input
            id="sync-restore-confirm-password"
            data-testid="sync-restore-confirm-password"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            disabled={running}
          />
        </div>
        {errorText}
        {progress}
      </CardContent>
      <CardFooter className="flex flex-col gap-2">
        <Button
          type="submit"
          className="w-full"
          data-testid="sync-restore-recovery-submit"
          disabled={running}
        >
          {t('sync.restore.submit')}
        </Button>
        <Button
          type="button"
          variant="link"
          className="w-full"
          disabled={running}
          onClick={() => {
            setError(null)
            setMode('password')
          }}
        >
          {t('sync.restore.usePassword')}
        </Button>
        {cancelButton}
      </CardFooter>
    </form>
  )
}

// A fresh device restores its data from sync (spec §19): sign in, find the
// cloud vault, then the encryption password (or the recovery key and a new
// password). Nothing is written before the secret is verified.
export function SyncRestoreScreen({ onRestored, onCancel }: SyncRestoreScreenProps) {
  const session = useAccountSession()
  const { t } = useT()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background/80 backdrop-blur-sm">
      <Card className="w-full max-w-sm mx-4 my-4" data-testid="sync-restore-screen">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Cloud className="h-4 w-4 text-muted-foreground" />
            <CardTitle>{t('sync.restore.title')}</CardTitle>
            <LanguageToggle testId="sync-restore-language" className="ml-auto" />
          </div>
          {!session && <CardDescription>{t('sync.restore.signInBody')}</CardDescription>}
        </CardHeader>
        {session ? (
          <RestoreFlow onRestored={onRestored} onCancel={onCancel} />
        ) : (
          <CardFooter className="flex flex-col gap-2">
            <Link
              to="/login"
              search={{ redirect: '/?restore=sync' }}
              data-testid="sync-restore-sign-in"
              className={buttonVariants({ className: 'w-full' })}
            >
              {t('sync.restore.signIn')}
            </Link>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              data-testid="sync-restore-cancel"
              onClick={onCancel}
            >
              {t('sync.restore.cancel')}
            </Button>
          </CardFooter>
        )}
      </Card>
    </div>
  )
}
