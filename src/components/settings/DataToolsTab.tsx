import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DatabaseBackup, Download, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { BackupSettings } from '@/lib/backupReminder'
import type { ImportResult, ImportRowError } from '@/lib/localImport'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { downloadBackup } from '@/lib/backup'
import {
  BACKUP_REMINDER_OPTIONS,
  BACKUP_REMINDER_QUERY_KEY,
  BACKUP_SETTINGS_QUERY_KEY,
  DEFAULT_BACKUP_REMINDER_DAYS,
  getBackupSettings,
  updateBackupSettings,
} from '@/lib/backupReminder'
import { isDecryptError } from '@/lib/dataErrors'
import { reportDataProblem } from '@/lib/dataProblem'
import { exportAllLocalData } from '@/lib/localExport'
import { importLocalDataFile } from '@/lib/localImport'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import { RemoveDataDialog } from '@/components/RemoveDataDialog'
import { RestoreBackupDialog } from '@/components/RestoreBackupDialog'
import { StorageStatusCard } from '@/components/settings/StorageStatusCard'

interface FileImportResult {
  filename: string
  file: File
  type?: string
  result?: ImportResult
  error?: string
}

const ROW_ERROR_KEYS: Record<ImportRowError['code'], MessageKey> = {
  'missing-name': 'settings.data.rowErrors.missingName',
  'missing-source': 'settings.data.rowErrors.missingSource',
  'invalid-amount': 'settings.data.rowErrors.invalidAmount',
  'invalid-currency': 'settings.data.rowErrors.invalidCurrency',
  'unknown-category': 'settings.data.rowErrors.unknownCategory',
  'invalid-date': 'settings.data.rowErrors.invalidDate',
  'invalid-limit': 'settings.data.rowErrors.invalidLimit',
}

