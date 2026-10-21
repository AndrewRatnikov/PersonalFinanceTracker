// The React-free i18n core: typed keys, t / plural, and the current language.
// Lib code may import this module; it never imports React.

import { en } from './messages/en'
import { uk } from './messages/uk'
import { persistLang } from './resolve'
import type { Lang } from './lang'

type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

const PLURAL_CATEGORIES: ReadonlyArray<string> = ['zero', 'one', 'two', 'few', 'many', 'other']

type IsPluralNode<T> = T extends { other: string }
  ? Exclude<keyof T, PluralCategory> extends never
    ? true
    : false
  : false

type MessagePaths<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : IsPluralNode<T[K]> extends true
      ? never
      : `${K}.${MessagePaths<T[K]>}`
}[keyof T & string]

type PluralPaths<T> = {
  [K in keyof T & string]: T[K] extends string
    ? never
    : IsPluralNode<T[K]> extends true
      ? K
      : `${K}.${PluralPaths<T[K]>}`
}[keyof T & string]

// Dotted paths to the string leaves of the English catalog.
export type MessageKey = MessagePaths<typeof en>
// Dotted paths to the plural nodes of the English catalog, e.g. 'records'.
export type PluralKey = PluralPaths<typeof en>
export type MessageParams = Record<string, string | number>

const CATALOGS: Record<Lang, object> = { en, uk }

export function localeOf(lang: Lang): 'uk-UA' | 'en-US' {
  return lang === 'uk' ? 'uk-UA' : 'en-US'
}

function isPluralNode(node: unknown): node is Record<string, string> {
  if (typeof node !== 'object' || node === null) return false
  const keys = Object.keys(node)
  return keys.includes('other') && keys.every((k) => PLURAL_CATEGORIES.includes(k))
}

function lookup(catalog: object, key: string): unknown {
  let node: unknown = catalog
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

function interpolate(text: string, params: MessageParams | undefined): string {
  if (!params) return text
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

// Whether `key` names a string message of the catalog (for keys that arrive as
// plain strings, e.g. zod messages).
export function isMessageKey(key: string): key is MessageKey {
  return typeof lookup(en, key) === 'string'
}

export function translate(lang: Lang, key: MessageKey, params?: MessageParams): string {
  const own = lookup(CATALOGS[lang], key)
  const text = typeof own === 'string' ? own : lookup(en, key)
  return interpolate(typeof text === 'string' ? text : key, params)
}

export function translatePlural(
  lang: Lang,
  key: PluralKey,
  count: number,
  params?: MessageParams,
): string {
  const own = lookup(CATALOGS[lang], key)
  const fallback = lookup(en, key)
  const node = isPluralNode(own) ? own : isPluralNode(fallback) ? fallback : null
  if (!node) return key
  const locale = localeOf(lang)
  const category = new Intl.PluralRules(locale).select(count)
  const form = node[category] ?? node.other
  return interpolate(form, {
    ...params,
    count: new Intl.NumberFormat(locale).format(count),
  })
}

// ── Current language (module state) ──────────────────────────────────────────

let current: Lang = 'en'
const listeners = new Set<(lang: Lang) => void>()

export function getLang(): Lang {
  return current
}

// Sets the language, <html lang> and (unless persist is false) localStorage +
// the cookie. Subscribers hear about it only when the value changed.
export function setLang(lang: Lang, options?: { persist?: boolean }): void {
  const changed = lang !== current
  current = lang
  if (typeof document !== 'undefined') document.documentElement.lang = lang
  if (options?.persist ?? true) persistLang(lang)
  if (changed) {
    for (const listener of Array.from(listeners)) listener(lang)
  }
}

export function subscribeLang(listener: (lang: Lang) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function t(key: MessageKey, params?: MessageParams): string {
  return translate(current, key, params)
}

export function plural(key: PluralKey, count: number, params?: MessageParams): string {
  return translatePlural(current, key, count, params)
}

// Sorted dotted keys of every leaf; a plural node counts as one leaf.
export function catalogKeys(catalog: object): Array<string> {
  const keys: Array<string> = []
  const walk = (node: object, prefix: string) => {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix === '' ? key : `${prefix}.${key}`
      if (typeof value === 'string' || isPluralNode(value)) keys.push(path)
      else if (typeof value === 'object' && value !== null) walk(value, path)
    }
  }
  walk(catalog, '')
  return keys.sort()
}
