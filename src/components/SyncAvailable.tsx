import type { ReactNode } from 'react'

import { useAccountsVisible } from '@/lib/accountSession'
import { ENABLE_SYNC } from '@/lib/featureFlags'

interface SyncAvailableProps {
  children: ReactNode
  fallback?: ReactNode
}

function SyncAvailableInner({ children, fallback }: SyncAvailableProps) {
  const accountsVisible = useAccountsVisible()
  return <>{accountsVisible ? children : fallback}</>
}

// Renders its children only when sync is available (ENABLE_SYNC and visible
// accounts), else the fallback. With the flag off no hook runs, so the markup
// is exactly what it was before sync existed.
export function SyncAvailable({ children, fallback = null }: SyncAvailableProps) {
  if (!ENABLE_SYNC) return <>{fallback}</>
  return <SyncAvailableInner fallback={fallback}>{children}</SyncAvailableInner>
}
