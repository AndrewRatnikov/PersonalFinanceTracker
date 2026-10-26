import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import type { SyncStatusCode } from '@/lib/sync/types'
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
      } else {
        const previous = lastStatus.current
        lastStatus.current = event.state.status
        if (previous === 'syncing' && event.state.status === 'synced') {
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
