// No CONTRACT_GAPs: queryClient and dataProblem are fully specified in the
// Interface Contract.

import { MutationObserver } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'

import { DecryptError } from '@/lib/dataErrors'
import {
  clearDataProblem,
  getDataProblem,
  reportDataProblem,
  subscribeDataProblem,
} from '@/lib/dataProblem'
import {
  createAppQueryClient,
  handleQueryError,
  shouldRetryQuery,
} from '@/lib/queryClient'

beforeEach(() => {
  clearDataProblem()
})

describe('shouldRetryQuery', () => {
  it('never retries a DecryptError', () => {
    expect(shouldRetryQuery(0, new DecryptError('income'))).toBe(false)
    expect(shouldRetryQuery(1, new DecryptError('income'))).toBe(false)
  })

  it('retries other errors until three failures', () => {
    expect(shouldRetryQuery(0, new Error('x'))).toBe(true)
    expect(shouldRetryQuery(2, new Error('x'))).toBe(true)
    expect(shouldRetryQuery(3, new Error('x'))).toBe(false)
  })
})

describe('handleQueryError', () => {
  it('reports a DecryptError as the data problem', () => {
    handleQueryError(new DecryptError('categories'))

    expect(getDataProblem()?.storageKey).toBe('categories')
  })

  it('ignores any other error', () => {
    handleQueryError(new Error('network'))
    handleQueryError('string error')
    handleQueryError(null)

    expect(getDataProblem()).toBeNull()
  })
})

describe('createAppQueryClient', () => {
  it('a query failing with DecryptError sets the data problem', async () => {
    const client = createAppQueryClient()

    await client
      .fetchQuery({
        queryKey: ['x'],
        queryFn: () => Promise.reject(new DecryptError('income')),
        retry: false,
      })
      .catch(() => {})

    expect(getDataProblem()?.storageKey).toBe('income')
  })

  it('a query failing with a plain Error leaves the data problem empty', async () => {
    const client = createAppQueryClient()

    await client
      .fetchQuery({
        queryKey: ['x'],
        queryFn: () => Promise.reject(new Error('boom')),
        retry: false,
      })
      .catch(() => {})

    expect(getDataProblem()).toBeNull()
  })

  it('a mutation failing with DecryptError sets the data problem', async () => {
    const client = createAppQueryClient()
    const observer = new MutationObserver(client, {
      mutationFn: () => Promise.reject(new DecryptError('expenses_2026_03')),
    })

    await observer.mutate().catch(() => {})

    expect(getDataProblem()?.storageKey).toBe('expenses_2026_03')
  })

  it('a mutation failing with a plain Error leaves the data problem empty', async () => {
    const client = createAppQueryClient()
    const observer = new MutationObserver(client, {
      mutationFn: () => Promise.reject(new Error('boom')),
    })

    await observer.mutate().catch(() => {})

    expect(getDataProblem()).toBeNull()
  })

  it('returns an independent client each call', () => {
    expect(createAppQueryClient()).not.toBe(createAppQueryClient())
  })
})

describe('dataProblem store', () => {
  it('keeps the first problem until cleared', () => {
    const first = new DecryptError('income')
    reportDataProblem(first)
    reportDataProblem(new DecryptError('budgets'))

    expect(getDataProblem()?.storageKey).toBe('income')
    expect(getDataProblem()?.error).toBe(first)

    clearDataProblem()
    expect(getDataProblem()).toBeNull()

    reportDataProblem(new DecryptError('budgets'))
    expect(getDataProblem()?.storageKey).toBe('budgets')
  })

  it('notifies subscribers on report and on clear, until unsubscribed', () => {
    let calls = 0
    const unsubscribe = subscribeDataProblem(() => {
      calls++
    })

    reportDataProblem(new DecryptError('income'))
    expect(calls).toBe(1)

    clearDataProblem()
    expect(calls).toBe(2)

    unsubscribe()
    reportDataProblem(new DecryptError('income'))
    expect(calls).toBe(2)
  })
})
