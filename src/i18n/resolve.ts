// Language resolution and persistence. The choice lives in localStorage and in
// a cookie of the same name, so the server can render the right language.
// Touches localStorage / document only inside guarded functions.

import { isLang } from './lang'
import type { Lang } from './lang'

export const LANG_STORAGE_KEY = 'minima_lang'
export const LANG_COOKIE = 'minima_lang'
export const LANG_COOKIE_MAX_AGE = 31536000

// 'uk' when any entry starts with "uk" (ignoring case). Russian is never mapped
// to Ukrainian.
export function langFromLanguages(languages: ReadonlyArray<string> | undefined): Lang {
  if (!languages) return 'en'
  return languages.some((tag) => tag.trim().toLowerCase().startsWith('uk')) ? 'uk' : 'en'
}

export function langFromAcceptLanguage(header: string | null | undefined): Lang {
  if (!header) return 'en'
  const tags = header.split(',').map((part) => part.split(';')[0].trim())
  return langFromLanguages(tags)
}

export function langFromCookieHeader(cookieHeader: string | null | undefined): Lang | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const name = part.slice(0, index).trim()
    if (name !== LANG_COOKIE) continue
    const value = part.slice(index + 1).trim()
    return isLang(value) ? value : null
  }
  return null
}

export function resolveServerLang(input: {
  cookie?: string | null
  acceptLanguage?: string | null
}): Lang {
  return langFromCookieHeader(input.cookie) ?? langFromAcceptLanguage(input.acceptLanguage)
}

export function readStoredLang(): Lang | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(LANG_STORAGE_KEY)
      if (isLang(stored)) return stored
    }
  } catch {
    // Storage blocked: fall through to the cookie.
  }
  try {
    if (typeof document !== 'undefined') return langFromCookieHeader(document.cookie)
  } catch {
    // No cookie access.
  }
  return null
}

export function resolveClientLang(input?: {
  stored?: Lang | null
  languages?: ReadonlyArray<string>
}): Lang {
  const stored = input?.stored !== undefined ? input.stored : readStoredLang()
  if (stored !== null) return stored
  const languages =
    input?.languages ??
    (typeof navigator !== 'undefined' ? navigator.languages : undefined)
  return langFromLanguages(languages)
}

export function langCookie(lang: Lang): string {
  return `${LANG_COOKIE}=${lang}; Path=/; Max-Age=${LANG_COOKIE_MAX_AGE}; SameSite=Lax`
}

export function persistLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang)
  } catch {
    // Storage blocked or full: the cookie still carries the choice.
  }
  try {
    if (typeof document !== 'undefined') document.cookie = langCookie(lang)
  } catch {
    // No cookie access.
  }
}

export function clearStoredLang(): void {
  try {
    localStorage.removeItem(LANG_STORAGE_KEY)
  } catch {
    // Storage blocked.
  }
  try {
    if (typeof document !== 'undefined') {
      document.cookie = `${LANG_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
    }
  } catch {
    // No cookie access.
  }
}
