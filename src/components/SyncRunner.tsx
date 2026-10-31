import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import type { DecryptError } from '@/lib/dataErrors'
import type { FamilySyncStatus, SyncStatusCode } from '@/lib/sync/types'
import { t } from '@/i18n/core'
import { useAccountSession, useAccountsVisible } from '@/lib/accountSession'
import { isDecryptError } from '@/lib/dataErrors'
import { reportDataProblem } from '@/lib/dataProblem'
import { ENABLE_SYNC } from '@/lib/featureFlags'
import { getSyncRuntime } from '@/lib/sync/runtime'

interface SyncRunnerProps {
  unlocked: boolean
}

function SyncRunnerInner({ unlocked }: SyncRunnerProps) {
  const accountsVisible = useAccountsVisible()
  const session = useAccountSession()
  const queryClient = useQueryClient()
  const userId = session?.userId ?? null
  const lastStatus = useRef<SyncStatusCode | null>(null)

  // Runs the engine while unlocked and signed in. Sign-out and lock stop it;
  // local data and meta:sync stay, and the same user signing in resumes.
  useEffect(() => {
    if (!accountsVisible) return
    const { engine, setUserId } = getSyncRuntime()
    setUserId(userId)
    if (unlocked && userId !== null) {
      engine.start()
      return () => {
        engine.stop()
      }
    }
    engine.stop()
    return undefined
  }, [accountsVisible, unlocked, userId])

  // Engine events: the password-changed notice, data problems, and fresh
  // queries once a cycle has applied what it pulled.
  useEffect(() => {
    if (!accountsVisible) return
    return getSyncRuntime().engine.onEvent((event) => {
      if (event.type === 'header-adopted') {
        toast(t('sync.toast.passwordChanged'))
      } else if (event.type === 'data-problem') {
        if (isDecryptError(event.error)) reportDataProblem(event.error)
      } else if (event.type === 'state') {
        const previous = lastStatus.current
        lastStatus.current = event.state.status
        if (previous === 'syncing' && event.state.status === 'synced') {
          void queryClient.invalidateQueries()
        }
      }
    })
  }, [accountsVisible, queryClient])

  // Family events (only when the runtime has a Family stream): the joined and
  // join-request toasts, data problems, and fresh queries once a Family cycle
  // has settled.
  useEffect(() => {
    if (!accountsVisible) return
    const family = getSyncRuntime().family
    if (!family) return
    let lastFamilyStatus: FamilySyncStatus | null = null
    return family.onEvent((event) => {
      if (event.type === 'joined') {
        toast(t('family.toast.joined', { name: event.name }))
      } else if (event.type === 'join-request') {
        toast(t('family.toast.request', { email: event.email ?? '' }))
      } else if (event.type === 'data-problem') {
        // The Family stream emits data-problem for undecryptable data only.
        reportDataProblem(event.error as DecryptError)
      } else if (event.type === 'state') {
        const previous = lastFamilyStatus
        lastFamilyStatus = event.state.status
        if (previous === 'syncing' && event.state.status !== 'syncing') {
          void queryClient.invalidateQueries()
        }
      }
    })
  }, [accountsVisible, queryClient])

  return null
}

// Mounted once in __root.tsx. With ENABLE_SYNC off it renders nothing and
// touches no sync code.
export function SyncRunner({ unlocked }: SyncRunnerProps) {
  return ENABLE_SYNC ? <SyncRunnerInner unlocked={unlocked} /> : null
}
