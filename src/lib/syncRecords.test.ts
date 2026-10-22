// No CONTRACT_GAPs: isLive, recordTimestamp, recordContent, mergeRecord and
// sameTimeWinner are fully specified in the Interface Contract (module:
// syncRecords). Pure functions: no mocks.

import { describe, expect, it } from 'vitest'

import type { MergeableRecord } from '@/lib/syncRecords'
import {
  isLive,
  mergeRecord,
  recordContent,
  recordTimestamp,
  sameTimeWinner,
} from '@/lib/syncRecords'

const T1 = '2026-03-01T10:00:00.000Z'
const T2 = '2026-03-02T10:00:00.000Z'
const T3 = '2026-03-03T10:00:00.000Z'

describe('isLive', () => {
  it('is true without a deletedAt', () => {
    expect(isLive({})).toBe(true)
    expect(isLive({ deletedAt: undefined })).toBe(true)
  })

  it('is true for a null or empty deletedAt', () => {
    expect(isLive({ deletedAt: null })).toBe(true)
    expect(isLive({ deletedAt: '' })).toBe(true)
  })

  it('is false once deletedAt is set', () => {
    expect(isLive({ deletedAt: T1 })).toBe(false)
    expect(isLive({ deletedAt: '2020-01-01T00:00:00.000Z' })).toBe(false)
  })
})

describe('recordTimestamp', () => {
  it('uses updatedAt when present', () => {
    expect(recordTimestamp({ updatedAt: T2 })).toBe(Date.parse(T2))
    expect(recordTimestamp({ updatedAt: T3 })).toBe(Date.parse(T3))
  })

  it('prefers updatedAt over createdAt', () => {
    expect(recordTimestamp({ updatedAt: T3, createdAt: T1 })).toBe(Date.parse(T3))
  })

  it('falls back to createdAt', () => {
    expect(recordTimestamp({ createdAt: T1 })).toBe(Date.parse(T1))
  })

  it('is 0 for nothing or an unparseable value', () => {
    expect(recordTimestamp({})).toBe(0)
    expect(recordTimestamp({ updatedAt: 'not a date' })).toBe(0)
  })
})

