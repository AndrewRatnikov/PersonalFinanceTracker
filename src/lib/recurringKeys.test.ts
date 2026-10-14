// No CONTRACT_GAPs: the `recurring` data key, its label and the sync mapping
// are specified in the Interface Contract (modules: dataErrors / syncChannel).

import { describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'

import type { SyncChannel } from '@/lib/syncChannel'
import { isDataStorageKey, storageKeyLabel } from '@/lib/dataErrors'
import { listenForChanges, queryKeysForStorageKeys } from '@/lib/syncChannel'

describe('the recurring storage key', () => {
  it('is a data storage key', () => {
    expect(isDataStorageKey('recurring')).toBe(true)
  })

  it('is labelled "Recurring"', () => {
    expect(storageKeyLabel('recurring')).toBe('Recurring')
  })

  it('is distinct from the other labels', () => {
    expect(storageKeyLabel('recurring')).not.toBe(storageKeyLabel('income'))
    expect(storageKeyLabel('recurring')).not.toBe(storageKeyLabel('categories'))
  })

  it('is not matched by look-alike keys', () => {
    expect(isDataStorageKey('recurring_old')).toBe(false)
    expect(
      isDataStorageKey('quarantine:recurring:2026-03-01T00:00:00.000Z'),
    ).toBe(false)
  })
})

describe('queryKeysForStorageKeys for recurring', () => {
  it('maps recurring to recurring, expenses, income and analytics', () => {
    expect(queryKeysForStorageKeys(['recurring'])).toEqual([
      ['recurring'],
      ['expenses'],
      ['income'],
      ['analytics'],
    ])
  })

  it('other keys do not invalidate the recurring query', () => {
    expect(queryKeysForStorageKeys(['income'])).not.toContainEqual(['recurring'])
    expect(queryKeysForStorageKeys(['categories'])).not.toContainEqual([
      'recurring',
    ])
    expect(queryKeysForStorageKeys(['expenses_2026_03'])).not.toContainEqual([
      'recurring',
    ])
  })
})

describe('a changed message for recurring', () => {
  it('invalidates [recurring], [expenses], [income] and [analytics]', () => {
    let listener: ((e: MessageEvent) => void) | undefined
    const channel = {
      postMessage: vi.fn<SyncChannel['postMessage']>(),
      addEventListener: vi.fn<SyncChannel['addEventListener']>((_t, l) => {
        listener = l
      }),
      removeEventListener: vi.fn<SyncChannel['removeEventListener']>(),
      close: vi.fn<SyncChannel['close']>(),
    }
    const queryClient = {
      invalidateQueries: vi.fn<QueryClient['invalidateQueries']>(),
    }
    listenForChanges(queryClient, channel)

    listener?.(
      new MessageEvent('message', { data: { type: 'changed', keys: ['recurring'] } }),
    )

    const invalidated = queryClient.invalidateQueries.mock.calls.map(
      (c) => c[0]?.queryKey,
    )
    expect(invalidated).toEqual(
      expect.arrayContaining([
        ['recurring'],
        ['expenses'],
        ['income'],
        ['analytics'],
      ]),
    )
    expect(invalidated).toHaveLength(4)
  })
})
