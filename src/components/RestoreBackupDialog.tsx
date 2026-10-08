import { useEffect, useState } from 'react'
import { Loader2, Upload } from 'lucide-react'

import type { RestoreMode, RestoreSummary } from '@/lib/backup'
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
  onRestored?: (summary: RestoreSummary) => void
}

const UNLOCK_RULE =
  'Use the password that was current when this backup was made, or your recovery key (unless you have generated a new one since).'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Restore a .minima backup (spec §7.3).
export function RestoreBackupDialog({
  open,
  onOpenChange,
  freshDevice = false,
  onRestored,
}: RestoreBackupDialogProps) {
  const [file, setFile] = useState<File | null>(null)
  const [secret, setSecret] = useState('')
  const [mode, setMode] = useState<RestoreMode>('merge')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<RestoreSummary | null>(null)

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
    if (freshDevice) return
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
  }, [open, freshDevice])

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
        freshDevice ? 'replace' : mode,
      )
      setSummary(result)
      onRestored?.(result)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="restore-backup-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Restore from backup</AlertDialogTitle>
          <AlertDialogDescription>
            Choose a .minima backup file and enter the password or recovery key
            that opens it.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="restore-backup-file">Backup file</Label>
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
            <Label htmlFor="restore-backup-secret">
              Backup password or recovery key
            </Label>
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
              {UNLOCK_RULE}
            </p>
          </div>

          {!freshDevice && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="restore-backup-mode">Restore mode</Label>
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
                <option value="merge">Merge with this device</option>
                <option value="replace">Replace data on this device</option>
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
                  {`Not in this backup: ${summary.skipped
                    .map(storageKeyLabel)
                    .join(', ')}`}
                </span>
              )}
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel data-testid="restore-backup-cancel">
            {summary !== null ? 'Done' : 'Cancel'}
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
            Restore
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
