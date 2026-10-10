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
  if (err instanceof VaultError) return err.message
  console.error(err)
  return 'Something went wrong. Please try again.'
}

function ChangePasswordCard() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [pending, setPending] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError('New password must be at least 8 characters')
      return
    }
    if (next !== confirm) {
      setError('New passwords do not match')
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
          <CardTitle>Change password</CardTitle>
        </div>
        <CardDescription>
          Your data stays as it is; only the key that protects it is updated.
          Your recovery key keeps working.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => void handleSubmit(e)}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="change-password-current">Current password</Label>
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
            <Label htmlFor="change-password-new">New password</Label>
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
            <Label htmlFor="change-password-confirm">Confirm new password</Label>
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
              Password changed
            </p>
          )}
          <Button
            type="submit"
            data-testid="change-password-submit"
            disabled={pending}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Change password
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
          <CardTitle>Generate new recovery key</CardTitle>
        </div>
        <CardDescription>
          Creates a new recovery key. The old one stops working immediately.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {showUnconfirmedWarning && (
          <p
            data-testid="regenerate-key-unconfirmed-warning"
            className="text-sm text-destructive"
          >
            You haven&apos;t saved a recovery key for this device. Generate a
            new one and save it.
          </p>
        )}
        {newKey !== null ? (
          <RecoveryKeySaveStep
            recoveryKey={newKey}
            confirmLabel="Done"
            onConfirmed={() => void handleConfirmed()}
          />
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => void handleSubmit(e)}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="regenerate-key-password">Password</Label>
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
                New recovery key saved. The old one no longer works.
              </p>
            )}
            <Button
              type="submit"
              data-testid="regenerate-key-submit"
              disabled={pending}
            >
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Generate new recovery key
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

const AUTO_LOCK_CHOICES: ReadonlyArray<{
  value: AutoLockMinutes
  label: string
}> = [
  { value: 0, label: 'Off' },
  { value: 1, label: '1 minute' },
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 60, label: '60 minutes' },
]

function AutoLockCard() {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: APP_SETTINGS_QUERY_KEY,
    queryFn: getAppSettings,
  })
  const value = data?.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES

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
          <CardTitle>Auto-lock</CardTitle>
        </div>
        <CardDescription>
          Lock the app after this long without activity. Time in another tab or
          app counts too.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        <Label htmlFor="auto-lock-select">Lock after</Label>
        <select
          id="auto-lock-select"
          data-testid="auto-lock-select"
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={String(value)}
          onChange={(e) => void handleChange(e.target.value)}
        >
          {AUTO_LOCK_CHOICES.map((choice) => (
            <option key={choice.value} value={String(choice.value)}>
              {choice.label}
            </option>
          ))}
        </select>
      </CardContent>
    </Card>
  )
}

function LockNowCard() {
  const queryClient = useQueryClient()

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <CardTitle>Lock now</CardTitle>
        </div>
        <CardDescription>
          Locks the app on this device. Your data stays; you need your password
          to open it again.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          variant="outline"
          data-testid="lock-now-btn"
          onClick={() => lockApp(queryClient)}
        >
          Lock now
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
