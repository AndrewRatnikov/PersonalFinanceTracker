import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Cloud, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import type { CloudVault } from '@/lib/cloud/types'
import type { SyncState, SyncStatusCode, TurnOnResult } from '@/lib/sync/types'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { formatFullDate, formatNumber, formatTime } from '@/i18n/format'
import { useAccountSession } from '@/lib/accountSession'
import { hasFeature, useSyncStatus } from '@/lib/cloud/entitlements'
import { formatBytes } from '@/lib/storagePersistence'
import { useSyncState } from '@/lib/sync/react'
import { getSyncRuntime } from '@/lib/sync/runtime'
import { DeleteCloudDataDialog } from '@/components/settings/DeleteCloudDataDialog'
import { SyncDevicesList } from '@/components/settings/SyncDevicesList'
import { SyncLinkDialog } from '@/components/settings/SyncLinkDialog'
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
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

const STATE_KEY: Record<Exclude<SyncStatusCode, 'error'>, MessageKey> = {
  off: 'sync.state.off',
  syncing: 'sync.state.syncing',
  synced: 'sync.state.synced',
  offline: 'sync.state.offline',
  paused: 'sync.state.paused',
  'device-removed': 'sync.state.deviceRemoved',
  'cloud-deleted': 'sync.state.cloudDeleted',
  'vault-mismatch': 'sync.state.vaultMismatch',
  'other-account': 'sync.state.otherAccount',
}

// Statuses that offer "Sync now" (with "Turn off").
const SYNC_NOW_STATUSES: ReadonlySet<SyncStatusCode> = new Set<SyncStatusCode>([
  'synced',
  'syncing',
  'offline',
  'error',
  'paused',
])

type T = ReturnType<typeof useT>['t']

function statusLine(state: SyncState, t: T): string {
  if (state.status === 'error') {
    return state.errorCode === 'not_signed_in'
      ? t('sync.state.signedOut')
      : t('sync.state.error', { code: state.errorCode ?? 'unknown' })
  }
  return t(STATE_KEY[state.status])
}

// A vault error in words; any other failure as "Couldn't complete the action
// (code)" with the CloudError / SyncActionError code, else "unknown".
function actionErrorText(err: unknown, t: T): string {
  if (err instanceof Error && err.name === 'VaultError') return errorMessage(err)
  const code = (err as { code?: unknown } | null)?.code
  const known =
    err instanceof Error &&
    (err.name === 'CloudError' || err.name === 'SyncActionError') &&
    typeof code === 'string'
  return t('sync.errors.actionFailed', { code: known ? code : 'unknown' })
}

