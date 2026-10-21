// React bindings: the provider (owns the rendered language and follows every
// setLang() call), useT() and <LangHtml>.

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  getLang,
  setLang,
  subscribeLang,
  translate,
  translatePlural,
} from './core'
import { readStoredLang, resolveClientLang } from './resolve'
import type { ReactNode } from 'react'
import type { Lang } from './lang'
import type { MessageKey, MessageParams, PluralKey } from './core'

interface I18nState {
  lang: Lang
  pending: boolean
}

const I18nContext = createContext<I18nState | null>(null)

// A layout effect on the client (runs before paint), nothing on the server.
const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

function updateDocumentMeta(lang: Lang) {
  if (typeof document === 'undefined') return
  document.title = translate(lang, 'landing.metaTitle')
  const meta = document.head.querySelector('meta[name="description"]')
  if (meta) meta.setAttribute('content', translate(lang, 'landing.metaDescription'))
}

// initialLang:
// - undefined: start from getLang() (unit tests)
// - a Lang (SSR and hydration): render in it, then switch to a stored choice
//   that differs (one-time, re-writes the cookie)
// - null (the offline shell): pending until a layout effect resolves the
//   language on the client, before first paint
export function I18nProvider({
  initialLang,
  children,
}: {
  initialLang?: Lang | null
  children: ReactNode
}) {
  const [state, setState] = useState<I18nState>(() => {
    if (initialLang === undefined) return { lang: getLang(), pending: false }
    if (initialLang === null) return { lang: getLang(), pending: true }
    // Set the module language during the first render, so the format helpers
    // (which read getLang()) agree with the provider on the server and while
    // hydrating.
    setLang(initialLang, { persist: false })
    return { lang: initialLang, pending: false }
  })
  const renderedLang = useRef(state.lang)

  useClientLayoutEffect(() => {
    if (!state.pending) return
    const lang = resolveClientLang()
    setLang(lang, { persist: false })
    setState({ lang, pending: false })
    // Runs once for the shell.
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeLang((lang) => {
      setState({ lang, pending: false })
    })
    if (initialLang) {
      const stored = readStoredLang()
      if (stored !== null && stored !== initialLang) setLang(stored)
    } else if (initialLang === undefined && getLang() !== state.lang) {
      setState({ lang: getLang(), pending: false })
    }
    return unsubscribe
    // Subscribes once; later changes arrive through the listener.
  }, [])

  useEffect(() => {
    if (state.pending || renderedLang.current === state.lang) return
    renderedLang.current = state.lang
    updateDocumentMeta(state.lang)
  }, [state.lang, state.pending])

  return <I18nContext.Provider value={state}>{children}</I18nContext.Provider>
}

export interface UseT {
  lang: Lang
  pending: boolean
  setLang: (lang: Lang) => void
  t: (key: MessageKey, params?: MessageParams) => string
  plural: (key: PluralKey, count: number, params?: MessageParams) => string
}

function bind(lang: Lang, pending: boolean): UseT {
  return {
    lang,
    pending,
    setLang: (next: Lang) => setLang(next),
    t: (key, params) => translate(lang, key, params),
    plural: (key, count, params) => translatePlural(lang, key, count, params),
  }
}

// Outside a provider it is bound to getLang() and does not re-render on change.
export function useT(): UseT {
  const context = useContext(I18nContext)
  const lang = context?.lang ?? getLang()
  const pending = context?.pending ?? false
  return useMemo(() => bind(lang, pending), [lang, pending])
}

export function LangHtml({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  const { lang } = useT()
  return (
    <html lang={lang} className={className}>
      {children}
    </html>
  )
}
