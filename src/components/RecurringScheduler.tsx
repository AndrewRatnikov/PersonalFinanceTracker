import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { isDecryptError } from '@/lib/dataErrors'
import { reportDataProblem } from '@/lib/dataProblem'
import { processDueRecurring } from '@/lib/localDb'
import { recurringCreatedMessage, toLocalDateString } from '@/lib/recurrence'

const DEFAULT_CHECK_INTERVAL_MS = 60_000

const RECURRING_QUERY_KEYS = [
  ['recurring'],
  ['expenses'],
  ['income'],
  ['analytics'],
] as const

// Reruns recurring generation while the vault is unlocked: when the tab
// becomes visible again, and when the local date changes (checked every
// `checkIntervalMs`). It does not run on mount: unlocking already ran it
// (prepareUnlockedVault). Renders nothing.
export function RecurringScheduler({
  unlocked,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
}: {
  unlocked: boolean
  checkIntervalMs?: number
}): null {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!unlocked) return undefined
    let active = true

    const run = async () => {
      try {
        const { created, itemsTouched } = await processDueRecurring()
        if (!active) return
        if (created > 0) toast.success(recurringCreatedMessage(created))
        if (itemsTouched > 0) {
          for (const queryKey of RECURRING_QUERY_KEYS) {
            void queryClient.invalidateQueries({ queryKey: [...queryKey] })
          }
        }
      } catch (err) {
        if (isDecryptError(err)) reportDataProblem(err)
        else console.error('Could not create recurring transactions:', err)
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void run()
    }

    let lastDate = toLocalDateString()
    const timer = setInterval(() => {
      const today = toLocalDateString()
      if (today === lastDate) return
      lastDate = today
      void run()
    }, checkIntervalMs)

    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      active = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [unlocked, checkIntervalMs, queryClient])

  return null
}
