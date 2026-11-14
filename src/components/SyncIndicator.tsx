import { Link } from '@tanstack/react-router'
import { CloudAlert, CloudCheck, CloudOff, RefreshCw } from 'lucide-react'

import type { SyncStatusCode } from '@/lib/sync/types'
import { useT } from '@/i18n'
import { useAccountSignedOut } from '@/lib/accountSession'
import { ENABLE_SYNC } from '@/lib/featureFlags'
import { useSyncAvailable, useSyncState } from '@/lib/sync/react'

export type SyncIndicatorValue = 'synced' | 'syncing' | 'offline' | 'problem'

// One mapping for the header icon and the Settings → Sync item's dot.
export function syncIndicatorValue(status: SyncStatusCode): SyncIndicatorValue {
  if (status === 'synced' || status === 'syncing' || status === 'offline') {
    return status
  }
  return 'problem'
}

const ICONS = {
  synced: CloudCheck,
  syncing: RefreshCw,
  offline: CloudOff,
  problem: CloudAlert,
} as const

function SyncIndicatorInner() {
  const available = useSyncAvailable()
  const state = useSyncState()
  if (!available || state.status === 'off') return null
  return <ShownIndicator status={state.status} />
}

// Mounted only while the icon shows, so the session is not read otherwise.
function ShownIndicator({ status }: { status: SyncStatusCode }) {
  const signedOut = useAccountSignedOut()
  const { t } = useT()

  // Signed out: no cycle runs, so the stored status (often "synced") is stale.
  const value = signedOut ? 'problem' : syncIndicatorValue(status)
  const label = signedOut ? t('sync.indicator.signedOut') : t(`sync.indicator.${value}`)
  const Icon = ICONS[value]
  return (
    <Link
      to="/settings"
      search={{ tab: 'sync' }}
      data-testid="header-sync-indicator"
      data-sync-indicator={value}
      data-signed-out={signedOut ? 'true' : undefined}
      aria-label={label}
      title={label}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent ${
        value === 'problem' ? 'text-destructive' : 'text-muted-foreground'
      }`}
    >
      <Icon className={`h-5 w-5 ${value === 'syncing' ? 'animate-spin' : ''}`} />
    </Link>
  )
}

// The header cloud icon: synced / syncing / offline / problem (also while the
// account is signed out), linking to Settings → Sync. Only while sync is on
// for this device.
export function SyncIndicator() {
  return ENABLE_SYNC ? <SyncIndicatorInner /> : null
}
