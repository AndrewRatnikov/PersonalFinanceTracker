import { useEffect, useState } from 'react'
import { Loader2, Lock, TriangleAlert } from 'lucide-react'

import {
  checkKeyVerifier,
  deriveKey,
  getOrCreateDeviceSalt,
  storeKeyVerifier,
} from '@/lib/crypto'
import { clearLocalDb, hasLocalData } from '@/lib/localDb'
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

// Without a verifier we first check IndexedDB: if data already exists there,
// "Create password" would make it unreadable, so we offer recovery instead.
type NoVerifierMode = 'checking' | 'create' | 'recovery'

const ERASE_CONFIRMATION = 'DELETE'

export function PasswordUnlockDialog({ userId, onUnlocked }: Props) {
  const hasVerifier = !!localStorage.getItem('minima_key_verify_' + userId)
  const isNewUser = !hasVerifier

  const [mode, setMode] = useState<NoVerifierMode>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [eraseValue, setEraseValue] = useState('')
  const [eraseError, setEraseError] = useState<string | null>(null)
  const [erasing, setErasing] = useState(false)

  useEffect(() => {
    if (hasVerifier) return
    let cancelled = false
    void Promise.resolve()
      .then(() => hasLocalData())
      .then(
      (exists) => {
        if (!cancelled) setMode(exists ? 'recovery' : 'create')
      },
      () => {
        // Safe side: never offer "Create password" over data that might exist.
        if (!cancelled) setMode('recovery')
      },
    )
    return () => {
      cancelled = true
    }
  }, [hasVerifier])

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

  const canErase = eraseValue === ERASE_CONFIRMATION && !erasing

  const handleErase = async () => {
    if (eraseValue !== ERASE_CONFIRMATION) return
    setEraseError(null)
    setErasing(true)
    try {
      await clearLocalDb()
      setEraseValue('')
      setMode('create')
    } catch (err) {
      setEraseError(
        err instanceof Error
          ? `Could not erase local data: ${err.message}`
          : 'Could not erase local data.',
      )
    } finally {
      setErasing(false)
    }
  }

  if (!hasVerifier && mode === 'checking') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
        <Card className="w-full max-w-sm mx-4" data-testid="unlock-checking">
          <CardContent className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking this device…
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!hasVerifier && mode === 'recovery') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
        <Card className="w-full max-w-sm mx-4" data-testid="unlock-recovery">
          <CardHeader>
            <div className="flex items-center gap-2">
              <TriangleAlert className="h-4 w-4 text-destructive" />
              <CardTitle>Local data can't be opened</CardTitle>
            </div>
            <CardDescription>
              This device has saved data, but no password to open it. Without
              that password the data cannot be recovered. You can erase it and
              start fresh.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="unlock-erase-input">Type DELETE to confirm</Label>
              <Input
                id="unlock-erase-input"
                data-testid="unlock-erase-input"
                type="text"
                value={eraseValue}
                onChange={(e) => setEraseValue(e.target.value)}
                autoComplete="off"
                disabled={erasing}
              />
            </div>
            {eraseError && (
              <p
                data-testid="unlock-erase-error"
                className="text-sm text-destructive"
              >
                {eraseError}
              </p>
            )}
          </CardContent>
          <CardFooter>
            <Button
              type="button"
              variant="destructive"
              className="w-full"
              data-testid="unlock-erase-button"
              disabled={!canErase}
              onClick={() => void handleErase()}
            >
              {erasing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Erase local data and start fresh
            </Button>
          </CardFooter>
        </Card>
      </div>
    )
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

        <form data-testid="unlock-form" onSubmit={handleSubmit}>
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
            <Button
              type="submit"
              className="w-full"
              data-testid="unlock-submit"
              disabled={pending}
            >
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
