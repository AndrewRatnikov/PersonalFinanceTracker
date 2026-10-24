// Terms of Use and Privacy Policy: shared types, paths and the operator
// details. The texts live in src/content/legal/{en,uk}.ts (typed content, not
// the UI catalog); this module imports nothing from them.

export type LegalKind = 'terms' | 'privacy'

export interface LegalSection {
  id: string
  heading: string
  paragraphs: ReadonlyArray<string>
  bullets?: ReadonlyArray<string>
}

export interface LegalDoc {
  title: string
  /** YYYY-MM-DD */
  lastUpdated: string
  intro: ReadonlyArray<string>
  sections: ReadonlyArray<LegalSection>
}

export interface LegalContent {
  terms: LegalDoc
  privacy: LegalDoc
}

export const LEGAL_LAST_UPDATED = '2026-10-23'

export const TERMS_PATH = '/terms'
export const PRIVACY_PATH = '/privacy'

// TODO(owner): replace with the legal name of the operator (a person or a
// company) before this reaches production; the pages are public.
export const LEGAL_OPERATOR_NAME = 'MinimaSpend'

// TODO(owner): replace with a real, monitored contact address before this
// reaches production; the pages are public.
export const LEGAL_CONTACT_EMAIL = 'contact@example.com'
