import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import type { CloudDevice } from '@/lib/cloud/types'
import { useT } from '@/i18n'
import { formatFullDate, formatTime } from '@/i18n/format'
import { MAX_DEVICE_LABEL_CHARS } from '@/lib/cloud/types'
import { getSyncRuntime } from '@/lib/sync/runtime'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const SYNC_DEVICES_QUERY_KEY = ['sync-devices'] as const

interface SyncDevicesListProps {
  thisDeviceId: string | null
}

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'unknown'
}

// The account's active devices (Settings → Sync): label, last seen, "This
// device", rename (every row) and remove (other devices, after a confirm).
export function SyncDevicesList({ thisDeviceId }: SyncDevicesListProps) {
  const queryClient = useQueryClient()
  const { t } = useT()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<CloudDevice | null>(null)

  const query = useQuery({
    queryKey: SYNC_DEVICES_QUERY_KEY,
    queryFn: () => getSyncRuntime().actions.listDevices(),
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['sync-devices'] })

  const handleSave = async (deviceId: string) => {
    const label = draft.trim().slice(0, MAX_DEVICE_LABEL_CHARS).trim()
    if (label === '' || saving) return
    setSaving(true)
    try {
      await getSyncRuntime().actions.renameDevice(deviceId, label)
      setEditingId(null)
      await refresh()
    } catch (err) {
      toast.error(t('sync.errors.actionFailed', { code: codeOf(err) }))
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (device: CloudDevice) => {
    try {
      await getSyncRuntime().actions.removeDevice(device.device_id)
      await refresh()
    } catch (err) {
      toast.error(t('sync.errors.actionFailed', { code: codeOf(err) }))
    }
  }

  if (query.isPending) {
    return (
      <p
        data-testid="sync-devices-loading"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('sync.devices.loading')}
      </p>
    )
  }

  if (query.isError) {
    return (
      <div data-testid="sync-devices-error" className="flex items-center gap-3 text-sm">
        <span className="text-destructive">{t('sync.devices.error')}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
          {t('sync.devices.retry')}
        </Button>
      </div>
    )
  }

  const devices = query.data
    .filter((d) => d.removed_at === null)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))

  return (
    <div data-testid="sync-devices" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t('sync.devices.title')}</h3>
      <ul className="flex flex-col divide-y divide-border rounded-md border">
        {devices.map((device) => {
          const isThis = device.device_id === thisDeviceId
          const editing = editingId === device.device_id
          const when = `${formatFullDate(device.last_seen_at)}, ${formatTime(device.last_seen_at)}`
          return (
            <li
              key={device.device_id}
              data-testid="sync-device-row"
              data-device-id={device.device_id}
              className="flex flex-col gap-2 p-3"
            >
              {editing ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void handleSave(device.device_id)
                  }}
                >
                  <Input
                    data-testid="sync-device-rename-input"
                    aria-label={t('sync.devices.renameLabel')}
                    value={draft}
                    maxLength={MAX_DEVICE_LABEL_CHARS}
                    onChange={(e) => setDraft(e.target.value)}
                    disabled={saving}
                    autoFocus
                  />
                  <Button
                    type="submit"
                    size="sm"
                    data-testid="sync-device-rename-save"
                    disabled={saving || draft.trim() === ''}
                  >
                    {t('sync.devices.save')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    data-testid="sync-device-rename-cancel"
                    disabled={saving}
                    onClick={() => setEditingId(null)}
                  >
                    {t('sync.devices.cancel')}
                  </Button>
                </form>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-2">
                      <span data-testid="sync-device-label" className="truncate font-medium">
                        {device.label}
                      </span>
                      {isThis && (
                        <span
                          data-testid="sync-device-this"
                          className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                        >
                          {t('sync.devices.thisDevice')}
                        </span>
                      )}
                    </span>
                    <span
                      data-testid="sync-device-last-seen"
                      className="text-xs text-muted-foreground"
                    >
                      {t('sync.devices.lastSeen', { when })}
                    </span>
                  </div>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid="sync-device-rename-btn"
                      onClick={() => {
                        setDraft(device.label)
                        setEditingId(device.device_id)
                      }}
                    >
                      <Pencil className="mr-1 h-4 w-4" />
                      {t('sync.devices.rename')}
                    </Button>
                    {!isThis && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        data-testid="sync-device-remove-btn"
                        onClick={() => setRemoving(device)}
                      >
                        <Trash2 className="mr-1 h-4 w-4" />
                        {t('sync.devices.remove')}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
      >
        <AlertDialogContent data-testid="sync-device-remove-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sync.devices.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('sync.devices.removeBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('sync.devices.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="sync-device-remove-confirm"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (removing) void handleRemove(removing)
              }}
            >
              {t('sync.devices.removeConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
