// No CONTRACT_GAPs: every function of src/i18n/format.ts and the expected
// values are specified in plan section 7. Ukrainian group separators are
// matched with \s (ICU emits U+00A0 or U+202F depending on the build), never
// hard-coded.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setLang } from '@/i18n/core'
import {
  currencyLabel,
  formatAmount,
  formatDay,
  formatFullDate,
  formatMoney,
  formatMonth,
  formatNumber,
  formatRate,
  formatShortMoney,
  formatShortMonth,
  formatTime,
} from '@/i18n/format'
import { parseDraftAmount } from '@/lib/expenseDraft'
import * as money from '@/lib/money'

beforeEach(() => {
  setLang('en', { persist: false })
})

afterEach(() => {
  setLang('en', { persist: false })
})

describe('formatNumber', () => {
  it('follows the language and the options', () => {
    const options = { minimumFractionDigits: 1, maximumFractionDigits: 1 }

    expect(formatNumber(1234.56, options, 'en')).toBe('1,234.6')
    expect(formatNumber(1234.56, options, 'uk')).toMatch(/^1\s234,6$/u)
    expect(formatNumber(2.5, options, 'en')).toBe('2.5')
    expect(formatNumber(2.5, options, 'uk')).toBe('2,5')
  })
})

describe('formatAmount', () => {
  it('always shows 2 decimals, with the language separators', () => {
    expect(formatAmount(1234.5, 'en')).toBe('1,234.50')
    expect(formatAmount(1234.5, 'uk')).toMatch(/^1\s234,50$/u)
    expect(formatAmount(5, 'en')).toBe('5.00')
    expect(formatAmount(5, 'uk')).toBe('5,00')
    expect(formatAmount(5.5, 'uk')).not.toBe(formatAmount(5, 'uk'))
  })

  it('rounds for display only', () => {
    expect(formatAmount(33.333333, 'en')).toBe('33.33')
    expect(formatAmount(66.666666, 'en')).toBe('66.67')
    expect(formatAmount(33.333333, 'uk')).toBe('33,33')
  })

  it('formats negative numbers', () => {
    expect(formatAmount(-12.5, 'en')).toMatch(/^[-−]12\.50$/u)
    expect(formatAmount(-12.5, 'uk')).toMatch(/^[-−]12,50$/u)
  })

  it('uses the current language when none is passed', () => {
    expect(formatAmount(1.5)).toBe('1.50')

    setLang('uk', { persist: false })
    expect(formatAmount(1.5)).toBe('1,50')
  })

  it('an explicit language wins over the current one', () => {
    setLang('uk', { persist: false })

    expect(formatAmount(1.5, 'en')).toBe('1.50')
  })
})

describe('currencyLabel', () => {
  it('shows грн for the hryvnia in Ukrainian and codes everywhere else', () => {
    expect(currencyLabel('UAH', 'uk')).toBe('грн')
    expect(currencyLabel('USD', 'uk')).toBe('USD')
    expect(currencyLabel('EUR', 'uk')).toBe('EUR')
    expect(currencyLabel('UAH', 'en')).toBe('UAH')
    expect(currencyLabel('USD', 'en')).toBe('USD')
    expect(currencyLabel('EUR', 'en')).toBe('EUR')
  })
})

describe('formatMoney', () => {
  it('matches the acceptance examples', () => {
    expect(formatMoney(1234.5, 'UAH', 'uk')).toMatch(/^1\s234,50 грн$/u)
    expect(formatMoney(20, 'USD', 'uk')).toBe('20,00 USD')
    expect(formatMoney(1234.5, 'UAH', 'en')).toBe('1,234.50 UAH')
    expect(formatMoney(20, 'USD', 'en')).toBe('20.00 USD')
  })

  it('differs by currency, by value and by language', () => {
    expect(formatMoney(1, 'UAH', 'en')).not.toBe(formatMoney(1, 'USD', 'en'))
    expect(formatMoney(1, 'UAH', 'en')).not.toBe(formatMoney(2, 'UAH', 'en'))
    expect(formatMoney(1, 'UAH', 'en')).not.toBe(formatMoney(1, 'UAH', 'uk'))
    expect(formatMoney(33.333333, 'EUR', 'uk')).toBe('33,33 EUR')
  })

  it('follows the current language by default', () => {
    expect(formatMoney(65, 'UAH')).toBe('65.00 UAH')

    setLang('uk', { persist: false })
    expect(formatMoney(65, 'UAH')).toBe('65,00 грн')
  })
})

describe('formatShortMoney', () => {
  it('drops the decimals of a whole amount', () => {
    expect(formatShortMoney(65, 'UAH', 'uk')).toBe('65 грн')
    expect(formatShortMoney(65, 'UAH', 'en')).toBe('65 UAH')
    expect(formatShortMoney(0, 'USD', 'en')).toBe('0 USD')
  })

  it('keeps 2 decimals for a fractional amount', () => {
    expect(formatShortMoney(12.5, 'USD', 'uk')).toBe('12,50 USD')
    expect(formatShortMoney(12.5, 'USD', 'en')).toBe('12.50 USD')
  })

  it('groups thousands', () => {
    expect(formatShortMoney(1234, 'UAH', 'en')).toBe('1,234 UAH')
    expect(formatShortMoney(1234, 'UAH', 'uk')).toMatch(/^1\s234 грн$/u)
  })
})

