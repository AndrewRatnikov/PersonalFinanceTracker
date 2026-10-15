// The single swap point for exchange rates. Everything else imports
// `rateProvider` from here; to move the rate source (e.g. behind a server
// function if the browser can't reach the NBU), replace the provider below.

import { createNbuProvider } from './nbu'
import type { RateProvider } from './types'

export const rateProvider: RateProvider = createNbuProvider()

export { crossRate, RateUnavailableError } from './types'
export type { RateProvider, RateTable } from './types'
