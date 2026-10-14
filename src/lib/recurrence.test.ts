// No CONTRACT_GAPs: every function of src/lib/recurrence.ts is specified in the
// Interface Contract (module: recurrence). The TZ independence criterion is
// exercised by the plan's verify step, which runs this file under
// TZ=Pacific/Auckland and TZ=America/Los_Angeles; the DST-crossing ranges below
// are chosen so that a local-time implementation would shift a date in one of
// them. Expectations that need a local date are built with local-time Date
// constructors, so they hold in any timezone.

import { describe, expect, it } from 'vitest'

import type { RecurringItem } from '@/lib/domain'
import {
  addDaysToDate,
  describeFrequency,
  dueOccurrences,
  formatRecurringAmount,
  lastOccurrenceOnOrBefore,
  markOccurrenceHandled,
  monthlyEquivalent,
  monthlyTotals,
  nextOccurrence,
  nextUnhandledOccurrence,
  occurrenceCreatedAt,
  occurrencesBetween,
  recurringCreatedMessage,
  toLocalDateString,
  upcomingOccurrences,
} from '@/lib/recurrence'

function item(overrides: Partial<RecurringItem> = {}): RecurringItem {
  return {
    id: 'r1',
    kind: 'expense',
    amount: 100,
    currency: 'UAH',
    categoryId: 'c1',
    description: null,
    frequency: { unit: 'month', interval: 1 },
    startDate: '2026-01-15',
    end: { type: 'never' },
    mode: 'auto',
    paused: false,
    handledThrough: null,
    handledAhead: [],
    occurrenceCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function schedule(
  startDate: string,
  unit: RecurringItem['frequency']['unit'],
  interval = 1,
  end: RecurringItem['end'] = { type: 'never' },
) {
  return { startDate, frequency: { unit, interval }, end }
}

// Independent calendar arithmetic for the DST ranges.
function utcDay(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10)
}

describe('occurrencesBetween: monthly month-end clamping', () => {
  it('Jan 31 monthly gives Jan 31, Feb 28, Mar 31, Apr 30 in a non-leap year', () => {
    expect(
      occurrencesBetween(schedule('2027-01-31', 'month'), null, '2027-04-30'),
    ).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'])
  })

  it('gives Feb 29 in a leap year (2028)', () => {
    expect(
      occurrencesBetween(schedule('2028-01-31', 'month'), null, '2028-04-30'),
    ).toEqual(['2028-01-31', '2028-02-29', '2028-03-31', '2028-04-30'])
  })

  it('never drifts: after a clamped month the day returns to the start day', () => {
    const dates = occurrencesBetween(
      schedule('2027-01-31', 'month'),
      null,
      '2027-12-31',
    )
    expect(dates).toHaveLength(12)
    expect(dates[2]).toBe('2027-03-31')
    expect(dates[4]).toBe('2027-05-31')
    expect(dates[10]).toBe('2027-11-30')
    expect(dates[11]).toBe('2027-12-31')
  })

  it('a mid-month start is not clamped', () => {
    expect(
      occurrencesBetween(schedule('2026-01-15', 'month'), null, '2026-03-31'),
    ).toEqual(['2026-01-15', '2026-02-15', '2026-03-15'])
  })
})

describe('occurrencesBetween: yearly', () => {
  it('Feb 29 yearly from 2028 gives Feb 28 in non-leap years', () => {
    expect(
      occurrencesBetween(schedule('2028-02-29', 'year'), null, '2030-12-31'),
    ).toEqual(['2028-02-29', '2029-02-28', '2030-02-28'])
  })

  it('returns to Feb 29 in the next leap year', () => {
    const dates = occurrencesBetween(
      schedule('2028-02-29', 'year'),
      null,
      '2032-12-31',
    )
    expect(dates).toEqual([
      '2028-02-29',
      '2029-02-28',
      '2030-02-28',
      '2031-02-28',
      '2032-02-29',
    ])
  })

  it('every 2 years skips a year', () => {
    expect(
      occurrencesBetween(schedule('2026-03-01', 'year', 2), null, '2031-03-01'),
    ).toEqual(['2026-03-01', '2028-03-01', '2030-03-01'])
  })
})

describe('occurrencesBetween: intervals', () => {
  it('every 2 weeks', () => {
    expect(
      occurrencesBetween(schedule('2026-03-02', 'week', 2), null, '2026-04-13'),
    ).toEqual(['2026-03-02', '2026-03-16', '2026-03-30', '2026-04-13'])
  })

  it('every week differs from every 2 weeks over the same range', () => {
    expect(
      occurrencesBetween(schedule('2026-03-02', 'week', 1), null, '2026-03-23'),
    ).toEqual(['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23'])
  })

  it('every 3 days, across a month end', () => {
    expect(
      occurrencesBetween(schedule('2026-02-26', 'day', 3), null, '2026-03-04'),
    ).toEqual(['2026-02-26', '2026-03-01', '2026-03-04'])
  })

  it('every 2 months, with clamping', () => {
    expect(
      occurrencesBetween(schedule('2026-01-31', 'month', 2), null, '2026-07-31'),
    ).toEqual(['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31'])
    expect(
      occurrencesBetween(schedule('2026-12-30', 'month', 2), null, '2027-06-30'),
    ).toEqual(['2026-12-30', '2027-02-28', '2027-04-30', '2027-06-30'])
  })
})

describe('occurrencesBetween: bounds', () => {
  const monthly = schedule('2026-01-15', 'month')

  it('afterExclusive is excluded and throughInclusive is included', () => {
    expect(occurrencesBetween(monthly, '2026-02-15', '2026-05-15')).toEqual([
      '2026-03-15',
      '2026-04-15',
      '2026-05-15',
    ])
  })

  it('a null afterExclusive includes the start date', () => {
    expect(occurrencesBetween(monthly, null, '2026-01-15')).toEqual([
      '2026-01-15',
    ])
  })

  it('an afterExclusive between occurrences starts at the next one', () => {
    expect(occurrencesBetween(monthly, '2026-02-20', '2026-04-30')).toEqual([
      '2026-03-15',
      '2026-04-15',
    ])
  })

  it('returns nothing when through is before the start', () => {
    expect(occurrencesBetween(monthly, null, '2026-01-14')).toEqual([])
  })

  it('returns nothing when after is on or past through', () => {
    expect(occurrencesBetween(monthly, '2026-03-15', '2026-03-15')).toEqual([])
  })

  it('handles an old item without walking from the start: 26 years of daily, 5-day window', () => {
    const daily = schedule('2000-01-01', 'day')
    expect(occurrencesBetween(daily, '2026-05-01', '2026-05-05')).toEqual([
      '2026-05-02',
      '2026-05-03',
      '2026-05-04',
      '2026-05-05',
    ])
  })

  it('a monthly item that started years ago still lands on its day', () => {
    expect(
      occurrencesBetween(schedule('2015-03-10', 'month'), '2026-01-10', '2026-03-31'),
    ).toEqual(['2026-02-10', '2026-03-10'])
  })
})

describe('occurrencesBetween: end rules', () => {
  it('end.onDate is inclusive of an occurrence on that date', () => {
    expect(
      occurrencesBetween(
        schedule('2026-01-15', 'month', 1, { type: 'onDate', date: '2026-03-15' }),
        null,
        '2026-12-31',
      ),
    ).toEqual(['2026-01-15', '2026-02-15', '2026-03-15'])
  })

  it('end.onDate one day earlier excludes that occurrence', () => {
    expect(
      occurrencesBetween(
        schedule('2026-01-15', 'month', 1, { type: 'onDate', date: '2026-03-14' }),
        null,
        '2026-12-31',
      ),
    ).toEqual(['2026-01-15', '2026-02-15'])
  })

  it('end.afterCount stops after N occurrences in total', () => {
    expect(
      occurrencesBetween(
        schedule('2026-01-15', 'month', 1, { type: 'afterCount', count: 3 }),
        null,
        '2030-12-31',
      ),
    ).toEqual(['2026-01-15', '2026-02-15', '2026-03-15'])
    expect(
      occurrencesBetween(
        schedule('2026-01-15', 'month', 1, { type: 'afterCount', count: 1 }),
        null,
        '2030-12-31',
      ),
    ).toEqual(['2026-01-15'])
  })

  it('end.afterCount counts from the start date, not from afterExclusive', () => {
    expect(
      occurrencesBetween(
        schedule('2026-01-15', 'month', 1, { type: 'afterCount', count: 3 }),
        '2026-01-15',
        '2030-12-31',
      ),
    ).toEqual(['2026-02-15', '2026-03-15'])
  })
})

describe('occurrencesBetween: no timezone or DST drift', () => {
  it('daily over a DST-change window (NZ end, US start, EU start) is one calendar day apart', () => {
    const expected = Array.from({ length: 30 }, (_, i) => utcDay(2026, 3, 1 + i))
    expect(
      occurrencesBetween(schedule('2026-03-01', 'day'), null, '2026-03-30'),
    ).toEqual(expected)
  })

  it('daily over the NZ spring-forward and US fall-back windows', () => {
    const sept = Array.from({ length: 15 }, (_, i) => utcDay(2026, 9, 20 + i))
    expect(
      occurrencesBetween(schedule('2026-09-20', 'day'), null, '2026-10-04'),
    ).toEqual(sept)
    const nov = Array.from({ length: 6 }, (_, i) => utcDay(2026, 10, 29 + i))
    expect(
      occurrencesBetween(schedule('2026-10-29', 'day'), null, '2026-11-03'),
    ).toEqual(nov)
  })

  it('weekly across a DST change keeps the same weekday', () => {
    const dates = occurrencesBetween(
      schedule('2026-03-04', 'week'),
      null,
      '2026-04-15',
    )
    for (const d of dates) {
      const [y, m, day] = d.split('-').map(Number)
      expect(new Date(Date.UTC(y, m - 1, day)).getUTCDay()).toBe(3)
    }
    expect(dates).toHaveLength(7)
  })

  it('monthly on the 1st across DST changes stays on the 1st', () => {
    const dates = occurrencesBetween(
      schedule('2026-01-01', 'month'),
      null,
      '2026-12-31',
    )
    expect(dates).toHaveLength(12)
    for (const d of dates) expect(d.endsWith('-01')).toBe(true)
  })
})

describe('addDaysToDate', () => {
  it('adds days across a month end', () => {
    expect(addDaysToDate('2026-02-27', 2)).toBe('2026-03-01')
    expect(addDaysToDate('2026-01-30', 5)).toBe('2026-02-04')
  })

  it('subtracts days', () => {
    expect(addDaysToDate('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDaysToDate('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('knows leap years', () => {
    expect(addDaysToDate('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDaysToDate('2027-02-28', 1)).toBe('2027-03-01')
  })

  it('adding zero returns the same date', () => {
    expect(addDaysToDate('2026-06-15', 0)).toBe('2026-06-15')
  })
})

describe('toLocalDateString and occurrenceCreatedAt', () => {
  it('formats the local calendar date of a Date', () => {
    expect(toLocalDateString(new Date(2026, 2, 5, 23, 59))).toBe('2026-03-05')
    expect(toLocalDateString(new Date(2026, 11, 31, 0, 1))).toBe('2026-12-31')
  })

  it('occurrenceCreatedAt is local noon of the date, as an ISO string', () => {
    expect(occurrenceCreatedAt('2026-03-05')).toBe(
      new Date(2026, 2, 5, 12).toISOString(),
    )
    expect(occurrenceCreatedAt('2026-11-20')).toBe(
      new Date(2026, 10, 20, 12).toISOString(),
    )
    const parsed = new Date(occurrenceCreatedAt('2026-03-05'))
    expect(parsed.getHours()).toBe(12)
    expect(parsed.getDate()).toBe(5)
  })

  it('toLocalDateString of occurrenceCreatedAt round-trips the date', () => {
    expect(toLocalDateString(new Date(occurrenceCreatedAt('2026-07-31')))).toBe(
      '2026-07-31',
    )
    expect(toLocalDateString(new Date(occurrenceCreatedAt('2026-01-01')))).toBe(
      '2026-01-01',
    )
  })
})

describe('nextOccurrence', () => {
  it('a null afterExclusive gives the start date', () => {
    expect(nextOccurrence(schedule('2026-01-15', 'month'), null)).toBe(
      '2026-01-15',
    )
  })

  it('gives the occurrence after the given date', () => {
    expect(nextOccurrence(schedule('2026-01-15', 'month'), '2026-01-15')).toBe(
      '2026-02-15',
    )
    expect(nextOccurrence(schedule('2026-01-15', 'month'), '2026-02-20')).toBe(
      '2026-03-15',
    )
  })

  it('keeps clamping from the start day', () => {
    expect(nextOccurrence(schedule('2027-01-31', 'month'), '2027-02-28')).toBe(
      '2027-03-31',
    )
  })

  it('is null once the schedule has ended', () => {
    const afterCount = schedule('2026-01-15', 'month', 1, {
      type: 'afterCount',
      count: 2,
    })
    expect(nextOccurrence(afterCount, '2026-01-15')).toBe('2026-02-15')
    expect(nextOccurrence(afterCount, '2026-02-15')).toBeNull()
    const onDate = schedule('2026-01-15', 'month', 1, {
      type: 'onDate',
      date: '2026-02-20',
    })
    expect(nextOccurrence(onDate, '2026-02-15')).toBeNull()
  })
})

describe('lastOccurrenceOnOrBefore', () => {
  const clamped = schedule('2027-01-31', 'month')

  it('gives the latest occurrence not after the date', () => {
    expect(lastOccurrenceOnOrBefore(clamped, '2027-03-15')).toBe('2027-02-28')
    expect(lastOccurrenceOnOrBefore(clamped, '2027-03-31')).toBe('2027-03-31')
  })

  it('is null before the start date', () => {
    expect(lastOccurrenceOnOrBefore(clamped, '2027-01-30')).toBeNull()
  })

  it('an occurrence exactly on the date is returned', () => {
    expect(lastOccurrenceOnOrBefore(schedule('2026-01-15', 'month'), '2026-01-15')).toBe(
      '2026-01-15',
    )
  })

  it('respects the end of the schedule', () => {
    const ended = schedule('2026-01-15', 'month', 1, {
      type: 'afterCount',
      count: 2,
    })
    expect(lastOccurrenceOnOrBefore(ended, '2030-01-01')).toBe('2026-02-15')
  })
})

describe('nextUnhandledOccurrence', () => {
  it('is the start date when nothing is handled', () => {
    expect(nextUnhandledOccurrence(item({ handledThrough: null }))).toBe(
      '2026-01-15',
    )
  })

  it('is the occurrence after handledThrough', () => {
    expect(
      nextUnhandledOccurrence(item({ handledThrough: '2026-01-15' })),
    ).toBe('2026-02-15')
    expect(
      nextUnhandledOccurrence(item({ handledThrough: '2026-03-15' })),
    ).toBe('2026-04-15')
  })

  it('skips dates already in handledAhead', () => {
    expect(
      nextUnhandledOccurrence(
        item({
          handledThrough: '2026-01-15',
          handledAhead: ['2026-02-15', '2026-03-15'],
        }),
      ),
    ).toBe('2026-04-15')
  })

  it('is null when the schedule has ended', () => {
    expect(
      nextUnhandledOccurrence(
        item({
          end: { type: 'afterCount', count: 2 },
          handledThrough: '2026-02-15',
        }),
      ),
    ).toBeNull()
  })
})

describe('markOccurrenceHandled', () => {
  it('handling the next occurrence advances handledThrough and counts it', () => {
    const before = item({ handledThrough: '2026-01-15', occurrenceCount: 1 })

    const after = markOccurrenceHandled(before, '2026-02-15')

    expect(after.handledThrough).toBe('2026-02-15')
    expect(after.handledAhead).toEqual([])
    expect(after.occurrenceCount).toBe(2)
  })

  it('handling the first occurrence from null works', () => {
    const after = markOccurrenceHandled(item(), '2026-01-15')

    expect(after.handledThrough).toBe('2026-01-15')
    expect(after.occurrenceCount).toBe(1)
  })

  it('handling a later date first goes into handledAhead, sorted and unique', () => {
    let current = item({ handledThrough: null })

    current = markOccurrenceHandled(current, '2026-03-15')
    expect(current.handledThrough).toBeNull()
    expect(current.handledAhead).toEqual(['2026-03-15'])
    expect(current.occurrenceCount).toBe(1)

    current = markOccurrenceHandled(current, '2026-02-15')
    expect(current.handledThrough).toBeNull()
    expect(current.handledAhead).toEqual(['2026-02-15', '2026-03-15'])
    expect(current.occurrenceCount).toBe(2)
  })

  it('handling the oldest date after a later one advances past both and prunes handledAhead', () => {
    const skippedLater = markOccurrenceHandled(item(), '2026-02-15')
    expect(skippedLater.handledAhead).toEqual(['2026-02-15'])

    const after = markOccurrenceHandled(skippedLater, '2026-01-15')

    expect(after.handledThrough).toBe('2026-02-15')
    expect(after.handledAhead).toEqual([])
    expect(after.occurrenceCount).toBe(2)
  })

  it('keeps handledAhead entries that are still beyond a gap', () => {
    let current = item()
    current = markOccurrenceHandled(current, '2026-03-15')
    current = markOccurrenceHandled(current, '2026-05-15')

    current = markOccurrenceHandled(current, '2026-01-15')

    // Feb 15 is still unhandled, so handledThrough stops at Jan 15.
    expect(current.handledThrough).toBe('2026-01-15')
    expect(current.handledAhead).toEqual(['2026-03-15', '2026-05-15'])
    expect(nextUnhandledOccurrence(current)).toBe('2026-02-15')
  })

  it('is pure: the input is not mutated and updatedAt is not changed', () => {
    const before = item({ handledThrough: '2026-01-15', handledAhead: [] })
    const snapshot = JSON.parse(JSON.stringify(before)) as RecurringItem

    const after = markOccurrenceHandled(before, '2026-03-15')

    expect(before).toEqual(snapshot)
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(after).not.toBe(before)
  })
})

describe('dueOccurrences', () => {
  it('lists unhandled occurrences up to today, for ask-mode items only', () => {
    const ask = item({ id: 'ask', mode: 'ask', startDate: '2026-01-15' })
    const auto = item({ id: 'auto', mode: 'auto' })

    const due = dueOccurrences([ask, auto], '2026-03-20')

    expect(due.map((d) => d.occurrenceDate)).toEqual([
      '2026-01-15',
      '2026-02-15',
      '2026-03-15',
    ])
    expect(due.every((d) => d.item.id === 'ask')).toBe(true)
  })

  it('excludes paused items', () => {
    const paused = item({ mode: 'ask', paused: true })

    expect(dueOccurrences([paused], '2026-03-20')).toEqual([])
  })

  it('starts after handledThrough and skips handledAhead dates', () => {
    const ask = item({
      mode: 'ask',
      handledThrough: '2026-01-15',
      handledAhead: ['2026-03-15'],
    })

    expect(
      dueOccurrences([ask], '2026-04-20').map((d) => d.occurrenceDate),
    ).toEqual(['2026-02-15', '2026-04-15'])
  })

  it('includes today and excludes tomorrow', () => {
    const ask = item({ mode: 'ask', startDate: '2026-03-15' })

    expect(dueOccurrences([ask], '2026-03-15')).toHaveLength(1)
    expect(dueOccurrences([ask], '2026-03-14')).toHaveLength(0)
  })

  it('sorts across items by date', () => {
    const a = item({ id: 'a', mode: 'ask', startDate: '2026-03-10' })
    const b = item({ id: 'b', mode: 'ask', startDate: '2026-03-05' })

    const due = dueOccurrences([a, b], '2026-03-20')

    expect(due.map((d) => [d.item.id, d.occurrenceDate])).toEqual([
      ['b', '2026-03-05'],
      ['a', '2026-03-10'],
    ])
  })
})

describe('upcomingOccurrences', () => {
  const today = '2026-03-10'

  it('lists occurrences in (today, today+7], excluding today and day 8', () => {
    const onToday = item({ id: 'today', startDate: '2026-03-10' })
    const day7 = item({ id: 'day7', startDate: '2026-03-17' })
    const day8 = item({ id: 'day8', startDate: '2026-03-18' })
    const day1 = item({ id: 'day1', startDate: '2026-03-11' })

    const upcoming = upcomingOccurrences([onToday, day7, day8, day1], today)

    expect(upcoming.map((u) => u.item.id).sort()).toEqual(['day1', 'day7'])
    expect(
      upcoming.map((u) => u.occurrenceDate).sort(),
    ).toEqual(['2026-03-11', '2026-03-17'])
  })

  it('excludes paused items and includes auto and ask items', () => {
    const auto = item({ id: 'auto', mode: 'auto', startDate: '2026-03-12' })
    const ask = item({ id: 'ask', mode: 'ask', startDate: '2026-03-13' })
    const paused = item({ id: 'paused', paused: true, startDate: '2026-03-14' })

    const ids = upcomingOccurrences([auto, ask, paused], today)
      .map((u) => u.item.id)
      .sort()

    expect(ids).toEqual(['ask', 'auto'])
  })

  it('does not list an item that has ended', () => {
    const ended = item({
      startDate: '2026-03-12',
      end: { type: 'onDate', date: '2026-03-11' },
    })

    expect(upcomingOccurrences([ended], today)).toEqual([])
  })

  it('caps the result at 5 by default and honours the limit option', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      item({ id: `m${i}`, startDate: `2026-03-${String(11 + (i % 6)).padStart(2, '0')}` }),
    )

    expect(upcomingOccurrences(many, today)).toHaveLength(5)
    expect(upcomingOccurrences(many, today, { limit: 2 })).toHaveLength(2)
    expect(upcomingOccurrences(many, today, { limit: 7 })).toHaveLength(7)
  })

  it('honours the days option', () => {
    const day10 = item({ startDate: '2026-03-20' })

    expect(upcomingOccurrences([day10], today)).toHaveLength(0)
    expect(upcomingOccurrences([day10], today, { days: 10 })).toHaveLength(1)
  })
})

describe('monthlyEquivalent', () => {
  it('weekly 100 is 433.33', () => {
    expect(
      monthlyEquivalent({ amount: 100, frequency: { unit: 'week', interval: 1 } }),
    ).toBe(433.33)
  })

  it('yearly 1200 is 100', () => {
    expect(
      monthlyEquivalent({ amount: 1200, frequency: { unit: 'year', interval: 1 } }),
    ).toBe(100)
  })

  it('every 2 months 300 is 150', () => {
    expect(
      monthlyEquivalent({ amount: 300, frequency: { unit: 'month', interval: 2 } }),
    ).toBe(150)
  })

  it('monthly is the amount itself', () => {
    expect(
      monthlyEquivalent({ amount: 99.99, frequency: { unit: 'month', interval: 1 } }),
    ).toBe(99.99)
  })

  it('daily is x365/12, rounded to 2 decimals', () => {
    expect(
      monthlyEquivalent({ amount: 10, frequency: { unit: 'day', interval: 1 } }),
    ).toBe(304.17)
    expect(
      monthlyEquivalent({ amount: 10, frequency: { unit: 'day', interval: 2 } }),
    ).toBe(152.08)
  })

  it('applies the interval to week and year too', () => {
    expect(
      monthlyEquivalent({ amount: 100, frequency: { unit: 'week', interval: 2 } }),
    ).toBe(216.67)
    expect(
      monthlyEquivalent({ amount: 2400, frequency: { unit: 'year', interval: 2 } }),
    ).toBe(100)
  })
})

describe('monthlyTotals', () => {
  const today = '2026-06-01'

  it('sums per kind and currency, expenses first, then income, currencies in UAH/USD/EUR order', () => {
    const items = [
      item({
        id: 'e1',
        amount: 100,
        frequency: { unit: 'week', interval: 1 },
      }),
      item({ id: 'e2', amount: 50 }),
      item({ id: 'e3', amount: 1200, currency: 'USD', frequency: { unit: 'year', interval: 1 } }),
      item({ id: 'i1', kind: 'income', amount: 2000, currency: 'EUR' }),
      item({ id: 'i2', kind: 'income', amount: 10 }),
    ]

    expect(monthlyTotals(items, today)).toEqual([
      { kind: 'expense', currency: 'UAH', total: 483.33 },
      { kind: 'expense', currency: 'USD', total: 100 },
      { kind: 'income', currency: 'UAH', total: 10 },
      { kind: 'income', currency: 'EUR', total: 2000 },
    ])
  })

  it('never mixes currencies: a UAH and a USD item stay separate lines', () => {
    const totals = monthlyTotals(
      [item({ id: 'a', amount: 100 }), item({ id: 'b', amount: 100, currency: 'USD' })],
      today,
    )

    expect(totals).toHaveLength(2)
    expect(totals.map((t) => t.currency)).toEqual(['UAH', 'USD'])
  })

  it('skips paused items', () => {
    expect(
      monthlyTotals([item({ id: 'a', amount: 100, paused: true })], today),
    ).toEqual([])
    expect(
      monthlyTotals(
        [item({ id: 'a', amount: 100 }), item({ id: 'b', amount: 40, paused: true })],
        today,
      ),
    ).toEqual([{ kind: 'expense', currency: 'UAH', total: 100 }])
  })

  it('skips items that have no occurrence on or after today (ended)', () => {
    const endedOnDate = item({
      id: 'ended',
      amount: 70,
      end: { type: 'onDate', date: '2026-05-31' },
    })
    const endsToday = item({
      id: 'today',
      amount: 30,
      startDate: '2026-05-01',
      end: { type: 'onDate', date: '2026-06-01' },
    })
    const endedCount = item({
      id: 'count',
      amount: 20,
      end: { type: 'afterCount', count: 2 },
    })

    expect(monthlyTotals([endedOnDate, endedCount], today)).toEqual([])
    // An occurrence exactly on `today` still counts.
    expect(monthlyTotals([endsToday], today)).toEqual([
      { kind: 'expense', currency: 'UAH', total: 30 },
    ])
  })

  it('returns an empty list for no items', () => {
    expect(monthlyTotals([], today)).toEqual([])
  })
})

describe('describeFrequency', () => {
  it('days', () => {
    expect(describeFrequency(item({ frequency: { unit: 'day', interval: 1 } }))).toBe(
      'Every day',
    )
    expect(describeFrequency(item({ frequency: { unit: 'day', interval: 3 } }))).toBe(
      'Every 3 days',
    )
  })

  it('weeks', () => {
    expect(describeFrequency(item({ frequency: { unit: 'week', interval: 1 } }))).toBe(
      'Every week',
    )
    expect(describeFrequency(item({ frequency: { unit: 'week', interval: 2 } }))).toBe(
      'Every 2 weeks',
    )
  })

  it('months name the start day', () => {
    expect(
      describeFrequency({
        frequency: { unit: 'month', interval: 1 },
        startDate: '2026-01-31',
      }),
    ).toBe('Every month on the 31st')
    expect(
      describeFrequency({
        frequency: { unit: 'month', interval: 2 },
        startDate: '2026-03-01',
      }),
    ).toBe('Every 2 months on the 1st')
  })

  it('years name the start month and day', () => {
    expect(
      describeFrequency({
        frequency: { unit: 'year', interval: 1 },
        startDate: '2026-03-01',
      }),
    ).toBe('Every year on Mar 1')
    expect(
      describeFrequency({
        frequency: { unit: 'year', interval: 2 },
        startDate: '2028-02-29',
      }),
    ).toBe('Every 2 years on Feb 29')
  })

  it.each([
    ['2026-01-02', '2nd'],
    ['2026-01-03', '3rd'],
    ['2026-01-04', '4th'],
    ['2026-01-11', '11th'],
    ['2026-01-12', '12th'],
    ['2026-01-13', '13th'],
    ['2026-01-21', '21st'],
    ['2026-01-22', '22nd'],
    ['2026-01-23', '23rd'],
    ['2026-01-30', '30th'],
  ])('uses the right ordinal for %s', (startDate, ordinal) => {
    expect(
      describeFrequency({ frequency: { unit: 'month', interval: 1 }, startDate }),
    ).toBe(`Every month on the ${ordinal}`)
  })
})

describe('formatRecurringAmount', () => {
  it('is the locale-formatted amount (max 2 decimals) and the currency code', () => {
    const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })

    expect(formatRecurringAmount(1234.5, 'UAH')).toBe(`${fmt(1234.5)} UAH`)
    expect(formatRecurringAmount(9.99, 'USD')).toBe(`${fmt(9.99)} USD`)
    expect(formatRecurringAmount(1234.567, 'EUR')).toBe(`${fmt(1234.567)} EUR`)
  })

  it('different amounts and currencies give different strings', () => {
    expect(formatRecurringAmount(10, 'UAH')).not.toBe(formatRecurringAmount(20, 'UAH'))
    expect(formatRecurringAmount(10, 'UAH')).not.toBe(formatRecurringAmount(10, 'USD'))
  })
})

describe('recurringCreatedMessage', () => {
  it('is singular for 1', () => {
    expect(recurringCreatedMessage(1)).toBe('Added 1 recurring transaction')
  })

  it('is plural for other counts', () => {
    expect(recurringCreatedMessage(3)).toBe('Added 3 recurring transactions')
    expect(recurringCreatedMessage(12)).toBe('Added 12 recurring transactions')
  })
})