describe('formatRate', () => {
  it('shows up to 4 fraction digits', () => {
    expect(formatRate(41.52, 'en')).toBe('41.52')
    expect(formatRate(41.123456, 'en')).toBe('41.1235')
    expect(formatRate(0.02217, 'en')).toBe('0.0222')
    expect(formatRate(1, 'en')).toBe('1')
  })

  it('uses the Ukrainian decimal comma', () => {
    expect(formatRate(41.52, 'uk')).toBe('41,52')
    expect(formatRate(41.123456, 'uk')).toBe('41,1235')
  })

  it('differs for different rates', () => {
    expect(formatRate(41.52, 'en')).not.toBe(formatRate(45.1, 'en'))
  })
})

describe('formatDay', () => {
  it('formats "Oct 14" in English and "14 жовт." in Ukrainian', () => {
    expect(formatDay(new Date(2026, 9, 14), 'en')).toBe('Oct 14')
    expect(formatDay(new Date(2026, 9, 14), 'uk')).toBe('14 жовт.')
  })

  it('does not zero-pad the day', () => {
    expect(formatDay('2026-10-04', 'en')).toBe('Oct 4')
    expect(formatDay('2026-10-04', 'uk')).toBe('4 жовт.')
  })

  it('parses a YYYY-MM-DD string as a local date, whatever the timezone', () => {
    expect(formatDay('2026-03-01', 'en')).toBe('Mar 1')
    expect(formatDay('2026-03-01', 'uk')).toBe('1 бер.')
  })

  it('accepts a timestamp', () => {
    expect(formatDay(new Date(2026, 9, 14, 12, 0, 0).getTime(), 'en')).toBe('Oct 14')
  })

  it('uses the current language by default', () => {
    expect(formatDay('2026-10-14')).toBe('Oct 14')

    setLang('uk', { persist: false })
    expect(formatDay('2026-10-14')).toBe('14 жовт.')
  })
})

describe('formatMonth', () => {
  it('formats the long month and year, without the Ukrainian "р."', () => {
    expect(formatMonth('2026-10-14', 'en')).toBe('October 2026')
    expect(formatMonth('2026-10-14', 'uk')).toBe('жовтень 2026')
    expect(formatMonth('2026-03-01', 'en')).toBe('March 2026')
    expect(formatMonth('2026-03-01', 'uk')).toBe('березень 2026')
  })
})

describe('formatShortMonth', () => {
  it('formats the short month and a 2-digit year', () => {
    expect(formatShortMonth('2026-10-14', 'en')).toBe("Oct '26")
    expect(formatShortMonth('2026-10-14', 'uk')).toBe("жовт. '26")
    expect(formatShortMonth('2027-03-01', 'en')).toBe("Mar '27")
    expect(formatShortMonth('2027-03-01', 'uk')).toBe("бер. '27")
  })
})

describe('formatFullDate', () => {
  it('formats day, short month and year', () => {
    expect(formatFullDate('2026-10-14', 'en')).toBe('Oct 14, 2026')
    expect(formatFullDate('2026-10-14', 'uk')).toBe('14 жовт. 2026 р.')
    expect(formatFullDate('2026-03-01', 'en')).toBe('Mar 1, 2026')
    expect(formatFullDate('2026-03-01', 'uk')).toBe('1 бер. 2026 р.')
  })
})

describe('formatTime', () => {
  it('uses a 24-hour clock in Ukrainian', () => {
    expect(formatTime(new Date(2026, 9, 14, 9, 5), 'uk')).toBe('09:05')
    expect(formatTime(new Date(2026, 9, 14, 15, 30), 'uk')).toBe('15:30')
  })

  it('uses hh:mm A with an ASCII space in English', () => {
    expect(formatTime(new Date(2026, 9, 14, 9, 5), 'en')).toBe('09:05 AM')
    expect(formatTime(new Date(2026, 9, 14, 15, 30), 'en')).toBe('03:30 PM')
    expect(formatTime(new Date(2026, 9, 14, 0, 0), 'en')).toBe('12:00 AM')
    expect(formatTime(new Date(2026, 9, 14, 12, 0), 'en')).toBe('12:00 PM')
  })
})

describe('lib/money re-exports the same helpers', () => {
  it('formatAmount, formatMoney, formatShortMoney and formatRate behave identically', () => {
    expect(money.formatAmount(1234.5, 'uk')).toBe(formatAmount(1234.5, 'uk'))
    expect(money.formatMoney(20, 'USD', 'uk')).toBe(formatMoney(20, 'USD', 'uk'))
    expect(money.formatShortMoney(65, 'UAH', 'uk')).toBe(formatShortMoney(65, 'UAH', 'uk'))
    expect(money.formatRate(41.52, 'en')).toBe(formatRate(41.52, 'en'))
  })

  it('pendingLabel follows the language', () => {
    expect(money.pendingLabel(1)).toBe('1 entry waiting for exchange rates')
    expect(money.pendingLabel(3)).toBe('3 entries waiting for exchange rates')

    setLang('uk', { persist: false })
    expect(money.pendingLabel(1)).toMatch(/[Ѐ-ӿ]/)
    expect(money.pendingLabel(1)).not.toBe('1 entry waiting for exchange rates')
    expect(money.pendingLabel(1)).not.toBe(money.pendingLabel(5))
  })
})

describe('amount inputs accept "," and "." in both languages', () => {
  it.each(['en', 'uk'] as const)('parseDraftAmount under %s', (lang) => {
    setLang(lang, { persist: false })

    expect(parseDraftAmount('12,5')).toBe(12.5)
    expect(parseDraftAmount('12.5')).toBe(12.5)
    expect(parseDraftAmount('7,25')).toBe(7.25)
    expect(parseDraftAmount('1.2.3')).toBeNaN()
  })
})
