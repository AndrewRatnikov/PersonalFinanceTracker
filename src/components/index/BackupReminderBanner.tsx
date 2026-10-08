import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DatabaseBackup, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { downloadBackup } from '@/lib/backup'
import {
  BACKUP_REMINDER_QUERY_KEY,
  backupReminderText,
  getBackupReminderStatus,
  snoozeBackupReminder,
} from '@/lib/backupReminder'
import { isDecryptError } from '@/lib/dataErrors'
import { reportDataProblem } from '@/lib/dataProblem'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Dashboard backup reminder (spec §6.2): "Last backup: N days ago.
// [Back up now] [Later]". The rule lives in backupReminder.ts.
export function BackupReminderBanner() {
  const queryClient = useQueryClient()
  const [hidden, setHidden] = useState(false)
  const [pending, setPending] = useState(false)
  const { data } = useQuery({
    queryKey: BACKUP_REMINDER_QUERY_KEY,
    queryFn: () => getBackupReminderStatus(),
  })

  if (hidden || !data?.show) return null

  const handleBackup = async () => {
    setPending(true)
    try {
      const result = await downloadBackup()
      if (result.status === 'saved') {
        toast.success('Backup saved')
        await queryClient.invalidateQueries({
          queryKey: BACKUP_REMINDER_QUERY_KEY,
        })
      }
    } catch (err) {
      if (isDecryptError(err)) reportDataProblem(err)
      toast.error(`Could not download the backup: ${errorText(err)}`)
    } finally {
      setPending(false)
    }
  }

  const handleLater = async () => {
    setHidden(true)
    try {
      await snoozeBackupReminder()
    } catch (err) {
      console.error('Could not snooze the backup reminder:', err)
    }
    void queryClient.invalidateQueries({ queryKey: BACKUP_REMINDER_QUERY_KEY })
  }

  return (
    <Card data-testid="backup-reminder-banner" className="border-[#6366f1]/30">
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <DatabaseBackup className="h-4 w-4 shrink-0 text-[#6366f1]" />
          <p data-testid="backup-reminder-text" className="text-sm">
            {backupReminderText(data.daysSinceBackup)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            data-testid="backup-reminder-now"
            onClick={() => void handleBackup()}
            disabled={pending}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Back up now
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="backup-reminder-later"
            onClick={() => void handleLater()}
            disabled={pending}
          >
            Later
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
