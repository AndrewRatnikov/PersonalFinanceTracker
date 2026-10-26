import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { getSyncRuntime } from '@/lib/sync/runtime'
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

interface DeleteCloudDataDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

// A vault error in words; a cloud or sync error by its code; anything else as
// errorMessage shows it.
function failureText(
  err: unknown,
  t: ReturnType<typeof useT>['t'],
): string {
  if (err instanceof Error && (err.name === 'CloudError' || err.name === 'SyncActionError')) {
    const code = (err as { code?: unknown }).code
    return t('sync.errors.actionFailed', { code: typeof code === 'string' ? code : 'unknown' })
  }
  return errorMessage(err)
}

// "Delete cloud data" (Settings → Sync → danger zone): confirmed with the
// encryption password. The data on every device is kept and sync turns off on
// this device; other devices see "cloud deleted" on their next sync.
export function DeleteCloudDataDialog({
  open,
  onOpenChange,
  onDeleted,
}: DeleteCloudDataDialogProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const { t } = useT()

  useEffect(() => {
    if (!open) {
      setPassword('')
      setError(null)
      setPending(false)
    }
  }, [open])

  const handleDelete = async () => {
    if (password === '' || pending) return
    setPending(true)
    setError(null)
    try {
      await getSyncRuntime().actions.deleteCloudData(password)
    } catch (err) {
      setError(failureText(err, t))
      setPending(false)
      return
    }
    setPending(false)
    toast.success(t('sync.toast.cloudDeleted'))
    onDeleted?.()
    onOpenChange(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="delete-cloud-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('sync.deleteCloud.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('sync.deleteCloud.body')}</AlertDialogDescription>
        </AlertDialogHeader>

        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            void handleDelete()
          }}
        >
          <Label htmlFor="delete-cloud-password">{t('sync.deleteCloud.passwordLabel')}</Label>
          <Input
            id="delete-cloud-password"
            data-testid="delete-cloud-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pending}
          />
        </form>

        {error && (
          <p data-testid="delete-cloud-error" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('sync.deleteCloud.cancel')}</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            data-testid="delete-cloud-confirm"
            disabled={password === '' || pending}
            onClick={() => void handleDelete()}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('sync.deleteCloud.confirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
