import { useState } from 'react'
import { KeyRound, Loader2, Lock } from 'lucide-react'

import { VaultError, changePassword, regenerateRecoveryKey } from '@/lib/vault'
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

  const handleConfirmed = () => {
    setNewKey(null)
    setPassword('')
    setSuccess(true)
  }

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
        {newKey !== null ? (
          <RecoveryKeySaveStep
            recoveryKey={newKey}
            confirmLabel="Done"
            onConfirmed={handleConfirmed}
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

export function SecurityTab() {
  return (
    <div data-testid="security-tab" className="flex flex-col gap-6">
      <ChangePasswordCard />
      <RegenerateKeyCard />
    </div>
  )
}
