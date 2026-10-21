import { useEffect, useState } from 'react'
import { Loader2, Upload } from 'lucide-react'

import type { RestoreMode, RestoreSummary } from '@/lib/backup'
import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import {
  defaultRestoreMode,
  formatRestoreSummary,
  restoreBackup,
} from '@/lib/backup'
import { storageKeyLabel } from '@/lib/dataErrors'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface RestoreBackupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Landing page: the device has no vault, so the backup's vault is adopted
  // and the mode is always replace (no mode select).
  freshDevice?: boolean
  // Recovery screens (orphaned data, Data problem): hides the mode select,
  // skips defaultRestoreMode and always restores with 'replace'.
  forceReplace?: boolean
  onRestored?: (summary: RestoreSummary) => void
}


// Restore a .minima backup (spec §7.3).
export function RestoreBackupDialog({
  open,
  onOpenChange,
  freshDevice = false,
  forceReplace = false,
  onRestored,
}: RestoreBackupDialogProps) {
  const replaceOnly = freshDevice || forceReplace
  const [file, setFile] = useState<File | null>(null)
  const [secret, setSecret] = useState('')
  const [mode, setMode] = useState<RestoreMode>('merge')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<RestoreSummary | null>(null)
  const { t } = useT()

  useEffect(() => {
    if (!open) {
      setFile(null)
      setSecret('')
      setMode('merge')
      setPending(false)
      setError(null)
      setSummary(null)
      return
    }
    if (replaceOnly) return
    let cancelled = false
    defaultRestoreMode().then(
      (value) => {
        if (!cancelled) setMode(value)
      },
      (err: unknown) => {
        console.error('Could not pick the default restore mode:', err)
      },
    )
    return () => {
      cancelled = true
    }
  }, [open, replaceOnly])

  const canSubmit =
    file !== null && secret.length > 0 && !pending && summary === null

  const handleSubmit = async () => {
    if (!file || !canSubmit) return
    setError(null)
    setPending(true)
    try {
      const result = await restoreBackup(
        file,
        secret,
        replaceOnly ? 'replace' : mode,
      )
      setSummary(result)
      onRestored?.(result)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="restore-backup-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('backup.restoreFromBackup')}</AlertDialogTitle>
          <AlertDialogDescription>{t('backup.restore.description')}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="restore-backup-file">{t('backup.restore.file')}</Label>
            <Input
              id="restore-backup-file"
              data-testid="restore-backup-file-input"
              type="file"
              accept=".minima,application/json"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={pending}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="restore-backup-secret">{t('backup.restore.secret')}</Label>
            <Input
              id="restore-backup-secret"
              data-testid="restore-backup-secret-input"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="off"
              disabled={pending}
            />
            <p
              data-testid="restore-backup-unlock-rule"
              className="text-xs text-muted-foreground"
            >
              {t('backup.restore.unlockRule')}
            </p>
          </div>

          {forceReplace && (
            <p
              data-testid="restore-backup-replace-note"
              className="text-sm text-muted-foreground"
            >
              {t('backup.restore.replaceNote')}
            </p>
          )}

          {!replaceOnly && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="restore-backup-mode">{t('backup.restore.mode')}</Label>
              <select
                id="restore-backup-mode"
                data-testid="restore-backup-mode-select"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={mode}
                onChange={(e) =>
                  setMode(e.target.value === 'replace' ? 'replace' : 'merge')
                }
                disabled={pending}
              >
                <option value="merge">{t('backup.restore.modeMerge')}</option>
                <option value="replace">{t('backup.restore.modeReplace')}</option>
              </select>
            </div>
          )}

          {error !== null && (
            <p
              data-testid="restore-backup-error"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}

          {summary !== null && (
            <p data-testid="restore-backup-summary" className="text-sm">
              {formatRestoreSummary(summary)}
              {summary.skipped.length > 0 && (
                <span className="mt-1 block text-muted-foreground">
                  {t('backup.restore.notInBackup', {
                    keys: summary.skipped.map(storageKeyLabel).join(', '),
                  })}
                </span>
              )}
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel data-testid="restore-backup-cancel">
            {summary !== null ? t('common.done') : t('common.cancel')}
          </AlertDialogCancel>
          {/* A plain Button, so the dialog stays open while it restores. */}
          <Button
            type="button"
            data-testid="restore-backup-submit"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            {pending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            {t('backup.restore.submit')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
