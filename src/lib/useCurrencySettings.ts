import { useQuery } from '@tanstack/react-query'

import {
  CURRENCY_SETTINGS_QUERY_KEY,
  getCurrencySettings,
} from './appSettings'

// The main currency and the exchange-rate switch. Callers fall back to
// DEFAULT_MAIN_CURRENCY while loading: `data?.mainCurrency ?? DEFAULT_MAIN_CURRENCY`.
export function useCurrencySettings() {
  return useQuery({
    queryKey: CURRENCY_SETTINGS_QUERY_KEY,
    queryFn: getCurrencySettings,
  })
}
