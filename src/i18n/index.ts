// Public i18n API. Named re-exports only.

export { type Lang, LANGS, isLang } from './lang'
export {
  type MessageKey,
  type MessageParams,
  type PluralKey,
  translate,
  translatePlural,
  t,
  plural,
  getLang,
  setLang,
  subscribeLang,
  catalogKeys,
} from './core'
export { I18nProvider, useT, LangHtml } from './react'
