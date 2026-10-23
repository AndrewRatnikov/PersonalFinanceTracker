// No CONTRACT_GAPs: the /terms and /privacy routes, LegalDocument, LegalLinks
// and the content files are specified in plan section 11 and the Interface
// Contract. Nothing here mounts a QueryClientProvider, a vault or a session, so
// a page that needed any of them would throw. "While locked" is proven by
// computeGate in vaultSession.publicRoutes.test.ts. Link is mocked (no router).

import { cleanup, render, screen, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'

import type { Lang } from '@/i18n/lang'
import type { LegalDoc, LegalKind } from '@/lib/legal'
import { setLang, translate } from '@/i18n/core'
import { formatFullDate } from '@/i18n/format'
import { I18nProvider } from '@/i18n/react'
import { legalEn } from '@/content/legal/en'
import { legalUk } from '@/content/legal/uk'
import {
  LEGAL_CONTACT_EMAIL,
  LEGAL_LAST_UPDATED,
  LEGAL_OPERATOR_NAME,
  PRIVACY_PATH,
  TERMS_PATH,
} from '@/lib/legal'
import { legalDocumentFor } from '@/components/legal/LegalDocument'
import { Route as PrivacyRoute } from '@/routes/privacy'
import { Route as TermsRoute } from '@/routes/terms'

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string
    children?: ReactNode
    'data-testid'?: string
  }) => (
    <a href={to} data-testid={rest['data-testid']}>
      {children}
    </a>
  ),
}))

const CYRILLIC = /[Ѐ-ӿ]/

const ROUTES = {
  terms: { route: TermsRoute, page: 'terms-page' },
  privacy: { route: PrivacyRoute, page: 'privacy-page' },
} as const

function pageFor(kind: LegalKind, lang: Lang): ReactNode {
  const Page = ROUTES[kind].route.options.component
  if (!Page) throw new Error(`${kind} route has no component`)
  return (
    <I18nProvider initialLang={lang}>
      <Page />
    </I18nProvider>
  )
}

function textOf(doc: LegalDoc): string {
  return [
    doc.title,
    ...doc.intro,
    ...doc.sections.flatMap((s) => [s.heading, ...s.paragraphs, ...(s.bullets ?? [])]),
  ].join('\n')
}

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

const CASES: Array<[LegalKind, Lang]> = [
  ['terms', 'en'],
  ['terms', 'uk'],
  ['privacy', 'en'],
  ['privacy', 'uk'],
]

describe('legal pages render without a session', () => {
  it.each(CASES)('/%s in %s shows title, date, body and links', (kind, lang) => {
    render(pageFor(kind, lang))

    const page = screen.getByTestId(ROUTES[kind].page)
    const doc = legalDocumentFor(lang, kind)
    expect(within(page).getByTestId('legal-title').textContent).toBe(doc.title)
    expect(within(page).getByTestId('legal-body').textContent.length).toBeGreaterThan(500)
    expect(within(page).getByTestId('legal-links')).toBeTruthy()
  })

  it.each(CASES)('/%s in %s shows the Last updated date in that language', (kind, lang) => {
    render(pageFor(kind, lang))

    const expected = translate(lang, 'legal.lastUpdated', {
      date: formatFullDate(LEGAL_LAST_UPDATED, lang),
    })
    expect(screen.getByTestId('legal-last-updated').textContent).toBe(expected)
  })

  it('the Last updated line differs between en and uk', () => {
    render(pageFor('terms', 'en'))
    const en = screen.getByTestId('legal-last-updated').textContent
    cleanup()
    render(pageFor('terms', 'uk'))
    const uk = screen.getByTestId('legal-last-updated').textContent

    expect(en).toMatch(/Last updated/)
    expect(uk).not.toBe(en)
    expect(uk).toMatch(CYRILLIC)
  })

  it('titles are English in en and Cyrillic in uk', () => {
    render(pageFor('privacy', 'en'))
    expect(screen.getByTestId('legal-title').textContent).toBe('Privacy Policy')
    cleanup()
    render(pageFor('privacy', 'uk'))
    const ukPrivacy = screen.getByTestId('legal-title').textContent
    expect(ukPrivacy).toMatch(CYRILLIC)
    expect(ukPrivacy).not.toBe('Privacy Policy')
    cleanup()

    render(pageFor('terms', 'en'))
    expect(screen.getByTestId('legal-title').textContent).toBe('Terms of Use')
    cleanup()
    render(pageFor('terms', 'uk'))
    const ukTerms = screen.getByTestId('legal-title').textContent
    expect(ukTerms).toMatch(CYRILLIC)
    expect(ukTerms).not.toBe(ukPrivacy)
  })

  it.each(CASES)('/%s in %s renders every section of the content file', (kind, lang) => {
    render(pageFor(kind, lang))

    const doc = legalDocumentFor(lang, kind)
    const body = screen.getByTestId('legal-body')
    const headings = Array.from(body.querySelectorAll('h2')).map((h) => h.textContent)
    expect(headings).toEqual(doc.sections.map((s) => s.heading))
    const bullets = body.querySelectorAll('li').length
    expect(bullets).toBe(doc.sections.reduce((n, s) => n + (s.bullets?.length ?? 0), 0))
    for (const line of doc.intro) expect(body.textContent).toContain(line)
  })

  it('links to the other legal page and to Terms and Privacy under the document', () => {
    render(pageFor('terms', 'en'))

    const links = screen.getByTestId('legal-links')
    expect(within(links).getByTestId('legal-terms-link').getAttribute('href')).toBe('/terms')
    expect(within(links).getByTestId('legal-privacy-link').getAttribute('href')).toBe('/privacy')
  })
})

