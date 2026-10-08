import { useState } from 'react'
import { Loader2, Lock } from 'lucide-react'

import type { UnlockResult } from '@/lib/vault'
import { VaultError, unlockWithPassword } from '@/lib/vault'
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

interface UnlockScreenProps {
  // True for a v1 store: it has no recovery key, so no "Forgot password?".
  legacy: boolean
  onUnlocked: (result: UnlockResult) => void
  onForgotPassword: () => void
}

export function UnlockScreen({
  legacy,
  onUnlocked,
  onForgotPassword,
}: UnlockScreenProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setPending(true)
    try {
      const result = await unlockWithPassword(password)
      onUnlocked(result)
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <Card className="w-full max-w-sm mx-4" data-testid="unlock-screen">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-muted-foreground" />
            <CardTitle>Enter encryption password</CardTitle>
          </div>
          <CardDescription>
            {legacy
              ? 'Enter your password to decrypt your local data. After unlocking, your data will be upgraded to the new encryption format.'
              : 'Enter your password to decrypt your local data.'}
          </CardDescription>
        </CardHeader>

        <form onSubmit={(e) => void handleSubmit(e)}>
          <CardContent className="flex flex-col gap-4 mb-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                data-testid="unlock-password-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                autoComplete="current-password"
                disabled={pending}
              />
            </div>

            {error && (
              <p data-testid="unlock-error" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </CardContent>

          <CardFooter className="flex flex-col gap-2">
            <Button
              type="submit"
              className="w-full"
              data-testid="unlock-submit"
              disabled={pending}
            >
              {pending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {legacy ? 'Upgrading…' : 'Unlocking…'}
                </>
              ) : (
                'Unlock'
              )}
            </Button>
            {!legacy && (
              <Button
                type="button"
                variant="link"
                size="sm"
                data-testid="unlock-forgot-password"
                onClick={onForgotPassword}
                disabled={pending}
              >
                Forgot password?
              </Button>
            )}
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
