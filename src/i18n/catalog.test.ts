// CONTRACT_GAP: the exact key names of the Ukrainian wording outside the plan's
// "Keys the tests depend on" table are the Coder's, so this file only pins the
// keys of that table and checks the rest structurally (same key set, same
// placeholders, same plural nodes).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  catalogKeys,
  getLang,
  localeOf,
  plural,
  setLang,
  subscribeLang,
  t,
  translate,
  translatePlural,
} from '@/i18n/core'
import * as barrel from '@/i18n'
import { LANGS, isLang } from '@/i18n/lang'
import { en } from '@/i18n/messages/en'
import { uk } from '@/i18n/messages/uk'
import * as react from '@/i18n/react'

const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other']

type Leaf = string | Record<string, string>

function isPluralNode(node: unknown): node is Record<string, string> {
  if (typeof node !== 'object' || node === null) return false
  const keys = Object.keys(node)
  return keys.includes('other') && keys.every((k) => PLURAL_CATEGORIES.includes(k))
}

function leaves(tree: object, prefix = ''): Array<[string, Leaf]> {
  const out: Array<[string, Leaf]> = []
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'string') out.push([path, value])
    else if (isPluralNode(value)) out.push([path, value])
    else if (typeof value === 'object' && value !== null) out.push(...leaves(value, path))
  }
  return out
}

function placeholders(text: string): Array<string> {
  return Array.from(new Set(text.match(/\{[A-Za-z0-9_]+\}/g) ?? [])).sort()
}

function clearPersistedLang() {
  localStorage.clear()
  document.cookie = 'minima_lang=; Path=/; Max-Age=0'
}

// Must stay the first describe of the file: nothing has called setLang yet, so
// this really observes the module's initial state.
describe('initial language', () => {
  it('starts in English', () => {
    expect(getLang()).toBe('en')
  })
})

describe('Lang helpers', () => {
  it('LANGS lists uk and en', () => {
    expect([...LANGS].sort()).toEqual(['en', 'uk'])
  })

  it('isLang accepts only uk and en', () => {
    expect(isLang('uk')).toBe(true)
    expect(isLang('en')).toBe(true)
    expect(isLang('ru')).toBe(false)
    expect(isLang('UK')).toBe(false)
    expect(isLang('')).toBe(false)
    expect(isLang(null)).toBe(false)
    expect(isLang(undefined)).toBe(false)
    expect(isLang(1)).toBe(false)
  })

  it('localeOf maps each language to its locale', () => {
    expect(localeOf('uk')).toBe('uk-UA')
    expect(localeOf('en')).toBe('en-US')
  })
})

describe('public barrel (src/i18n/index.ts)', () => {
  it('re-exports the core, language and React API by name', () => {
    expect(barrel.t).toBe(t)
    expect(barrel.plural).toBe(plural)
    expect(barrel.translate).toBe(translate)
    expect(barrel.translatePlural).toBe(translatePlural)
    expect(barrel.getLang).toBe(getLang)
    expect(barrel.setLang).toBe(setLang)
    expect(barrel.subscribeLang).toBe(subscribeLang)
    expect(barrel.catalogKeys).toBe(catalogKeys)
    expect(barrel.LANGS).toBe(LANGS)
    expect(barrel.isLang).toBe(isLang)
    expect(barrel.I18nProvider).toBe(react.I18nProvider)
    expect(barrel.useT).toBe(react.useT)
    expect(barrel.LangHtml).toBe(react.LangHtml)
  })
})

describe('catalog structure', () => {
  it('the English and Ukrainian catalogs have exactly the same keys', () => {
    const enKeys = catalogKeys(en)
    const ukKeys = catalogKeys(uk)

    expect(enKeys.length).toBeGreaterThan(50)
    expect(ukKeys).toEqual(enKeys)
  })

  it('catalogKeys returns sorted dotted keys and counts a plural node as one leaf', () => {
    const keys = catalogKeys({
      b: 'x',
      a: { z: 'y', c: { one: '{count} a', other: '{count} b' } },
    })

    expect(keys).toEqual(['a.c', 'a.z', 'b'])
    expect(catalogKeys({ x: { one: '1', few: '2', many: '3', other: '4' } })).toEqual(['x'])
  })

  it('catalogKeys differs for different catalogs', () => {
    expect(catalogKeys({ a: 'x' })).not.toEqual(catalogKeys({ a: 'x', b: 'y' }))
  })

  it('is grouped by area', () => {
    const areas = Object.keys(en)

    for (const area of [
      'common',
      'nav',
      'landing',
      'vault',
      'dashboard',
      'transactions',
      'drawer',
      'income',
      'recurring',
      'analytics',
      'settings',
      'backup',
      'errors',
      'toasts',
    ]) {
      expect(areas).toContain(area)
    }
  })

  it('every Ukrainian message keeps the English placeholders', () => {
    const ukByKey = new Map(leaves(uk))

    for (const [key, enLeaf] of leaves(en)) {
      const ukLeaf = ukByKey.get(key)
      expect(ukLeaf, key).toBeDefined()
      if (typeof enLeaf === 'string') {
        expect(typeof ukLeaf, key).toBe('string')
        expect(placeholders(String(ukLeaf)), key).toEqual(placeholders(enLeaf))
      } else {
        expect(isPluralNode(ukLeaf), key).toBe(true)
        const ukForms = ukLeaf as Record<string, string>
        const allowed = placeholders(enLeaf.other)
        expect(placeholders(ukForms.other), key).toEqual(allowed)
        for (const form of Object.values(ukForms)) {
          for (const name of placeholders(form)) expect(allowed, key).toContain(name)
        }
      }
    }
  })

  it('has no empty messages', () => {
    for (const [key, leaf] of [...leaves(en), ...leaves(uk)]) {
      const forms = typeof leaf === 'string' ? [leaf] : Object.values(leaf)
      for (const form of forms) expect(form.trim(), key).not.toBe('')
    }
  })
})

