// No CONTRACT_GAPs: every function of src/i18n/resolve.ts is specified in the
// Interface Contract (module: resolve) and plan section 1.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LANG_COOKIE,
  LANG_COOKIE_MAX_AGE,
  LANG_STORAGE_KEY,
  clearStoredLang,
  langCookie,
  langFromAcceptLanguage,
  langFromCookieHeader,
  langFromLanguages,
  persistLang,
  readStoredLang,
  resolveClientLang,
  resolveServerLang,
} from '@/i18n/resolve'

function clearCookie() {
  document.cookie = 'minima_lang=; Path=/; Max-Age=0'
}

function setNavigatorLanguages(languages: Array<string>) {
  Object.defineProperty(navigator, 'languages', {
    value: languages,
    configurable: true,
  })
}

beforeEach(() => {
  localStorage.clear()
  clearCookie()
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'languages')
  vi.restoreAllMocks()
  localStorage.clear()
  clearCookie()
})

describe('constants', () => {
  it('names the storage key, the cookie and the cookie lifetime', () => {
    expect(LANG_STORAGE_KEY).toBe('minima_lang')
    expect(LANG_COOKIE).toBe('minima_lang')
    expect(LANG_COOKIE_MAX_AGE).toBe(31536000)
  })
})

describe('langFromLanguages', () => {
  it.each([
    [['uk-UA', 'en'], 'uk'],
    [['uk'], 'uk'],
    [['UK-ua'], 'uk'],
    [['en-US', 'uk'], 'uk'],
    [['ru-RU', 'uk-UA'], 'uk'],
    [['en-US', 'en'], 'en'],
    [['ru-RU'], 'en'],
    [['ru'], 'en'],
    [['de-DE', 'fr'], 'en'],
    [[], 'en'],
  ] as const)('%j gives %s', (languages, expected) => {
    expect(langFromLanguages(languages)).toBe(expected)
  })

  it('gives English when there is no list', () => {
    expect(langFromLanguages(undefined)).toBe('en')
  })
})

describe('langFromAcceptLanguage', () => {
  it.each([
    ['uk-UA,uk;q=0.9', 'uk'],
    ['uk', 'uk'],
    ['en-US,en;q=0.9,uk;q=0.5', 'uk'],
    ['ru-RU,ru;q=0.9,uk;q=0.8', 'uk'],
    [' UK-UA ; q=0.8', 'uk'],
    ['en-US,en;q=0.9', 'en'],
    ['ru-RU,ru;q=0.9,en;q=0.8', 'en'],
    ['de', 'en'],
  ])('%j gives %s', (header, expected) => {
    expect(langFromAcceptLanguage(header)).toBe(expected)
  })

  it('gives English for a missing or empty header', () => {
    expect(langFromAcceptLanguage(null)).toBe('en')
    expect(langFromAcceptLanguage(undefined)).toBe('en')
    expect(langFromAcceptLanguage('')).toBe('en')
  })
})

describe('langFromCookieHeader', () => {
  it('reads a valid minima_lang cookie among others', () => {
    expect(langFromCookieHeader('a=b; minima_lang=uk; c=d')).toBe('uk')
    expect(langFromCookieHeader('minima_lang=en')).toBe('en')
    expect(langFromCookieHeader('theme=dark;minima_lang=uk')).toBe('uk')
  })

  it('is null for an invalid value, another cookie name or no header', () => {
    expect(langFromCookieHeader('minima_lang=ru')).toBeNull()
    expect(langFromCookieHeader('minima_lang=')).toBeNull()
    expect(langFromCookieHeader('other=uk')).toBeNull()
    expect(langFromCookieHeader('xminima_lang=uk')).toBeNull()
    expect(langFromCookieHeader('')).toBeNull()
    expect(langFromCookieHeader(null)).toBeNull()
    expect(langFromCookieHeader(undefined)).toBeNull()
  })
})

describe('resolveServerLang', () => {
  it('the cookie wins over Accept-Language', () => {
    expect(
      resolveServerLang({ cookie: 'minima_lang=en', acceptLanguage: 'uk-UA' }),
    ).toBe('en')
    expect(
      resolveServerLang({ cookie: 'minima_lang=uk', acceptLanguage: 'en-US' }),
    ).toBe('uk')
  })

  it('falls back to Accept-Language without a cookie', () => {
    expect(resolveServerLang({ acceptLanguage: 'uk-UA,uk;q=0.9' })).toBe('uk')
    expect(resolveServerLang({ acceptLanguage: 'en-US' })).toBe('en')
    expect(resolveServerLang({ cookie: null, acceptLanguage: 'uk' })).toBe('uk')
  })

  it('ignores an invalid cookie value and an unrelated cookie', () => {
    expect(
      resolveServerLang({ cookie: 'minima_lang=ru', acceptLanguage: 'uk-UA' }),
    ).toBe('uk')
    expect(
      resolveServerLang({ cookie: 'session=abc', acceptLanguage: 'uk-UA' }),
    ).toBe('uk')
  })

  it('is English without any input', () => {
    expect(resolveServerLang({})).toBe('en')
    expect(resolveServerLang({ cookie: null, acceptLanguage: null })).toBe('en')
  })
})

