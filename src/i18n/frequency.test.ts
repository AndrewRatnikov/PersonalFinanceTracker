// No CONTRACT_GAPs: describeFrequencyEn / describeFrequencyUk / describeFrequency
// and the expected texts are specified in plan section 8 and PRD criterion 10.
// The English cases are the former describeFrequency tests of recurrence.test.ts
// and must stay byte-identical.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RecurringItem } from '@/lib/domain'
import { setLang } from '@/i18n/core'
import {
  describeFrequency,
  describeFrequencyEn,
  describeFrequencyUk,
} from '@/i18n/frequency'
import { describeFrequency as describeFrequencyFromRecurrence } from '@/lib/recurrence'

type Item = Pick<RecurringItem, 'frequency' | 'startDate'>

function item(
  unit: RecurringItem['frequency']['unit'],
  interval: number,
  startDate = '2026-01-15',
): Item {
  return { frequency: { unit, interval }, startDate }
}

beforeEach(() => {
  setLang('en', { persist: false })
})

afterEach(() => {
  setLang('en', { persist: false })
})

describe('describeFrequencyEn', () => {
  it('days and weeks', () => {
    expect(describeFrequencyEn(item('day', 1))).toBe('Every day')
    expect(describeFrequencyEn(item('day', 3))).toBe('Every 3 days')
    expect(describeFrequencyEn(item('week', 1))).toBe('Every week')
    expect(describeFrequencyEn(item('week', 2))).toBe('Every 2 weeks')
  })

  it('months name the start day', () => {
    expect(describeFrequencyEn(item('month', 1, '2026-01-31'))).toBe(
      'Every month on the 31st',
    )
    expect(describeFrequencyEn(item('month', 2, '2026-03-01'))).toBe(
      'Every 2 months on the 1st',
    )
  })

  it('years name the start month and day', () => {
    expect(describeFrequencyEn(item('year', 1, '2026-03-01'))).toBe(
      'Every year on Mar 1',
    )
    expect(describeFrequencyEn(item('year', 2, '2028-02-29'))).toBe(
      'Every 2 years on Feb 29',
    )
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
    expect(describeFrequencyEn(item('month', 1, startDate))).toBe(
      `Every month on the ${ordinal}`,
    )
  })
})

describe('describeFrequencyUk', () => {
  it('days', () => {
    expect(describeFrequencyUk(item('day', 1))).toBe('Щодня')
    expect(describeFrequencyUk(item('day', 3))).toBe('Кожні 3 дні')
    expect(describeFrequencyUk(item('day', 5))).toBe('Кожні 5 днів')
    expect(describeFrequencyUk(item('day', 11))).toBe('Кожні 11 днів')
    expect(describeFrequencyUk(item('day', 21))).toBe('Кожен 21 день')
    expect(describeFrequencyUk(item('day', 22))).toBe('Кожні 22 дні')
  })

  it('weeks', () => {
    expect(describeFrequencyUk(item('week', 1))).toBe('Щотижня')
    expect(describeFrequencyUk(item('week', 2))).toBe('Кожні 2 тижні')
    expect(describeFrequencyUk(item('week', 5))).toBe('Кожні 5 тижнів')
    expect(describeFrequencyUk(item('week', 21))).toBe('Кожен 21 тиждень')
  })

  it('months name the start day with the "-го" ending', () => {
    expect(describeFrequencyUk(item('month', 1, '2026-01-31'))).toBe('Щомісяця, 31-го')
    expect(describeFrequencyUk(item('month', 2, '2026-01-31'))).toBe(
      'Кожні 2 місяці, 31-го',
    )
    expect(describeFrequencyUk(item('month', 5, '2026-01-31'))).toBe(
      'Кожні 5 місяців, 31-го',
    )
    expect(describeFrequencyUk(item('month', 1, '2026-01-15'))).toBe('Щомісяця, 15-го')
  })

  it('years name the start day and the genitive month', () => {
    expect(describeFrequencyUk(item('year', 1, '2026-03-01'))).toBe(
      'Щороку, 1 березня',
    )
    expect(describeFrequencyUk(item('year', 2, '2026-03-01'))).toBe(
      'Кожні 2 роки, 1 березня',
    )
    expect(describeFrequencyUk(item('year', 5, '2026-03-01'))).toBe(
      'Кожні 5 років, 1 березня',
    )
    expect(describeFrequencyUk(item('year', 1, '2028-02-29'))).toBe(
      'Щороку, 29 лютого',
    )
  })

  it('differs from the English text', () => {
    expect(describeFrequencyUk(item('week', 2))).not.toBe(
      describeFrequencyEn(item('week', 2)),
    )
  })
})

describe('describeFrequency', () => {
  it('dispatches on the explicit language', () => {
    expect(describeFrequency(item('week', 2), 'en')).toBe('Every 2 weeks')
    expect(describeFrequency(item('week', 2), 'uk')).toBe('Кожні 2 тижні')
    expect(describeFrequency(item('day', 5), 'uk')).toBe('Кожні 5 днів')
    expect(describeFrequency(item('month', 1, '2026-01-31'), 'uk')).toBe(
      'Щомісяця, 31-го',
    )
  })

  it('uses the current language by default', () => {
    expect(describeFrequency(item('day', 1))).toBe('Every day')

    setLang('uk', { persist: false })
    expect(describeFrequency(item('day', 1))).toBe('Щодня')
  })

  it('an explicit language wins over the current one', () => {
    setLang('uk', { persist: false })

    expect(describeFrequency(item('day', 3), 'en')).toBe('Every 3 days')
  })

  it('lib/recurrence re-exports it', () => {
    expect(describeFrequencyFromRecurrence(item('week', 2), 'uk')).toBe('Кожні 2 тижні')
    expect(describeFrequencyFromRecurrence(item('week', 2), 'en')).toBe('Every 2 weeks')
  })
})
