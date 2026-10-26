import { Link } from '@tanstack/react-router'
import { CloudAlert, CloudCheck, CloudOff, RefreshCw } from 'lucide-react'

import type { SyncStatusCode } from '@/lib/sync/types'
import { useT } from '@/i18n'
import { ENABLE_SYNC } from '@/lib/featureFlags'
import { useSyncAvailable, useSyncState } from '@/lib/sync/react'

type IndicatorValue = 'synced' | 'syncing' | 'offline' | 'problem'

function indicatorFor(status: SyncStatusCode): IndicatorValue {
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
  const { t } = useT()
  if (!available || state.status === 'off') return null

  const value = indicatorFor(state.status)
  const label = t(`sync.indicator.${value}`)
  const Icon = ICONS[value]
  return (
    <Link
      to="/settings"
      search={{ tab: 'sync' }}
      data-testid="header-sync-indicator"
      data-sync-indicator={value}
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

// The header cloud icon: synced / syncing / offline / problem, linking to
// Settings → Sync. Only while sync is on for this device.
export function SyncIndicator() {
  return ENABLE_SYNC ? <SyncIndicatorInner /> : null
}
