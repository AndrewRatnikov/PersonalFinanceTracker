import { useState } from 'react'
import { KeyRound, Loader2, Lock } from 'lucide-react'

import { requestPersistentStorage } from '@/lib/storagePersistence'
import { VaultError, createVault } from '@/lib/vault'
import { RecoveryKeySaveStep } from '@/components/vault/RecoveryKeySaveStep'
import { Button } from '@/components/ui/button'
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

interface CreateVaultScreenProps {
  onCreated: () => void
  // Renders a "Back" button on the password step.
  onCancel?: () => void
}

const MIN_PASSWORD_LENGTH = 8

function strengthLabel(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) return 'Too short'
  if (password.length < 12) return 'OK'
  return 'Strong'
}

export function CreateVaultScreen({
  onCreated,
  onCancel,
}: CreateVaultScreenProps) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError('Password must be at least 8 characters')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    setPending(true)
    try {
      const result = await createVault(password)
      // Ask the browser to keep our storage (spec §6.1). Best-effort.
      void requestPersistentStorage()
      setPassword('')
      setConfirm('')
      setRecoveryKey(result.recoveryKey)
    } catch (err) {
      if (err instanceof VaultError) {
        setError(err.message)
      } else {
        console.error(err)
        setError('Something went wrong. Please try again.')
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background/80 backdrop-blur-sm">
      <Card className="w-full max-w-sm mx-4 my-4" data-testid="create-vault-screen">
        {recoveryKey !== null ? (
          <>
            <CardHeader>
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-muted-foreground" />
                <CardTitle>Save your recovery key</CardTitle>
              </div>
              <CardDescription>
                If you forget your password, this key is the only way to open
                your data.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RecoveryKeySaveStep
                recoveryKey={recoveryKey}
                onConfirmed={onCreated}
              />
            </CardContent>
          </>
        ) : (
          <>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-muted-foreground" />
                <CardTitle>Create encryption password</CardTitle>
              </div>
              <CardDescription>
                This password encrypts your data on this device. MinimaSpend
                can&apos;t see it and can&apos;t reset it for you.
              </CardDescription>
            </CardHeader>

            <form onSubmit={(e) => void handleSubmit(e)}>
              <CardContent className="flex flex-col gap-4 mb-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    data-testid="create-vault-password-input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus
                    autoComplete="new-password"
                    disabled={pending}
                  />
                  <p
                    data-testid="create-vault-strength"
                    className="text-xs text-muted-foreground"
                  >
                    Strength: {strengthLabel(password)}
                  </p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="confirm">Confirm password</Label>
                  <Input
                    id="confirm"
                    data-testid="create-vault-confirm-input"
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    disabled={pending}
                  />
                </div>

                {error && (
                  <p
                    data-testid="create-vault-error"
                    className="text-sm text-destructive"
                  >
                    {error}
                  </p>
                )}
              </CardContent>

              <CardFooter className="flex flex-col gap-2">
                <Button
                  type="submit"
                  className="w-full"
                  data-testid="create-vault-submit"
                  disabled={pending}
                >
                  {pending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Creating…
                    </>
                  ) : (
                    'Create password'
                  )}
                </Button>
                {onCancel && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    data-testid="create-vault-cancel"
                    onClick={onCancel}
                    disabled={pending}
                  >
                    Back
                  </Button>
                )}
              </CardFooter>
            </form>
          </>
        )}
      </Card>
    </div>
  )
}