describe('legal pages are server-rendered', () => {
  it.each(CASES)('/%s in %s renders to a string with its content', (kind, lang) => {
    const html = renderToString(pageFor(kind, lang))

    expect(html).toContain(`data-testid="${ROUTES[kind].page}"`)
    expect(html).toContain('data-testid="legal-title"')
    expect(html).toContain('data-testid="legal-last-updated"')
    expect(html).toContain('data-testid="legal-body"')
    expect((html.match(/<h2/g) ?? []).length).toBe(
      legalDocumentFor(lang, kind).sections.length,
    )
    if (lang === 'uk') expect(html).toMatch(CYRILLIC)
  })

  it('the uk page has no English title text and the en page has no Cyrillic title', () => {
    const uk = renderToString(pageFor('privacy', 'uk'))
    const en = renderToString(pageFor('privacy', 'en'))

    expect(uk).not.toContain('>Privacy Policy<')
    expect(en).toContain('>Privacy Policy<')
    expect(en).not.toContain(legalUk.privacy.title)
  })
})

describe('legalDocumentFor', () => {
  it('picks the document by language and kind', () => {
    expect(legalDocumentFor('en', 'terms')).toBe(legalEn.terms)
    expect(legalDocumentFor('en', 'privacy')).toBe(legalEn.privacy)
    expect(legalDocumentFor('uk', 'terms')).toBe(legalUk.terms)
    expect(legalDocumentFor('uk', 'privacy')).toBe(legalUk.privacy)
    expect(legalEn.terms).not.toBe(legalUk.terms)
  })
})

describe('legal constants', () => {
  it('has the public paths and a date', () => {
    expect(TERMS_PATH).toBe('/terms')
    expect(PRIVACY_PATH).toBe('/privacy')
    expect(LEGAL_LAST_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(LEGAL_OPERATOR_NAME.length).toBeGreaterThan(0)
    expect(LEGAL_CONTACT_EMAIL).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)
  })
})

describe('legal content (criterion 30)', () => {
  it.each([
    ['en terms', legalEn.terms],
    ['en privacy', legalEn.privacy],
    ['uk terms', legalUk.terms],
    ['uk privacy', legalUk.privacy],
  ])('%s carries the last-updated date, the operator and the contact', (_name, doc) => {
    expect(doc.lastUpdated).toBe(LEGAL_LAST_UPDATED)
    expect(doc.sections.length).toBeGreaterThan(3)
    const text = textOf(doc)
    expect(text).toContain(LEGAL_CONTACT_EMAIL)
    expect(text).toContain(LEGAL_OPERATOR_NAME)
    for (const section of doc.sections) {
      expect(section.id.length).toBeGreaterThan(0)
      expect(section.heading.length).toBeGreaterThan(0)
    }
  })

  it('the English privacy policy names the processors and the recovery key', () => {
    const text = textOf(legalEn.privacy)
    for (const word of ['Supabase', 'Vercel', 'Google', 'NBU', 'recovery key']) {
      expect(text, word).toContain(word)
    }
  })

  it('the English privacy policy covers analytics, selling, offline attacks and IP addresses', () => {
    const text = textOf(legalEn.privacy)
    expect(text).toMatch(/analytics/i)
    expect(text).toMatch(/\bsell/i)
    expect(text).toMatch(/offline/i)
    expect(text).toMatch(/IP address/i)
  })

  it('the English terms mention 30 days notice', () => {
    expect(textOf(legalEn.terms)).toContain('30 days')
  })

  it('the Ukrainian privacy policy names the processors', () => {
    const text = textOf(legalUk.privacy)
    for (const word of ['Supabase', 'Vercel', 'Google', 'НБУ']) {
      expect(text, word).toContain(word)
    }
  })

  it('the Ukrainian documents are in Ukrainian and match the English structure', () => {
    for (const kind of ['terms', 'privacy'] as const) {
      const uk = legalUk[kind]
      const en = legalEn[kind]
      expect(uk.title).toMatch(CYRILLIC)
      expect(uk.title).not.toBe(en.title)
      expect(uk.sections.map((s) => s.id)).toEqual(en.sections.map((s) => s.id))
      expect(uk.sections.map((s) => (s.bullets ?? []).length)).toEqual(
        en.sections.map((s) => (s.bullets ?? []).length),
      )
      for (const section of uk.sections) expect(section.heading).toMatch(CYRILLIC)
      expect(textOf(uk)).not.toBe(textOf(en))
    }
  })

  it('terms and privacy are different documents', () => {
    expect(legalEn.terms.title).not.toBe(legalEn.privacy.title)
    expect(textOf(legalEn.terms)).not.toBe(textOf(legalEn.privacy))
  })
})
