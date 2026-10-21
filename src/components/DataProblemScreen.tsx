import { useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'

import type { RestoreSummary } from '@/lib/backup'
import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { storageKeyLabel } from '@/lib/dataErrors'
import { RestoreBackupDialog } from '@/components/RestoreBackupDialog'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

interface DataProblemScreenProps {
  storageKey: string
  onRetry: () => void | Promise<void>
  onQuarantine: () => Promise<void>
  // Makes a partial backup of the readable data. Resolves to the skipped
  // storage keys, or null when the user cancelled the share sheet.
  onBackupReadable?: () => Promise<Array<string> | null>
  // Shows "Restore from backup" (replace only: the unreadable data goes to
  // quarantine in the same transaction). Called after a successful restore.
  onRestored?: (summary: RestoreSummary) => void | Promise<void>
}

function errorText(err: unknown): string {
  return errorMessage(err)
}

export function DataProblemScreen({
  storageKey,
  onRetry,
  onQuarantine,
  onBackupReadable,
  onRestored,
}: DataProblemScreenProps) {
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [backupSkipped, setBackupSkipped] = useState<Array<string> | null>(
    null,
  )
  const { t } = useT()

  const handleQuarantine = async () => {
    setError(null)
    setPending(true)
    try {
      await onQuarantine()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPending(false)
    }
  }

  const handleBackup = async () => {
    if (!onBackupReadable) return
    setError(null)
    setPending(true)
    setBackingUp(true)
    try {
      const skipped = await onBackupReadable()
      if (skipped !== null) setBackupSkipped(skipped)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPending(false)
      setBackingUp(false)
    }
  }

  const handleRestored = async (summary: RestoreSummary) => {
    if (!onRestored) return
    setError(null)
    try {
      await onRestored(summary)
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <div
      data-testid="data-problem-screen"
      className="flex min-h-[60vh] items-center justify-center px-4"
    >
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <TriangleAlert className="h-4 w-4 text-destructive" />
            <CardTitle>{t('backup.dataProblem.title')}</CardTitle>
          </div>
          <CardDescription>{t('backup.dataProblem.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm">
            {t('backup.dataProblem.affected')}{' '}
            <span data-testid="data-problem-key" className="font-semibold">
              {storageKeyLabel(storageKey)}
            </span>
          </p>
          <p className="text-sm text-muted-foreground">{t('backup.dataProblem.explain')}</p>
          {onRestored && (
            <p
              data-testid="data-problem-restore-hint"
              className="text-sm text-muted-foreground"
            >
              {t('backup.dataProblem.restoreHint')}
            </p>
          )}
          {backupSkipped !== null && (
            <p
              data-testid="data-problem-backup-done"
              className="text-sm text-emerald-600 dark:text-emerald-400"
            >
              {t('backup.dataProblem.backupDone')}
              {backupSkipped.length > 0 &&
                ` ${t('backup.dataProblem.notIncluded', {
                  keys: backupSkipped.map(storageKeyLabel).join(', '),
                })}`}
            </p>
          )}
          {error !== null && (
            <p
              data-testid="data-problem-error"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="data-problem-retry"
            onClick={() => void onRetry()}
            disabled={pending}
          >
            {t('common.retry')}
          </Button>
          {onBackupReadable && (
            <Button
              type="button"
              variant="outline"
              data-testid="data-problem-backup"
              onClick={() => void handleBackup()}
              disabled={pending}
            >
              {backingUp && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('backup.dataProblem.backupReadable')}
            </Button>
          )}
          {onRestored && (
            <Button
              type="button"
              variant="outline"
              data-testid="data-problem-restore"
              onClick={() => setRestoreOpen(true)}
              disabled={pending}
            >
              {t('backup.restoreFromBackup')}
            </Button>
          )}
          <Button
            type="button"
            data-testid="data-problem-quarantine"
            onClick={() => void handleQuarantine()}
            disabled={pending}
          >
            {pending && !backingUp && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {t('backup.dataProblem.quarantine')}
          </Button>
        </CardFooter>
      </Card>
      {onRestored && (
        <RestoreBackupDialog
          open={restoreOpen}
          onOpenChange={setRestoreOpen}
          forceReplace
          onRestored={(summary) => void handleRestored(summary)}
        />
      )}
    </div>
  )
}
