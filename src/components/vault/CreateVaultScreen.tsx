import { useState } from 'react'
import { KeyRound, Loader2, Lock } from 'lucide-react'

import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { updateAppSettings } from '@/lib/appSettings'
import { requestPersistentStorage } from '@/lib/storagePersistence'
import { VaultError, createVault } from '@/lib/vault'
import { LanguageToggle } from '@/components/LanguageToggle'
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

function strengthKey(password: string): MessageKey {
  if (password.length < MIN_PASSWORD_LENGTH) return 'vault.strength.tooShort'
  if (password.length < 12) return 'vault.strength.ok'
  return 'vault.strength.strong'
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
  const [confirming, setConfirming] = useState(false)
  const { t } = useT()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t('vault.passwordTooShort'))
      return
    }
    if (password !== confirm) {
      setError(t('vault.passwordsDontMatch'))
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
        setError(errorMessage(err))
      } else {
        console.error(err)
        setError(t('errors.unexpected'))
      }
    } finally {
      setPending(false)
    }
  }

  // createVault stored recoveryKeyConfirmed: false; the user has now saved the
  // key. A failed write only leaves the Dashboard banner showing.
  const handleKeyConfirmed = async () => {
    if (confirming) return
    setConfirming(true)
    try {
      await updateAppSettings({ recoveryKeyConfirmed: true })
    } catch (err) {
      console.error('Could not save the recovery key confirmation:', err)
    }
    onCreated()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background/80 backdrop-blur-sm">
      <Card className="w-full max-w-sm mx-4 my-4" data-testid="create-vault-screen">
        {recoveryKey !== null ? (
          <>
            <CardHeader>
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-muted-foreground" />
                <CardTitle>{t('vault.saveKey.title')}</CardTitle>
                <LanguageToggle testId="create-vault-language" className="ml-auto" />
              </div>
              <CardDescription>{t('vault.saveKey.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <RecoveryKeySaveStep
                recoveryKey={recoveryKey}
                onConfirmed={() => void handleKeyConfirmed()}
              />
            </CardContent>
          </>
        ) : (
          <>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-muted-foreground" />
                <CardTitle>{t('vault.create.title')}</CardTitle>
                <LanguageToggle testId="create-vault-language" className="ml-auto" />
              </div>
              <CardDescription>{t('vault.create.description')}</CardDescription>
            </CardHeader>

            <form onSubmit={(e) => void handleSubmit(e)}>
              <CardContent className="flex flex-col gap-4 mb-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="password">{t('vault.password')}</Label>
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
                    {t('vault.strength.label', { strength: t(strengthKey(password)) })}
                  </p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="confirm">{t('vault.confirmPassword')}</Label>
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
                      {t('vault.create.creating')}
                    </>
                  ) : (
                    t('vault.create.submit')
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
                    {t('common.back')}
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
