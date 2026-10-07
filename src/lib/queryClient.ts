import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'

import { isDecryptError } from './dataErrors'
import { reportDataProblem } from './dataProblem'

// Any query or mutation that fails with a DecryptError switches the app to
// the Data problem screen. Other errors are left to the page.
export function handleQueryError(error: unknown): void {
  if (isDecryptError(error)) reportDataProblem(error)
}

// A DecryptError will not fix itself, so fail immediately instead of retrying.
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return !isDecryptError(error) && failureCount < 3
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: handleQueryError }),
    mutationCache: new MutationCache({ onError: handleQueryError }),
    defaultOptions: {
      queries: { networkMode: 'offlineFirst', retry: shouldRetryQuery },
      mutations: { networkMode: 'offlineFirst' },
    },
  })
}
