import { useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'

import {
  VaultError,
  resetPasswordWithRecoveryKey,
  unlockWithRecoveryKey,
} from '@/lib/vault'
import { t as translateNow, useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { LanguageToggle } from '@/components/LanguageToggle'
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

interface RecoverScreenProps {
  onRecovered: () => void
  onCancel: () => void
  // "I've lost both": offers removing all data from this device.
  onLostBoth?: () => void
}

type Step = 'key' | 'password'

const MIN_PASSWORD_LENGTH = 8

function messageOf(err: unknown): string {
  if (err instanceof VaultError) return errorMessage(err)
  console.error(err)
  return translateNow('errors.unexpected')
}

// Forgot-password flow (§2.3): the recovery key unlocks the vault, then the
// user sets a new password (the DEK is re-wrapped; data is not re-encrypted).
export function RecoverScreen({
  onRecovered,
  onCancel,
  onLostBoth,
}: RecoverScreenProps) {
  const [step, setStep] = useState<Step>('key')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const { t } = useT()

  const handleKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setPending(true)
    try {
      await unlockWithRecoveryKey(recoveryKey)
      setStep('password')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setPending(false)
    }
  }

  const handlePasswordSubmit = async (e: React.FormEvent) => {
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
      await resetPasswordWithRecoveryKey(recoveryKey, password)
      onRecovered()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setPending(false)
    }
  }

  const errorText = error && (
    <p data-testid="recover-error" className="text-sm text-destructive">
      {error}
    </p>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <Card className="w-full max-w-sm mx-4" data-testid="recover-screen">
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            <CardTitle>
              {step === 'key' ? t('vault.recover.keyTitle') : t('vault.recover.passwordTitle')}
            </CardTitle>
            <LanguageToggle testId="recover-language" className="ml-auto" />
          </div>
          <CardDescription>
            {step === 'key'
              ? t('vault.recover.keyDescription')
              : t('vault.recover.passwordDescription')}
          </CardDescription>
        </CardHeader>

        {step === 'key' ? (
          <form onSubmit={(e) => void handleKeySubmit(e)}>
            <CardContent className="flex flex-col gap-4 mb-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="recovery-key">{t('vault.recoveryKey')}</Label>
                <Input
                  id="recovery-key"
                  data-testid="recover-key-input"
                  type="text"
                  value={recoveryKey}
                  onChange={(e) => setRecoveryKey(e.target.value)}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  disabled={pending}
                />
              </div>
              {errorText}
            </CardContent>
            <CardFooter className="flex flex-col gap-2">
              <Button
                type="submit"
                className="w-full"
                data-testid="recover-key-submit"
                disabled={pending}
              >
                {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('common.continue')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                data-testid="recover-cancel"
                onClick={onCancel}
                disabled={pending}
              >
                {t('vault.recover.backToPassword')}
              </Button>
              {onLostBoth && (
                <Button
                  type="button"
                  variant="link"
                  className="w-full whitespace-normal text-muted-foreground"
                  data-testid="recover-lost-both"
                  onClick={onLostBoth}
                  disabled={pending}
                >
                  {t('vault.recover.lostBoth')}
                </Button>
              )}
            </CardFooter>
          </form>
        ) : (
          <form onSubmit={(e) => void handlePasswordSubmit(e)}>
            <CardContent className="flex flex-col gap-4 mb-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-password">{t('vault.newPassword')}</Label>
                <Input
                  id="new-password"
                  data-testid="recover-password-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  autoComplete="new-password"
                  disabled={pending}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="confirm-new-password">{t('vault.confirmNewPassword')}</Label>
                <Input
                  id="confirm-new-password"
                  data-testid="recover-confirm-input"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  disabled={pending}
                />
              </div>
              {errorText}
            </CardContent>
            <CardFooter>
              <Button
                type="submit"
                className="w-full"
                data-testid="recover-password-submit"
                disabled={pending}
              >
                {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('vault.recover.submitPassword')}
              </Button>
            </CardFooter>
          </form>
        )}
      </Card>
    </div>
  )
}