describe('readStoredLang', () => {
  it('reads localStorage', () => {
    localStorage.setItem('minima_lang', 'uk')
    expect(readStoredLang()).toBe('uk')

    localStorage.setItem('minima_lang', 'en')
    expect(readStoredLang()).toBe('en')
  })

  it('reads the cookie when localStorage has nothing valid', () => {
    document.cookie = 'minima_lang=uk; Path=/'
    expect(readStoredLang()).toBe('uk')

    localStorage.setItem('minima_lang', 'ru')
    expect(readStoredLang()).toBe('uk')
  })

  it('localStorage wins over the cookie', () => {
    localStorage.setItem('minima_lang', 'en')
    document.cookie = 'minima_lang=uk; Path=/'

    expect(readStoredLang()).toBe('en')
  })

  it('is null when nothing is stored', () => {
    expect(readStoredLang()).toBeNull()
  })

  it('never throws when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })

    expect(() => readStoredLang()).not.toThrow()
    expect(readStoredLang()).toBeNull()
  })
})

describe('resolveClientLang', () => {
  it('a stored choice beats the browser languages', () => {
    expect(resolveClientLang({ stored: 'en', languages: ['uk-UA'] })).toBe('en')
    expect(resolveClientLang({ stored: 'uk', languages: ['en-US'] })).toBe('uk')
  })

  it('without a stored choice, any Ukrainian browser language gives uk', () => {
    expect(resolveClientLang({ stored: null, languages: ['uk-UA', 'en'] })).toBe('uk')
    expect(resolveClientLang({ stored: null, languages: ['en-US', 'uk'] })).toBe('uk')
  })

  it('otherwise English, and Russian is never mapped to Ukrainian', () => {
    expect(resolveClientLang({ stored: null, languages: ['ru-RU'] })).toBe('en')
    expect(resolveClientLang({ stored: null, languages: ['en-US'] })).toBe('en')
    expect(resolveClientLang({ stored: null, languages: [] })).toBe('en')
  })

  it('reads the stored choice itself when none is passed', () => {
    localStorage.setItem('minima_lang', 'en')
    expect(resolveClientLang({ languages: ['uk-UA'] })).toBe('en')

    localStorage.setItem('minima_lang', 'uk')
    expect(resolveClientLang({ languages: ['en-US'] })).toBe('uk')
  })

  it('reads navigator.languages when none are passed', () => {
    setNavigatorLanguages(['uk-UA', 'en'])
    expect(resolveClientLang()).toBe('uk')

    setNavigatorLanguages(['ru-RU'])
    expect(resolveClientLang()).toBe('en')
  })

  it('a stored choice beats navigator.languages', () => {
    setNavigatorLanguages(['uk-UA'])
    localStorage.setItem('minima_lang', 'en')

    expect(resolveClientLang()).toBe('en')
  })
})

describe('langCookie', () => {
  it('is exactly the documented cookie string', () => {
    expect(langCookie('uk')).toBe(
      'minima_lang=uk; Path=/; Max-Age=31536000; SameSite=Lax',
    )
    expect(langCookie('en')).toBe(
      'minima_lang=en; Path=/; Max-Age=31536000; SameSite=Lax',
    )
  })

  it('is readable from JavaScript (no HttpOnly)', () => {
    expect(langCookie('uk')).not.toContain('HttpOnly')
  })
})

describe('persistLang and clearStoredLang', () => {
  it('writes both localStorage and the cookie', () => {
    persistLang('uk')

    expect(localStorage.getItem('minima_lang')).toBe('uk')
    expect(document.cookie).toContain('minima_lang=uk')
    expect(readStoredLang()).toBe('uk')

    persistLang('en')
    expect(localStorage.getItem('minima_lang')).toBe('en')
    expect(document.cookie).toContain('minima_lang=en')
    expect(document.cookie).not.toContain('minima_lang=uk')
  })

  it('swallows storage errors', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })

    expect(() => persistLang('uk')).not.toThrow()
  })

  it('clearStoredLang removes both, so detection is automatic again', () => {
    persistLang('uk')
    document.cookie = 'other=keep; Path=/'

    clearStoredLang()

    expect(localStorage.getItem('minima_lang')).toBeNull()
    expect(document.cookie).not.toContain('minima_lang')
    expect(document.cookie).toContain('other=keep')
    expect(readStoredLang()).toBeNull()
    expect(resolveClientLang({ languages: ['en-US'] })).toBe('en')

    document.cookie = 'other=; Path=/; Max-Age=0'
  })

  it('clearStoredLang is safe when nothing is stored', () => {
    expect(() => clearStoredLang()).not.toThrow()
    expect(readStoredLang()).toBeNull()
  })
})
