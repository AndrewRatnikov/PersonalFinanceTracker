// The UI languages. No imports, so every other i18n module (and lib code) can
// depend on it.

export type Lang = 'uk' | 'en'

export const LANGS: ReadonlyArray<Lang> = ['uk', 'en']

export function isLang(value: unknown): value is Lang {
  return value === 'uk' || value === 'en'
}
