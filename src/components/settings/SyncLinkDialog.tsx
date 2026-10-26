import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Download, Loader2 } from 'lucide-react'

import type { CloudVault } from '@/lib/cloud/types'
import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { downloadBackup } from '@/lib/backup'
import { REPLACE_CONFIRMATION } from '@/lib/sync/actions'
import { getSyncRuntime } from '@/lib/sync/runtime'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface SyncLinkDialogProps {
  open: boolean
  cloud: CloudVault | null
  onOpenChange: (open: boolean) => void
  onLinked: () => void
}

type Choice = 'join' | 'replace'

function failureText(err: unknown, t: ReturnType<typeof useT>['t']): string {
  if (err instanceof Error && (err.name === 'CloudError' || err.name === 'SyncActionError')) {
    const code = (err as { code?: unknown }).code
    return t('sync.errors.actionFailed', { code: typeof code === 'string' ? code : 'unknown' })
  }
  return errorMessage(err)
}

// Turning sync on where the cloud already holds another vault: this device
// has separate data. "Join cloud data and keep this device's entries" (the
// default, with the cloud password), "Replace cloud data with this device"
// (typed DELETE) or Cancel, which changes nothing.
export function SyncLinkDialog({ open, cloud, onOpenChange, onLinked }: SyncLinkDialogProps) {
  const queryClient = useQueryClient()
  const [choice, setChoice] = useState<Choice>('join')
  const [password, setPassword] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const { t } = useT()

  useEffect(() => {
    if (!open) {
      setChoice('join')
      setPassword('')
      setConfirmText('')
      setError(null)
      setPending(false)
    }
  }, [open])

  const canConfirm =
    !pending &&
    cloud !== null &&
    (choice === 'join' ? password !== '' : confirmText === REPLACE_CONFIRMATION)

  const handleConfirm = async () => {
    if (!canConfirm || cloud === null) return
    setPending(true)
    setError(null)
    try {
      const { actions } = getSyncRuntime()
      if (choice === 'join') await actions.joinAndKeep(cloud, password)
      else await actions.replaceCloud(confirmText)
    } catch (err) {
      setError(failureText(err, t))
      setPending(false)
      return
    }
    setPending(false)
    void queryClient.invalidateQueries()
    onLinked()
  }

  const handleBackup = async () => {
    setBackingUp(true)
    try {
      await downloadBackup()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBackingUp(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="sync-link-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('sync.link.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('sync.link.body')}</AlertDialogDescription>
        </AlertDialogHeader>

        <Button
          type="button"
          variant="outline"
          data-testid="sync-link-backup-btn"
          disabled={backingUp || pending}
          onClick={() => void handleBackup()}
        >
          <Download className="mr-2 h-4 w-4" />
          {t('sync.link.backupFirst')}
        </Button>

        <fieldset className="flex flex-col gap-3" disabled={pending}>
          <label htmlFor="sync-link-option-join" className="flex items-start gap-2 text-sm">
            <input
              id="sync-link-option-join"
              data-testid="sync-link-option-join"
              type="radio"
              name="sync-link-choice"
              className="mt-0.5 h-4 w-4"
              checked={choice === 'join'}
              onChange={() => {
                setChoice('join')
                setError(null)
              }}
            />
            <span>
              <span className="font-medium">{t('sync.link.join')}</span>
              <span className="block text-muted-foreground">{t('sync.link.joinHint')}</span>
            </span>
          </label>
          <label htmlFor="sync-link-option-replace" className="flex items-start gap-2 text-sm">
            <input
              id="sync-link-option-replace"
              data-testid="sync-link-option-replace"
              type="radio"
              name="sync-link-choice"
              className="mt-0.5 h-4 w-4"
              checked={choice === 'replace'}
              onChange={() => {
                setChoice('replace')
                setError(null)
              }}
            />
            <span>
              <span className="font-medium">{t('sync.link.replace')}</span>
              <span className="block text-muted-foreground">{t('sync.link.replaceHint')}</span>
            </span>
          </label>
        </fieldset>

        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            void handleConfirm()
          }}
        >
          {choice === 'join' ? (
            <>
              <Label htmlFor="sync-link-password">{t('sync.link.passwordLabel')}</Label>
              <Input
                id="sync-link-password"
                data-testid="sync-link-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={pending}
              />
            </>
          ) : (
            <>
              <Label htmlFor="sync-link-delete-input">
                {t('common.typeToConfirm', { word: REPLACE_CONFIRMATION })}
              </Label>
              <Input
                id="sync-link-delete-input"
                data-testid="sync-link-delete-input"
                type="text"
                autoComplete="off"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                disabled={pending}
              />
            </>
          )}
        </form>

        {error && (
          <p data-testid="sync-link-error" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            data-testid="sync-link-cancel"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {t('sync.link.cancel')}
          </Button>
          <Button
            type="button"
            variant={choice === 'replace' ? 'destructive' : 'default'}
            data-testid="sync-link-confirm"
            disabled={!canConfirm}
            onClick={() => void handleConfirm()}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('sync.link.confirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
