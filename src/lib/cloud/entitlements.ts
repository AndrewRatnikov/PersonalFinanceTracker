// The single client gate for cloud features. The server decides every
// permission (public.has_feature); the client only reads the result:
// - useSyncStatus(): the caller's plan status, fetched once per 5 minutes and
//   only while signed in and online, dropped on sign-out;
// - hasFeature(status, feature): reads plans.features, never a plan id;
// - <FeatureGate feature fallback>: renders its children only when allowed.
// Never call a sync function without going through this gate.

import { Fragment, createElement, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { createCloudApi, toCloudError } from './api'
import type { ReactElement, ReactNode } from 'react'
import type { CloudError } from './api'
import type { FeatureName, SyncStatus } from './types'
import { useAccountSession } from '@/lib/accountSession'
import { useOnlineStatus } from '@/lib/useOnlineStatus'

export const SYNC_STATUS_QUERY_KEY = ['sync-status'] as const

const SYNC_STATUS_STALE_MS = 5 * 60_000

export type SyncStatusView =
  | { state: 'signed-out' }
  | { state: 'offline' }
  | { state: 'loading' }
  | { state: 'error'; error: CloudError; retry: () => void }
  | { state: 'ready'; status: SyncStatus }

// The default rpc is lazy, so this builds no Supabase client at import.
const cloudApi = createCloudApi()

export function hasFeature(
  status: SyncStatus | null | undefined,
  feature: FeatureName,
): boolean {
  return status?.limits[feature] === true
}

export function useSyncStatus(): SyncStatusView {
  const session = useAccountSession()
  const online = useOnlineStatus()
  const queryClient = useQueryClient()
  // Loose checks: some callers' tests mock the session as undefined.
  const signedIn = session != null

  const query = useQuery({
    queryKey: SYNC_STATUS_QUERY_KEY,
    queryFn: () => cloudApi.getSyncStatus(),
    enabled: signedIn && online,
    staleTime: SYNC_STATUS_STALE_MS,
    retry: false,
  })

  // Every sign-out path refreshes ['account-session']; the next account must
  // never see this one's status.
  useEffect(() => {
    if (!signedIn)
      queryClient.removeQueries({ queryKey: SYNC_STATUS_QUERY_KEY })
  }, [signedIn, queryClient])

  if (!signedIn) return { state: 'signed-out' }
  if (!online) return { state: 'offline' }
  if (query.error) {
    const { refetch } = query
    return {
      state: 'error',
      // The api rejects only with CloudError, which is passed through as is.
      error: toCloudError(query.error),
      retry: () => void refetch(),
    }
  }
  if (query.data === undefined) return { state: 'loading' }
  return { state: 'ready', status: query.data }
}

export function FeatureGate({
  feature,
  fallback = null,
  children,
}: {
  feature: FeatureName
  fallback?: ReactNode
  children?: ReactNode
}): ReactElement {
  const view = useSyncStatus()
  const allowed = view.state === 'ready' && hasFeature(view.status, feature)
  return createElement(Fragment, null, allowed ? children : fallback)
}
