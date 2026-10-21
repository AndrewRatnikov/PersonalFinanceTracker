import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Loader2, Lock, Timer } from 'lucide-react'

import type { AppSettings, AutoLockMinutes } from '@/lib/appSettings'
import {
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_AUTO_LOCK_MINUTES,
  getAppSettings,
  updateAppSettings,
} from '@/lib/appSettings'
import { t as translateNow, useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { VaultError, changePassword, regenerateRecoveryKey } from '@/lib/vault'
import { lockApp } from '@/lib/vaultSession'
import { RecoveryKeySaveStep } from '@/components/vault/RecoveryKeySaveStep'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const MIN_PASSWORD_LENGTH = 8

function messageOf(err: unknown): string {
  if (err instanceof VaultError) return errorMessage(err)
  console.error(err)
  return translateNow('errors.unexpected')
}

function ChangePasswordCard() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [pending, setPending] = useState(false)
  const { t } = useT()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(t('settings.security.newPasswordTooShort'))
      return
    }
    if (next !== confirm) {
      setError(t('settings.security.newPasswordsDontMatch'))
      return
    }
    setPending(true)
    try {
      await changePassword(current, next)
      setCurrent('')
      setNext('')
      setConfirm('')
      setSuccess(true)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <CardTitle>{t('settings.security.changePassword')}</CardTitle>
        </div>
        <CardDescription>{t('settings.security.changePasswordHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => void handleSubmit(e)}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="change-password-current">
              {t('settings.security.currentPassword')}
            </Label>
            <Input
              id="change-password-current"
              data-testid="change-password-current"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="change-password-new">{t('vault.newPassword')}</Label>
            <Input
              id="change-password-new"
              data-testid="change-password-new"
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="change-password-confirm">{t('vault.confirmNewPassword')}</Label>
            <Input
              id="change-password-confirm"
              data-testid="change-password-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              disabled={pending}
            />
          </div>
          {error && (
            <p
              data-testid="change-password-error"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}
          {success && (
            <p
              data-testid="change-password-success"
              className="text-sm text-muted-foreground"
            >
              {t('settings.security.passwordChanged')}
            </p>
          )}
          <Button
            type="submit"
            data-testid="change-password-submit"
            disabled={pending}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('settings.security.changePassword')}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function RegenerateKeyCard() {
  const queryClient = useQueryClient()
  const { data: settings } = useQuery({
    queryKey: APP_SETTINGS_QUERY_KEY,
    queryFn: getAppSettings,
  })
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [newKey, setNewKey] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [pending, setPending] = useState(false)
  const { t } = useT()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    setPending(true)
    try {
      const result = await regenerateRecoveryKey(password)
      setNewKey(result.recoveryKey)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setPending(false)
    }
  }

  // regenerateRecoveryKey stored recoveryKeyConfirmed: false; the user has now
  // saved the new key. A failed write only leaves the warning showing.
  const handleConfirmed = async () => {
    try {
      await updateAppSettings({ recoveryKeyConfirmed: true })
    } catch (err) {
      console.error('Could not save the recovery key confirmation:', err)
    }
    void queryClient.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY })
    setNewKey(null)
    setPassword('')
    setSuccess(true)
  }

  const showUnconfirmedWarning =
    settings?.recoveryKeyConfirmed === false && newKey === null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <CardTitle>{t('settings.security.regenerate')}</CardTitle>
        </div>
        <CardDescription>{t('settings.security.regenerateHint')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {showUnconfirmedWarning && (
          <p
            data-testid="regenerate-key-unconfirmed-warning"
            className="text-sm text-destructive"
          >
            {t('settings.security.unconfirmedWarning')}
          </p>
        )}
        {newKey !== null ? (
          <RecoveryKeySaveStep
            recoveryKey={newKey}
            confirmLabel={t('common.done')}
            onConfirmed={() => void handleConfirmed()}
          />
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => void handleSubmit(e)}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="regenerate-key-password">{t('vault.password')}</Label>
              <Input
                id="regenerate-key-password"
                data-testid="regenerate-key-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={pending}
              />
            </div>
            {error && (
              <p
                data-testid="regenerate-key-error"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
            {success && (
              <p
                data-testid="regenerate-key-success"
                className="text-sm text-muted-foreground"
              >
                {t('settings.security.regenerated')}
              </p>
            )}
            <Button
              type="submit"
              data-testid="regenerate-key-submit"
              disabled={pending}
            >
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('settings.security.regenerate')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

// 0 = Off; the others are minutes.
const AUTO_LOCK_CHOICES: ReadonlyArray<{ value: AutoLockMinutes }> = [
  { value: 0 },
  { value: 1 },
  { value: 5 },
  { value: 15 },
  { value: 60 },
]

function AutoLockCard() {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: APP_SETTINGS_QUERY_KEY,
    queryFn: getAppSettings,
  })
  const value = data?.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES
  const { t, plural } = useT()

  const handleChange = async (next: string) => {
    const minutes = Number(next)
    const choice = AUTO_LOCK_CHOICES.find((c) => c.value === minutes)
    if (!choice) return
    // Show the choice at once; the refetch below confirms what was stored.
    queryClient.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, (old) =>
      old ? { ...old, autoLockMinutes: choice.value } : old,
    )
    try {
      await updateAppSettings({ autoLockMinutes: choice.value })
    } catch (err) {
      console.error('Could not save the auto-lock setting:', err)
    } finally {
      void queryClient.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY })
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Timer className="h-4 w-4 text-muted-foreground" />
          <CardTitle>{t('settings.security.autoLock')}</CardTitle>
        </div>
        <CardDescription>{t('settings.security.autoLockHint')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        <Label htmlFor="auto-lock-select">{t('settings.security.lockAfter')}</Label>
        <select
          id="auto-lock-select"
          data-testid="auto-lock-select"
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={String(value)}
          onChange={(e) => void handleChange(e.target.value)}
        >
          {AUTO_LOCK_CHOICES.map((choice) => (
            <option key={choice.value} value={String(choice.value)}>
              {choice.value === 0
                ? t('settings.security.off')
                : plural('settings.security.minutes', choice.value)}
            </option>
          ))}
        </select>
      </CardContent>
    </Card>
  )
}

function LockNowCard() {
  const queryClient = useQueryClient()
  const { t } = useT()

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <CardTitle>{t('settings.security.lockNow')}</CardTitle>
        </div>
        <CardDescription>{t('settings.security.lockNowHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          variant="outline"
          data-testid="lock-now-btn"
          onClick={() => lockApp(queryClient)}
        >
          {t('settings.security.lockNow')}
        </Button>
      </CardContent>
    </Card>
  )
}

export function SecurityTab() {
  return (
    <div data-testid="security-tab" className="flex flex-col gap-6">
      <ChangePasswordCard />
      <RegenerateKeyCard />
      <AutoLockCard />
      <LockNowCard />
    </div>
  )
}
