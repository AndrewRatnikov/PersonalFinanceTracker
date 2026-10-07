import { useEffect, useState } from 'react'
import { KeyRound, Loader2, TriangleAlert } from 'lucide-react'

import type { UnlockResult } from '@/lib/vault'
import { clearLegacyKeys, getVaultState } from '@/lib/vault'
import { clearLocalDb } from '@/lib/localDb'
import { CreateVaultScreen } from '@/components/vault/CreateVaultScreen'
import { RecoverScreen } from '@/components/vault/RecoverScreen'
import { RecoveryKeySaveStep } from '@/components/vault/RecoveryKeySaveStep'
import { UnlockScreen } from '@/components/vault/UnlockScreen'
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

interface PasswordUnlockDialogProps {
  onUnlocked: (result: { isNewVault: boolean }) => void
}

// checking  -> getVaultState() pending
// create    -> no vault and no data ('none'), or after erasing orphaned data
// unlock    -> 'v1' (legacy, migrates on unlock) or 'v2'
// recover   -> "Forgot password?" (v2 only)
// migrated  -> a v1 unlock migrated the store; show the new recovery key
// recovery  -> data keys without a vault ('orphaned') or the state check
//              failed: never offer "Create password" over data that may exist
type Mode =
  | { kind: 'checking' }
  | { kind: 'create' }
  | { kind: 'unlock'; legacy: boolean }
  | { kind: 'recover' }
  | { kind: 'migrated'; recoveryKey: string }
  | { kind: 'recovery' }

const ERASE_CONFIRMATION = 'DELETE'

export function PasswordUnlockDialog({ onUnlocked }: PasswordUnlockDialogProps) {
  const [mode, setMode] = useState<Mode>({ kind: 'checking' })
  const [eraseValue, setEraseValue] = useState('')
  const [eraseError, setEraseError] = useState<string | null>(null)
  const [erasing, setErasing] = useState(false)
  const [finishing, setFinishing] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.resolve()
      .then(() => getVaultState())
      .then(
        (state) => {
          if (cancelled) return
          if (state === 'none') setMode({ kind: 'create' })
          else if (state === 'v1') setMode({ kind: 'unlock', legacy: true })
          else if (state === 'v2') setMode({ kind: 'unlock', legacy: false })
          else setMode({ kind: 'recovery' })
        },
        () => {
          // Safe side: never offer "Create password" over data that might exist.
          if (!cancelled) setMode({ kind: 'recovery' })
        },
      )
    return () => {
      cancelled = true
    }
  }, [])

  const handleUnlocked = (result: UnlockResult) => {
    if (result.recoveryKey !== null) {
      setMode({ kind: 'migrated', recoveryKey: result.recoveryKey })
      return
    }
    onUnlocked({ isNewVault: false })
  }

  const handleMigratedKeyConfirmed = async () => {
    setFinishing(true)
    try {
      await clearLegacyKeys()
    } catch (err) {
      // The stale v1 keys are harmless once meta:vault exists.
      console.error(err)
    } finally {
      setFinishing(false)
    }
    onUnlocked({ isNewVault: false })
  }

  const canErase = eraseValue === ERASE_CONFIRMATION && !erasing

  const handleErase = async () => {
    if (eraseValue !== ERASE_CONFIRMATION) return
    setEraseError(null)
    setErasing(true)
    try {
      await clearLocalDb()
      setEraseValue('')
      setMode({ kind: 'create' })
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

  switch (mode.kind) {
    case 'create':
      return (
        <CreateVaultScreen onCreated={() => onUnlocked({ isNewVault: true })} />
      )
    case 'unlock':
      return (
        <UnlockScreen
          legacy={mode.legacy}
          onUnlocked={handleUnlocked}
          onForgotPassword={() => setMode({ kind: 'recover' })}
        />
      )
    case 'recover':
      return (
        <RecoverScreen
          onRecovered={() => onUnlocked({ isNewVault: false })}
          onCancel={() => setMode({ kind: 'unlock', legacy: false })}
        />
      )
    case 'migrated':
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background/80 backdrop-blur-sm">
          <Card
            className="w-full max-w-sm mx-4 my-4"
            data-testid="unlock-migrated-key"
          >
            <CardHeader>
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-muted-foreground" />
                <CardTitle>Save your recovery key</CardTitle>
              </div>
              <CardDescription>
                Your data has been upgraded to the new encryption format. If
                you forget your password, this key is the only way to open it.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <RecoveryKeySaveStep
                recoveryKey={mode.recoveryKey}
                confirmLabel="Continue"
                onConfirmed={() => {
                  if (!finishing) void handleMigratedKeyConfirmed()
                }}
              />
            </CardContent>
          </Card>
        </div>
      )
    case 'recovery':
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
                that password the data cannot be recovered. You can erase it
                and start fresh.
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
    case 'checking':
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
}