describe('keys pinned by the plan', () => {
  it.each([
    ['common.languageName.uk', 'Українська', 'Українська'],
    ['common.languageName.en', 'English', 'English'],
    ['common.languageShort.uk', 'UK', 'UK'],
    ['common.languageShort.en', 'EN', 'EN'],
    ['settings.language.label', 'Мова / Language', 'Мова / Language'],
    ['landing.heroTitle', 'Track your money.', undefined],
    ['landing.heroAccent', 'Own your data.', undefined],
    ['errors.vault.incorrectPassword', 'Incorrect password', 'Неправильний пароль'],
    [
      'errors.mainCurrency.offline',
      "You're offline. Connect to the internet to change the main currency.",
      'Ви офлайн. Підключіться до інтернету, щоб змінити основну валюту.',
    ],
    ['errors.validation.amountPositive', 'Amount must be greater than 0', 'Сума має бути більшою за 0'],
    ['errors.validation.categoryRequired', 'Category is required', undefined],
    ['errors.validation.dateRequired', 'Date is required', undefined],
    ['errors.validation.invalidDate', 'Invalid date', undefined],
    [
      'errors.validation.intervalRange',
      'Interval must be a whole number from 1 to 365',
      undefined,
    ],
    ['errors.validation.wholeNumber', 'Must be a whole number', undefined],
    ['errors.validation.atLeastOne', 'Must be at least 1', undefined],
    [
      'errors.validation.endBeforeStart',
      "End date can't be before the start date",
      undefined,
    ],
    ['errors.validation.categoryNotFound', 'Category not found', undefined],
    ['errors.unexpected', 'Something went wrong. Please try again.', undefined],
  ] as const)('%s', (key, english, ukrainian) => {
    const typedKey = key as Parameters<typeof translate>[1]

    expect(translate('en', typedKey)).toBe(english)
    if (ukrainian !== undefined) {
      expect(translate('uk', typedKey)).toBe(ukrainian)
    } else {
      expect(translate('uk', typedKey)).not.toBe(english)
      expect(translate('uk', typedKey)).not.toBe(key)
    }
  })

  it('the Ukrainian landing title is Ukrainian, not the English one', () => {
    expect(translate('uk', 'landing.heroTitle')).toMatch(/[Ѐ-ӿ]/)
    expect(translate('uk', 'landing.heroAccent')).toMatch(/[Ѐ-ӿ]/)
  })
})

describe('translate and t', () => {
  beforeEach(() => {
    clearPersistedLang()
    setLang('en', { persist: false })
  })

  afterEach(() => {
    setLang('en', { persist: false })
  })

  it('interpolates {name} in both languages', () => {
    expect(translate('en', 'errors.app.categoryExists', { name: 'Food' })).toBe(
      'Category "Food" already exists',
    )
    expect(translate('uk', 'errors.app.categoryExists', { name: 'Їжа' })).toBe(
      'Категорія «Їжа» вже існує',
    )
  })

  it('different params give different results', () => {
    const a = translate('en', 'errors.app.categoryExists', { name: 'Food' })
    const b = translate('en', 'errors.app.categoryExists', { name: 'Rent' })

    expect(a).not.toBe(b)
    expect(b).toContain('Rent')
    expect(b).not.toContain('Food')
  })

  it('keeps a placeholder whose param is missing', () => {
    expect(translate('en', 'errors.app.categoryExists')).toBe(
      'Category "{name}" already exists',
    )
    expect(translate('en', 'errors.app.categoryExists', {})).toContain('{name}')
  })

  it('stringifies number params', () => {
    expect(translate('en', 'errors.app.categoryExists', { name: 42 })).toBe(
      'Category "42" already exists',
    )
  })

  it('returns the key itself for an unknown key', () => {
    // @ts-expect-error unknown key
    expect(t('dashboard.nope')).toBe('dashboard.nope')
    // @ts-expect-error unknown key
    expect(translate('uk', 'dashboard.nope')).toBe('dashboard.nope')
  })

  it('t follows the current language', () => {
    expect(t('errors.vault.incorrectPassword')).toBe('Incorrect password')

    setLang('uk', { persist: false })
    expect(t('errors.vault.incorrectPassword')).toBe('Неправильний пароль')

    setLang('en', { persist: false })
    expect(t('errors.vault.incorrectPassword')).toBe('Incorrect password')
  })

  it('rejects unknown keys and non-plural keys at compile time', () => {
    const compileOnly = () => {
      // @ts-expect-error unknown key
      t('dashboard.nope')
      // @ts-expect-error a plural node is not a message key
      t('records')
      // @ts-expect-error a plain message is not a plural key
      plural('dashboard.title', 1)
    }

    expect(typeof compileOnly).toBe('function')
  })
})

