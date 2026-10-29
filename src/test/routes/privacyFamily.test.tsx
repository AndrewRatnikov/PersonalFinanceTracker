// No CONTRACT_GAPs: the privacy section id `family-space`, its position after
// `sync`, its four bullets and the new last-updated date are specified in plan
// section E. The page is rendered the way legal.test.tsx does it (Link is
// mocked, no router, no session).

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'

import type { Lang } from '@/i18n/lang'
import type { LegalSection } from '@/lib/legal'
import { setLang, translate } from '@/i18n/core'
import { formatFullDate } from '@/i18n/format'
import { I18nProvider } from '@/i18n/react'
import { legalEn } from '@/content/legal/en'
import { legalUk } from '@/content/legal/uk'
import { LEGAL_LAST_UPDATED } from '@/lib/legal'
import { legalDocumentFor } from '@/components/legal/LegalDocument'
import { Route as PrivacyRoute } from '@/routes/privacy'

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

function privacyPage(lang: Lang): ReactNode {
  const Page = PrivacyRoute.options.component
  if (!Page) throw new Error('privacy route has no component')
  return (
    <I18nProvider initialLang={lang}>
      <Page />
    </I18nProvider>
  )
}

function familySection(lang: Lang): LegalSection {
  const section = legalDocumentFor(lang, 'privacy').sections.find((s) => s.id === 'family-space')
  if (!section) throw new Error(`no family-space section in ${lang}`)
  return section
}

afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

const LANGS: Array<Lang> = ['en', 'uk']

describe('the Family space section is on /privacy (criterion 17)', () => {
  it.each(LANGS)('%s: the heading and every bullet are rendered in the page body', (lang) => {
    render(privacyPage(lang))

    const section = familySection(lang)
    const body = screen.getByTestId('legal-body')
    const headings = Array.from(body.querySelectorAll('h2')).map((h) => h.textContent)
    expect(headings).toContain(section.heading)
    expect(body.textContent).toContain(section.heading)
    expect(section.bullets).toHaveLength(4)
    for (const bullet of section.bullets ?? []) expect(body.textContent).toContain(bullet)
    for (const paragraph of section.paragraphs) expect(body.textContent).toContain(paragraph)
    expect(section.paragraphs.length).toBeGreaterThan(0)
  })

  it.each(LANGS)('%s: the bullets appear in the planned order', (lang) => {
    render(privacyPage(lang))
    const text = screen.getByTestId('legal-body').textContent
    const bullets = familySection(lang).bullets ?? []
    const positions = bullets.map((b) => text.indexOf(b))
    for (const p of positions) expect(p).toBeGreaterThan(-1)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it.each(LANGS)('%s: the section sits right after the sync section', (lang) => {
    const ids = legalDocumentFor(lang, 'privacy').sections.map((s) => s.id)
    const at = ids.indexOf('sync')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(ids[at + 1]).toBe('family-space')
    expect(ids.filter((id) => id === 'family-space')).toHaveLength(1)
  })

  it('the rendered bullet count equals the content file (the four are really list items)', () => {
    render(privacyPage('en'))
    const body = screen.getByTestId('legal-body')
    const items = Array.from(body.querySelectorAll('li')).map((li) => li.textContent)
    for (const bullet of familySection('en').bullets ?? []) expect(items).toContain(bullet)
  })
})

describe('what the English section says', () => {
  const text = () => {
    const s = familySection('en')
    return [s.heading, ...s.paragraphs, ...(s.bullets ?? [])].join('\n')
  }

  it('names the Family space, emails, removed members and deleting the space', () => {
    expect(text()).toMatch(/Family space/i)
    expect(text()).toMatch(/email/i)
    expect(text()).toMatch(/removed/i)
    expect(text()).toMatch(/deleting the space/i)
  })

  it('says who sees what, bullet by bullet', () => {
    const bullets = familySection('en').bullets ?? []
    // 1. accounts, roles, emails (shown to the other members), who wrote each record.
    expect(bullets[0]).toMatch(/email/i)
    expect(bullets[0]).toMatch(/role/i)
    expect(bullets[0]).toMatch(/wrote|author|written/i)
    // 2. encrypted with a key only the members hold.
    expect(bullets[1]).toMatch(/encrypt/i)
    expect(bullets[1]).toMatch(/never/i)
    // 3. a removed member keeps what is on their devices but gets nothing new.
    expect(bullets[2]).toMatch(/removed/i)
    expect(bullets[2]).toMatch(/nothing new|no new|new/i)
    // 4. deleting the space removes it from the server.
    expect(bullets[3]).toMatch(/deleting the space/i)
    expect(bullets[3]).toMatch(/server/i)
  })

  it('the bullets are four different statements', () => {
    const bullets = familySection('en').bullets ?? []
    expect(new Set(bullets).size).toBe(4)
  })

  it('does not claim the server can read the content', () => {
    expect(text()).not.toMatch(/server (?:can|may) (?:read|decrypt)/i)
  })
})

describe('the Ukrainian section', () => {
  it('has a Cyrillic heading, a Cyrillic body and the same shape as English', () => {
    const uk = familySection('uk')
    const en = familySection('en')
    expect(uk.heading).toMatch(CYRILLIC)
    expect(uk.heading).not.toBe(en.heading)
    expect(uk.bullets).toHaveLength(en.bullets?.length ?? -1)
    for (const bullet of uk.bullets ?? []) expect(bullet).toMatch(CYRILLIC)
    for (const paragraph of uk.paragraphs) expect(paragraph).toMatch(CYRILLIC)
    expect((uk.bullets ?? []).join('\n')).not.toBe((en.bullets ?? []).join('\n'))
  })

  it('the uk and en privacy documents keep the same section ids and bullet counts', () => {
    expect(legalUk.privacy.sections.map((s) => s.id)).toEqual(
      legalEn.privacy.sections.map((s) => s.id),
    )
    expect(legalUk.privacy.sections.map((s) => (s.bullets ?? []).length)).toEqual(
      legalEn.privacy.sections.map((s) => (s.bullets ?? []).length),
    )
  })

  it('every uk heading is Cyrillic', () => {
    for (const section of legalUk.privacy.sections) expect(section.heading).toMatch(CYRILLIC)
  })
})

describe('Last updated (criterion 17)', () => {
  it('is 2026-10-29 and both privacy documents carry it', () => {
    expect(LEGAL_LAST_UPDATED).toBe('2026-10-29')
    expect(legalEn.privacy.lastUpdated).toBe('2026-10-29')
    expect(legalUk.privacy.lastUpdated).toBe('2026-10-29')
  })

  it.each(LANGS)('%s: the page shows the new date in that language', (lang) => {
    render(privacyPage(lang))
    const expected = translate(lang, 'legal.lastUpdated', {
      date: formatFullDate('2026-10-29', lang),
    })
    expect(screen.getByTestId('legal-last-updated').textContent).toBe(expected)
    expect(screen.getByTestId('privacy-page')).toBeTruthy()
    expect(screen.getByTestId('legal-title')).toBeTruthy()
  })

  it('the en and uk date lines differ', () => {
    render(privacyPage('en'))
    const en = screen.getByTestId('legal-last-updated').textContent
    cleanup()
    render(privacyPage('uk'))
    const uk = screen.getByTestId('legal-last-updated').textContent
    expect(uk).not.toBe(en)
    expect(uk).toMatch(CYRILLIC)
  })
})