// Settings → Sync (spec §19). Rendered only when sync is available.
export function SyncTab() {
  const session = useAccountSession()
  const view = useSyncStatus()
  const state = useSyncState()
  const queryClient = useQueryClient()
  const { t, plural } = useT()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [linkCloud, setLinkCloud] = useState<CloudVault | null>(null)
  const [turnOffOpen, setTurnOffOpen] = useState(false)
  const [removeDevice, setRemoveDevice] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  if (!session) {
    return (
      <div data-testid="sync-tab" className="flex flex-col gap-6">
        <Card data-testid="sync-sign-in-card">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Cloud className="h-4 w-4 text-muted-foreground" />
              <CardTitle>{t('sync.signIn.title')}</CardTitle>
            </div>
            <CardDescription>{t('sync.signIn.body')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              to="/login"
              search={{ redirect: '/settings?tab=sync' }}
              data-testid="sync-sign-in-link"
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('settings.account.signInGoogle')}
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  const { actions } = getSyncRuntime()
  const syncOn = state.status !== 'off'
  const planReady = view.state === 'ready'
  const included = view.state === 'ready' && hasFeature(view.status, 'sync')

  const runTurnOn = async (run: () => Promise<TurnOnResult>) => {
    setBusy(true)
    setActionError(null)
    try {
      const result = await run()
      if (result.kind === 'needs-link') {
        setLinkCloud(result.cloud)
      } else {
        toast.success(t('sync.toast.turnedOn'))
        void queryClient.invalidateQueries()
      }
    } catch (err) {
      setActionError(actionErrorText(err, t))
    } finally {
      setBusy(false)
    }
  }

  const runSyncNow = async () => {
    setActionError(null)
    try {
      await actions.syncNow()
    } catch (err) {
      setActionError(actionErrorText(err, t))
    }
  }

  const runTurnOff = async () => {
    setBusy(true)
    setActionError(null)
    try {
      await actions.turnOff({ removeDevice })
      toast.success(t('sync.toast.turnedOff'))
    } catch (err) {
      setActionError(actionErrorText(err, t))
    } finally {
      setBusy(false)
      setRemoveDevice(false)
    }
  }

  const planMarker =
    view.state === 'loading' ? (
      <p
        data-testid="sync-plan-loading"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('sync.plan.checking')}
      </p>
    ) : view.state === 'offline' ? (
      <p data-testid="sync-plan-offline" className="text-sm text-muted-foreground">
        {t('sync.plan.offline')}
      </p>
    ) : view.state === 'error' ? (
      <div data-testid="sync-plan-error" className="flex items-center gap-3 text-sm">
        <span className="text-destructive">{t('sync.plan.error')}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="sync-plan-retry-btn"
          onClick={view.retry}
        >
          {t('sync.plan.retry')}
        </Button>
      </div>
    ) : null

  // The plan does not include sync and this device does not sync: only that.
  if (planReady && !included && !syncOn) {
    return (
      <div data-testid="sync-tab" className="flex flex-col gap-6">
        <Card>
          <CardContent className="pt-6">
            <p data-testid="sync-not-included" className="text-sm">
              {t('cloud.plan.notIncluded')}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const showStatusCard = syncOn || included
  const status = state.status
  const progress = status === 'syncing' ? state.progress : null
  const skippedCount =
    state.lastError?.code === 'undecryptable' ? (state.lastError.count ?? 0) : null

  const actionButtons = (() => {
    const turnOff = (
      <Button
        type="button"
        variant="outline"
        data-testid="sync-turn-off-btn"
        disabled={busy}
        onClick={() => setTurnOffOpen(true)}
      >
        {t('sync.turnOff.button')}
      </Button>
    )
    if (status === 'off') {
      return (
        <Button
          type="button"
          data-testid="sync-turn-on-btn"
          disabled={busy}
          onClick={() => void runTurnOn(() => actions.turnOn())}
        >
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('sync.turnOn')}
        </Button>
      )
    }
    if (SYNC_NOW_STATUSES.has(status)) {
      return (
        <>
          <Button
            type="button"
            data-testid="sync-now-btn"
            disabled={busy || status === 'syncing' || status === 'offline'}
            onClick={() => void runSyncNow()}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${status === 'syncing' ? 'animate-spin' : ''}`} />
            {t('sync.now')}
          </Button>
          {turnOff}
        </>
      )
    }
    if (status === 'cloud-deleted') {
      return (
        <>
          <Button
            type="button"
            data-testid="sync-upload-again-btn"
            disabled={busy}
            onClick={() => void runTurnOn(() => actions.uploadAgain())}
          >
            {t('sync.uploadAgain')}
          </Button>
          {turnOff}
        </>
      )
    }
    if (status === 'device-removed') {
      return (
        <>
          <Button
            type="button"
            data-testid="sync-reconnect-btn"
            disabled={busy}
            onClick={() => void runTurnOn(() => actions.turnOn())}
          >
            {t('sync.turnOn')}
          </Button>
          {turnOff}
        </>
      )
    }
    // other-account, vault-mismatch: turning off is the only way out.
    return turnOff
  })()

  return (
    <div data-testid="sync-tab" className="flex flex-col gap-6">
      {planMarker}

      {showStatusCard && (
        <Card data-testid="sync-status-card">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Cloud className="h-4 w-4 text-muted-foreground" />
              <CardTitle>{t('sync.title')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p data-testid="sync-status-line" className="text-sm font-medium">
              {statusLine(state, t)}
            </p>

            {progress && (
              <div data-testid="sync-progress" className="flex flex-col gap-1.5">
                <p className="text-xs text-muted-foreground">
                  {progress.phase === 'push'
                    ? t('sync.progress.upload', {
                        done: progress.done,
                        total: progress.total ?? progress.done,
                      })
                    : t('sync.progress.download', { done: progress.done })}
                </p>
                {progress.total !== null && progress.total > 0 && (
                  <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{
                        width: `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%`,
                      }}
                    />
                  </div>
                )}
              </div>
            )}

            {syncOn &&
              (state.lastSyncAt ? (
                <p data-testid="sync-last-synced" className="text-sm text-muted-foreground">
                  {t('sync.lastSynced', {
                    when: `${formatFullDate(state.lastSyncAt)}, ${formatTime(state.lastSyncAt)}`,
                  })}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{t('sync.neverSynced')}</p>
              ))}

            {skippedCount !== null && (
              <p
                data-testid="sync-skipped-note"
                className="flex items-center gap-2 text-sm text-destructive"
              >
                <TriangleAlert className="h-4 w-4 shrink-0" />
                {plural('sync.skipped', skippedCount)}
              </p>
            )}

            {syncOn && planReady && (
              <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                <p data-testid="sync-plan-line">
                  {view.status.granted_by === 'free_for_all'
                    ? t('sync.plan.beta')
                    : t('cloud.plan.included')}
                </p>
                {view.status.vault && (
                  <>
                    <p data-testid="sync-usage-records">
                      {t('sync.usage.records', {
                        used: formatNumber(view.status.vault.record_count),
                        limit: formatNumber(view.status.limits.max_records),
                      })}
                    </p>
                    <p data-testid="sync-usage-storage">
                      {t('sync.usage.storage', {
                        used: formatBytes(view.status.vault.total_bytes),
                        limit: formatBytes(view.status.limits.max_bytes),
                      })}
                    </p>
                  </>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2">{actionButtons}</div>

            {actionError && (
              <p data-testid="sync-action-error" className="text-sm text-destructive">
                {actionError}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {syncOn && status !== 'other-account' && (
        <SyncDevicesList thisDeviceId={state.deviceId} />
      )}

      {syncOn && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">{t('sync.deleteCloud.section')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="destructive"
              data-testid="sync-delete-cloud-btn"
              onClick={() => setDeleteOpen(true)}
            >
              {t('sync.deleteCloud.button')}
            </Button>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={turnOffOpen} onOpenChange={setTurnOffOpen}>
        <AlertDialogContent data-testid="sync-turn-off-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sync.turnOff.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('sync.turnOff.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <label htmlFor="sync-turn-off-remove-device" className="flex items-center gap-2 text-sm">
            <input
              id="sync-turn-off-remove-device"
              data-testid="sync-turn-off-remove-device"
              type="checkbox"
              className="h-4 w-4"
              checked={removeDevice}
              onChange={(e) => setRemoveDevice(e.target.checked)}
            />
            {t('sync.turnOff.alsoRemoveDevice')}
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('sync.turnOff.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="sync-turn-off-confirm"
              onClick={() => void runTurnOff()}
            >
              {t('sync.turnOff.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SyncLinkDialog
        open={linkCloud !== null}
        cloud={linkCloud}
        onOpenChange={(open) => {
          if (!open) setLinkCloud(null)
        }}
        onLinked={() => {
          setLinkCloud(null)
          toast.success(t('sync.toast.turnedOn'))
        }}
      />

      <DeleteCloudDataDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => void queryClient.invalidateQueries()}
      />
    </div>
  )
}