describe('plural', () => {
  beforeEach(() => {
    clearPersistedLang()
    setLang('en', { persist: false })
  })

  afterEach(() => {
    setLang('en', { persist: false })
  })

  it.each([
    [1, '1 запис'],
    [2, '2 записи'],
    [3, '3 записи'],
    [4, '4 записи'],
    [5, '5 записів'],
    [11, '11 записів'],
    [12, '12 записів'],
    [21, '21 запис'],
    [22, '22 записи'],
    [25, '25 записів'],
    [0, '0 записів'],
    [1.5, '1,5 запису'],
  ])('Ukrainian records for %s is "%s"', (count, expected) => {
    expect(translatePlural('uk', 'records', count)).toBe(expected)
  })

  it.each([
    [1, '1 record'],
    [2, '2 records'],
    [0, '0 records'],
    [21, '21 records'],
    [1.5, '1.5 records'],
  ])('English records for %s is "%s"', (count, expected) => {
    expect(translatePlural('en', 'records', count)).toBe(expected)
  })

  it('plural follows the current language', () => {
    expect(plural('records', 5)).toBe('5 records')

    setLang('uk', { persist: false })
    expect(plural('records', 5)).toBe('5 записів')
    expect(plural('records', 2)).toBe('2 записи')
  })

  it('groups large counts with the locale separator', () => {
    expect(translatePlural('en', 'records', 1234)).toBe('1,234 records')
    expect(translatePlural('uk', 'records', 1234)).toMatch(/^1\s234 записи$/u)
  })
})

describe('setLang, getLang and subscribeLang', () => {
  beforeEach(() => {
    clearPersistedLang()
    setLang('en', { persist: false })
    document.documentElement.lang = ''
  })

  afterEach(() => {
    setLang('en', { persist: false })
    clearPersistedLang()
  })

  it('persists by default: state, <html lang>, localStorage and cookie', () => {
    setLang('uk')

    expect(getLang()).toBe('uk')
    expect(document.documentElement.lang).toBe('uk')
    expect(localStorage.getItem('minima_lang')).toBe('uk')
    expect(document.cookie).toContain('minima_lang=uk')

    setLang('en')
    expect(getLang()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(localStorage.getItem('minima_lang')).toBe('en')
    expect(document.cookie).toContain('minima_lang=en')
    expect(document.cookie).not.toContain('minima_lang=uk')
  })

  it('persist: false sets state and <html lang> but writes nothing', () => {
    setLang('uk', { persist: false })

    expect(getLang()).toBe('uk')
    expect(document.documentElement.lang).toBe('uk')
    expect(localStorage.getItem('minima_lang')).toBeNull()
    expect(document.cookie).not.toContain('minima_lang')
  })

  it('notifies subscribers only when the language changed, until unsubscribed', () => {
    const listener = vi.fn<(lang: 'uk' | 'en') => void>()
    const unsubscribe = subscribeLang(listener)

    setLang('uk', { persist: false })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith('uk')

    setLang('uk', { persist: false })
    expect(listener).toHaveBeenCalledTimes(1)

    setLang('en', { persist: false })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith('en')

    unsubscribe()
    setLang('uk', { persist: false })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('setting the same language again still updates <html lang> and persists', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLang(listener)
    document.documentElement.lang = 'xx'

    setLang('en')

    expect(listener).not.toHaveBeenCalled()
    expect(document.documentElement.lang).toBe('en')
    expect(localStorage.getItem('minima_lang')).toBe('en')
    unsubscribe()
  })

  it('every subscriber gets the notification', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeLang(a)
    const offB = subscribeLang(b)

    setLang('uk', { persist: false })

    expect(a).toHaveBeenCalledWith('uk')
    expect(b).toHaveBeenCalledWith('uk')
    offA()
    offB()
  })
})
