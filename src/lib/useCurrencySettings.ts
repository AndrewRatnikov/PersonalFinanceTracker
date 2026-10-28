import { useQuery } from '@tanstack/react-query'

import {
  CURRENCY_SETTINGS_QUERY_KEY,
  getCurrencySettings,
} from './appSettings'
import { useActiveSpace } from './spaces/react'
import { spaceArgs } from './spaces/spaceDb'

// The main currency and the exchange-rate switch of the active space. Callers
// fall back to DEFAULT_MAIN_CURRENCY while loading:
// `data?.mainCurrency ?? DEFAULT_MAIN_CURRENCY`. The key is
// ['settings', 'currency', spaceId] (still under the ['settings'] prefix).
export function useCurrencySettings() {
  const spaceId = useActiveSpace()
  return useQuery({
    queryKey: [...CURRENCY_SETTINGS_QUERY_KEY, spaceId],
    queryFn: () => getCurrencySettings(...spaceArgs(spaceId)),
  })
}
