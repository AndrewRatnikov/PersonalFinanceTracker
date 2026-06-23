import { useState } from 'react'
import { Loader2, Lock } from 'lucide-react'

import {
  checkKeyVerifier,
  deriveKey,
  getOrCreateDeviceSalt,
  storeKeyVerifier,
} from '@/lib/crypto'
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

interface Props {
  userId: string
  onUnlocked: (key: CryptoKey, isNewUser: boolean) => void
}

export function PasswordUnlockDialog({ userId, onUnlocked }: Props) {
  const isNewUser = !localStorage.getItem('minima_key_verify_' + userId)

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (isNewUser) {
      if (password.length < 8) {
        setError('Password must be at least 8 characters')
        return
      }
      if (password !== confirm) {
        setError('Passwords do not match')
        return
      }
    }

    setPending(true)
    try {
      const salt = getOrCreateDeviceSalt(userId)
      const key = await deriveKey(password, salt)

      if (isNewUser) {
        await storeKeyVerifier(key, userId)
        onUnlocked(key, true)
      } else {
        const valid = await checkKeyVerifier(key, userId)
        if (!valid) {
          setError('Incorrect password')
          return
        }
        onUnlocked(key, false)
      }
    } catch (err) {
      setError('Something went wrong. Please try again.')
      console.error(err)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <Card className="w-full max-w-sm mx-4">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-muted-foreground" />
            <CardTitle>
              {isNewUser
                ? 'Create encryption password'
                : 'Enter encryption password'}
            </CardTitle>
          </div>
          <CardDescription>
            {isNewUser
              ? 'Your data is stored locally and encrypted. Choose a password to protect it.'
              : 'Enter your password to decrypt your local data.'}
          </CardDescription>
        </CardHeader>

        <form onSubmit={handleSubmit}>
          <CardContent className="flex flex-col gap-4 mb-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                autoComplete={isNewUser ? 'new-password' : 'current-password'}
                disabled={pending}
              />
            </div>

            {isNewUser && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="confirm">Confirm password</Label>
                <Input
                  id="confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  disabled={pending}
                />
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>

          <CardFooter>
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {isNewUser ? 'Creating…' : 'Unlocking…'}
                </>
              ) : isNewUser ? (
                'Create password'
              ) : (
                'Unlock'
              )}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