describe('recordContent', () => {
  it('is the same for two records that differ only in key order', () => {
    const a = { id: 'x', amount: 5, currency: 'UAH', updatedAt: T1 }
    const b = { updatedAt: T1, currency: 'UAH', id: 'x', amount: 5 }

    expect(recordContent(a)).toBe(recordContent(b))
  })

  it('sorts keys recursively', () => {
    const a = { id: 'x', frequency: { unit: 'month', interval: 1 } }
    const b = { frequency: { interval: 1, unit: 'month' }, id: 'x' }

    expect(recordContent(a)).toBe(recordContent(b))
    expect(recordContent({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('ignores the top-level rev, conversion and category', () => {
    const plain = { id: 'x', amount: 5 }
    const noisy = {
      id: 'x',
      amount: 5,
      rev: 42,
      conversion: { mainCurrency: 'UAH', rate: 1 },
      category: { id: 'c', name: 'Food' },
    }

    expect(recordContent(noisy)).toBe(recordContent(plain))
  })

  it('tells apart records with different content', () => {
    expect(recordContent({ id: 'x', amount: 5 })).not.toBe(
      recordContent({ id: 'x', amount: 6 }),
    )
    expect(recordContent({ id: 'x', deletedAt: T1 })).not.toBe(
      recordContent({ id: 'x' }),
    )
  })

  it('keeps the order of array items', () => {
    expect(recordContent({ id: 'x', handledAhead: ['a', 'b'] })).not.toBe(
      recordContent({ id: 'x', handledAhead: ['b', 'a'] }),
    )
  })
})

describe('mergeRecord', () => {
  const rec = (overrides: Record<string, unknown> = {}): MergeableRecord => ({
    id: 'r1',
    ...overrides,
  })

  it('takes the incoming record when there is no local one', () => {
    expect(mergeRecord(undefined, rec({ updatedAt: T1 }))).toBe('take-incoming')
    expect(mergeRecord(undefined, rec({ createdAt: T3 }))).toBe('take-incoming')
  })

  it('a newer incoming record wins', () => {
    expect(
      mergeRecord(rec({ updatedAt: T1 }), rec({ updatedAt: T2 })),
    ).toBe('take-incoming')
    expect(
      mergeRecord(rec({ updatedAt: T2 }), rec({ updatedAt: T3 })),
    ).toBe('take-incoming')
  })

  it('an older incoming record loses', () => {
    expect(
      mergeRecord(rec({ updatedAt: T2 }), rec({ updatedAt: T1 })),
    ).toBe('keep-local')
    expect(
      mergeRecord(rec({ updatedAt: T3 }), rec({ updatedAt: T2 })),
    ).toBe('keep-local')
  })

  it('a newer tombstone beats an older live record, and the reverse', () => {
    expect(
      mergeRecord(rec({ updatedAt: T1 }), rec({ updatedAt: T2, deletedAt: T2 })),
    ).toBe('take-incoming')
    expect(
      mergeRecord(rec({ updatedAt: T2, deletedAt: T2 }), rec({ updatedAt: T1 })),
    ).toBe('keep-local')
  })

  it('equal time and identical content keeps the local record', () => {
    const a = rec({ updatedAt: T2, amount: 5 })
    const b = rec({ updatedAt: T2, amount: 5 })

    expect(mergeRecord(a, b)).toBe('keep-local')
  })

  it('ignores rev, conversion, category and key order when comparing content', () => {
    const local = { id: 'r1', updatedAt: T2, amount: 5, rev: 7 }
    const incoming = {
      amount: 5,
      updatedAt: T2,
      id: 'r1',
      conversion: { rate: 1 },
      category: { id: 'c' },
    }

    expect(mergeRecord(local, incoming)).toBe('keep-local')
  })

  it('equal time and different content is a same-time conflict', () => {
    expect(
      mergeRecord(
        rec({ updatedAt: T2, amount: 5 }),
        rec({ updatedAt: T2, amount: 6 }),
      ),
    ).toBe('conflict-same-time')
    expect(
      mergeRecord(
        rec({ updatedAt: T1, name: 'a' }),
        rec({ updatedAt: T1, name: 'b' }),
      ),
    ).toBe('conflict-same-time')
  })

  it('a tombstone against a live record at the same time is a conflict', () => {
    expect(
      mergeRecord(
        rec({ updatedAt: T2 }),
        rec({ updatedAt: T2, deletedAt: T2 }),
      ),
    ).toBe('conflict-same-time')
  })

  it('falls back to createdAt when updatedAt is missing', () => {
    expect(
      mergeRecord(rec({ createdAt: T1 }), rec({ updatedAt: T2 })),
    ).toBe('take-incoming')
    expect(
      mergeRecord(rec({ createdAt: T3 }), rec({ updatedAt: T2 })),
    ).toBe('keep-local')
    expect(
      mergeRecord(rec({ createdAt: T2 }), rec({ createdAt: T2, note: 'x' })),
    ).toBe('conflict-same-time')
  })

  it('treats an unparseable timestamp as time 0', () => {
    expect(
      mergeRecord(rec({ updatedAt: 'garbage' }), rec({ updatedAt: T1 })),
    ).toBe('take-incoming')
    expect(
      mergeRecord(rec({ updatedAt: T1 }), rec({ updatedAt: 'garbage' })),
    ).toBe('keep-local')
  })
})

describe('sameTimeWinner', () => {
  it('the tombstone side wins, whichever side it is', () => {
    const live = { id: 'r1', updatedAt: T2, name: 'zzz' }
    const dead = { id: 'r1', updatedAt: T2, deletedAt: T2, name: 'aaa' }

    expect(sameTimeWinner(live, dead)).toBe('incoming')
    expect(sameTimeWinner(dead, live)).toBe('local')
  })

  it('without a tombstone the larger canonical JSON wins', () => {
    const small = { id: 'r1', updatedAt: T2, amount: 40 }
    const large = { id: 'r1', updatedAt: T2, amount: 50 }

    expect(sameTimeWinner(small, large)).toBe('incoming')
    expect(sameTimeWinner(large, small)).toBe('local')
  })

  it('compares with plain string order, not locale order', () => {
    // 'Z' (0x5A) sorts before 'a' (0x61) as a plain string; a locale compare
    // would put 'apple' first.
    const upper = { id: 'r1', updatedAt: T2, name: 'Zebra' }
    const lower = { id: 'r1', updatedAt: T2, name: 'apple' }

    expect(sameTimeWinner(upper, lower)).toBe('incoming')
    expect(sameTimeWinner(lower, upper)).toBe('local')
  })

  it('identical content is won by the local side', () => {
    const a = { id: 'r1', updatedAt: T2, amount: 5 }
    const b = { amount: 5, id: 'r1', updatedAt: T2, rev: 3 }

    expect(sameTimeWinner(a, b)).toBe('local')
  })

  it('two tombstones fall back to the larger content', () => {
    const a = { id: 'r1', updatedAt: T2, deletedAt: T2, name: 'a' }
    const b = { id: 'r1', updatedAt: T2, deletedAt: T2, name: 'b' }

    expect(sameTimeWinner(a, b)).toBe('incoming')
    expect(sameTimeWinner(b, a)).toBe('local')
  })

  it('an empty deletedAt is not a tombstone', () => {
    const live = { id: 'r1', updatedAt: T2, name: 'b' }
    const blank = { id: 'r1', updatedAt: T2, deletedAt: '', name: 'a' }

    // Neither is a tombstone, so the larger content decides: 'deletedAt' sorts
    // before 'id', so the blank record's JSON starts with "deletedAt" and is
    // the smaller one.
    expect(sameTimeWinner(live, blank)).toBe('local')
  })
})
