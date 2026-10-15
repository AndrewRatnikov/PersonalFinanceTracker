import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { startAutoConversion, subscribeConversion } from '@/lib/conversion'

// Query keys whose data depends on stored conversions or the main currency.
const AFFECTED_QUERY_KEYS: ReadonlyArray<Array<string>> = [
  ['expenses'],
  ['income'],
  ['analytics'],
  ['budgets'],
  ['settings'],
  ['conversion-status'],
]

// Mounted once in __root.tsx: runs the background conversion of pending
// entries (on every entry write in this tab, after unlock and when the
// browser comes back online) and refreshes the queries after each batch.
// A run while the vault is locked returns immediately.
export function ConversionRunner(): null {
  const queryClient = useQueryClient()

  useEffect(() => {
    const stop = startAutoConversion()
    const unsubscribe = subscribeConversion(() => {
      for (const queryKey of AFFECTED_QUERY_KEYS) {
        void queryClient.invalidateQueries({ queryKey })
      }
    })
    return () => {
      unsubscribe()
      stop()
    }
  }, [queryClient])

  return null
}