export function DataToolsTab() {
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { t, plural } = useT()

  const [backupPending, setBackupPending] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [exportPending, setExportPending] = useState(false)
  const [importPending, setImportPending] = useState(false)
  const [importResults, setImportResults] =
    useState<Array<FileImportResult> | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [removeDataOpen, setRemoveDataOpen] = useState(false)

  const { data: backupSettings } = useQuery({
    queryKey: BACKUP_SETTINGS_QUERY_KEY,
    queryFn: getBackupSettings,
  })
  const reminderDays =
    backupSettings?.backupReminderDays ?? DEFAULT_BACKUP_REMINDER_DAYS

  const invalidateBackupQueries = () => {
    void queryClient.invalidateQueries({ queryKey: BACKUP_REMINDER_QUERY_KEY })
    void queryClient.invalidateQueries({ queryKey: BACKUP_SETTINGS_QUERY_KEY })
  }

  const handleBackup = async () => {
    setBackupPending(true)
    try {
      const result = await downloadBackup()
      if (result.status === 'saved') {
        toast.success(t('toasts.backupSaved'))
        invalidateBackupQueries()
      }
    } catch (err) {
      if (isDecryptError(err)) reportDataProblem(err)
      toast.error(t('toasts.backupDownloadFailed', { error: errorMessage(err) }))
    } finally {
      setBackupPending(false)
    }
  }

  const handleReminderChange = async (value: string) => {
    const days = Number(value)
    queryClient.setQueryData<BackupSettings>(BACKUP_SETTINGS_QUERY_KEY, (old) =>
      old ? { ...old, backupReminderDays: days } : old,
    )
    try {
      await updateBackupSettings({ backupReminderDays: days })
    } catch (err) {
      console.error('Could not save the backup reminder setting:', err)
    } finally {
      invalidateBackupQueries()
    }
  }

  const handleExport = async () => {
    setExportPending(true)
    try {
      await exportAllLocalData()
    } catch (err) {
      console.error('Export failed:', err)
      toast.error(t('toasts.exportFailed', { error: errorMessage(err) }))
    } finally {
      setExportPending(false)
    }
  }

  const importOne = async (
    file: File,
    options?: { allowDuplicates: boolean; rows: Array<number> },
  ): Promise<FileImportResult> => {
    try {
      const { type, result } = options
        ? await importLocalDataFile(file, options)
        : await importLocalDataFile(file)
      return { filename: file.name, file, type, result }
    } catch (err) {
      return {
        filename: file.name,
        file,
        error: err instanceof Error ? errorMessage(err) : t('settings.data.importFailed'),
      }
    }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return

    setImportError(null)
    setImportResults(null)
    setImportPending(true)

    try {
      // Import in dependency order: categories first, then the rest.
      const categories = files.filter((f) =>
        f.name.toLowerCase().includes('categories'),
      )
      const rest = files.filter(
        (f) => !f.name.toLowerCase().includes('categories'),
      )

      const results: Array<FileImportResult> = []
      for (const file of [...categories, ...rest]) {
        results.push(await importOne(file))
      }

      setImportResults(results)
      const fileErrors = results
        .filter((r) => r.error !== undefined)
        .map((r) => `${r.filename}: ${r.error}`)
      if (fileErrors.length > 0) {
        setImportError(fileErrors.join('\n'))
      }
      void queryClient.invalidateQueries()
    } catch (err) {
      setImportError(err instanceof Error ? errorMessage(err) : t('settings.data.importFailed'))
    } finally {
      setImportPending(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // "Import them anyway": re-import only the rows reported as duplicates, so
  // the rows inserted on the first pass are not doubled.
  const handleImportAnyway = async () => {
    if (!importResults) return
    setImportPending(true)
    try {
      const next = [...importResults]
      for (let i = 0; i < next.length; i++) {
        const entry = next[i]
        if (!entry.result || entry.result.duplicates === 0) continue
        next[i] = await importOne(entry.file, {
          allowDuplicates: true,
          rows: entry.result.duplicateRows,
        })
      }
      setImportResults(next)
      void queryClient.invalidateQueries()
    } finally {
      setImportPending(false)
    }
  }

  const totalDuplicates = (importResults ?? []).reduce(
    (sum, r) => sum + (r.result?.duplicates ?? 0),
    0,
  )

  return (
    <div className="flex flex-col gap-6">
      {/* Backup (.minima) */}
      <Card
        data-testid="data-backup-card"
        className="bg-card/50 border-border backdrop-blur-sm"
      >
        <CardHeader>
          <CardTitle className="text-lg">{t('settings.data.backupTitle')}</CardTitle>
          <CardDescription>{t('settings.data.backupDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              data-testid="backup-download-btn"
              onClick={() => void handleBackup()}
              disabled={backupPending}
              className="flex items-center gap-2"
            >
              <DatabaseBackup size={16} />
              {backupPending ? t('settings.data.preparing') : t('settings.data.downloadBackup')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              data-testid="backup-restore-btn"
              onClick={() => setRestoreOpen(true)}
              className="flex items-center gap-2"
            >
              <Upload size={16} />
              {t('settings.data.restoreBackup')}
            </Button>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="backup-reminder-select">{t('settings.data.reminder')}</Label>
            <select
              id="backup-reminder-select"
              data-testid="backup-reminder-select"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm sm:max-w-xs"
              value={String(reminderDays)}
              onChange={(e) => void handleReminderChange(e.target.value)}
            >
              {BACKUP_REMINDER_OPTIONS.map((days) => (
                <option key={days} value={String(days)}>
                  {days === 0
                    ? t('settings.data.reminderOff')
                    : plural('settings.data.reminderEvery', days)}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {/* Export */}
      <Card className="bg-card/50 border-border backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-lg">{t('settings.data.exportTitle')}</CardTitle>
          <CardDescription>{t('settings.data.exportDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p
            data-testid="csv-export-label"
            className="text-xs text-muted-foreground"
          >
            {t('settings.data.csvLabel')}
          </p>
          <Button
            id="export-csv-btn"
            data-testid="csv-export-btn"
            onClick={() => void handleExport()}
            disabled={exportPending}
            variant="secondary"
            className="self-start flex items-center gap-2"
          >
            <Download size={16} />
            {exportPending ? t('settings.data.preparing') : t('settings.data.downloadCsv')}
          </Button>
        </CardContent>
      </Card>

      {/* Import */}
      <Card className="bg-card/50 border-border backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-lg">{t('settings.data.importTitle')}</CardTitle>
          <CardDescription>{t('settings.data.importDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <input
            ref={fileInputRef}
            id="import-csv-input"
            data-testid="csv-import-input"
            type="file"
            accept=".csv"
            multiple
            onChange={(e) => void handleFileChange(e)}
            className="hidden"
          />

          <Button
            id="import-csv-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={importPending}
            variant="secondary"
            className="self-start flex items-center gap-2"
          >
            <Upload size={16} />
            {importPending ? t('settings.data.importing') : t('settings.data.chooseFiles')}
          </Button>

          {importError && (
            <Alert variant="destructive" className="bg-destructive/10">
              <AlertDescription>{importError}</AlertDescription>
            </Alert>
          )}

          {importResults && (
            <Alert
              data-testid="import-results"
              className="bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400"
            >
              <AlertTitle className="text-sm font-medium mb-2">
                {t('settings.data.importComplete')}
              </AlertTitle>
              <AlertDescription>
                <ul className="flex flex-col gap-1.5">
                  {importResults.map(({ filename, result, error }, index) => (
                    <li key={`${index}-${filename}`}>
                      <span className="font-mono text-xs">{filename}</span>
                      {' — '}
                      {error ? (
                        <span className="text-destructive font-medium">
                          {error}
                        </span>
                      ) : (
                        <>
                          <span>
                            {t('settings.data.inserted', { count: result?.inserted ?? 0 })}
                            {result && result.skipped > 0
                              ? t('settings.data.skipped', { count: result.skipped })
                              : ''}
                            {result && result.duplicates > 0
                              ? t('settings.data.duplicates', { count: result.duplicates })
                              : ''}
                            {result?.createdCategories
                              ? plural(
                                  'settings.data.createdCategories',
                                  result.createdCategories,
                                )
                              : ''}
                          </span>
                          {result && result.rowErrors.length > 0 && (
                            <ul className="text-muted-foreground text-xs list-disc list-inside mt-1 space-y-0.5">
                              {result.rowErrors.map((rowError, i) => (
                                <li key={i}>
                                  {t(ROW_ERROR_KEYS[rowError.code], {
                                    row: rowError.row,
                                    value: rowError.value ?? '',
                                  })}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {totalDuplicates > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p
                data-testid="import-duplicates-notice"
                className="text-sm text-muted-foreground"
              >
                {plural('settings.data.duplicatesNotice', totalDuplicates)}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="import-anyway-btn"
                onClick={() => void handleImportAnyway()}
                disabled={importPending}
              >
                {t('settings.data.importAnyway')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <StorageStatusCard />

      {/* Danger Zone */}
      <Card
        data-testid="danger-zone-card"
        className="bg-destructive/5 border-destructive/30 backdrop-blur-sm"
      >
        <CardHeader>
          <CardTitle className="text-lg text-destructive">
            {t('settings.data.dangerZone')}
          </CardTitle>
          <CardDescription>{t('settings.data.dangerDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            data-testid="remove-data-btn"
            variant="destructive"
            onClick={() => setRemoveDataOpen(true)}
            className="flex items-center gap-2"
          >
            {t('settings.data.removeData')}
          </Button>
        </CardContent>
      </Card>

      <RestoreBackupDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        onRestored={() => void queryClient.invalidateQueries()}
      />

      <RemoveDataDialog
        open={removeDataOpen}
        onOpenChange={setRemoveDataOpen}
      />
    </div>
  )
}
