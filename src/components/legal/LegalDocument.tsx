import type { Lang } from '@/i18n'
import type { LegalDoc, LegalKind } from '@/lib/legal'
import { useT } from '@/i18n'
import { formatFullDate } from '@/i18n/format'
import { legalEn } from '@/content/legal/en'
import { legalUk } from '@/content/legal/uk'
import { LegalLinks } from '@/components/LegalLinks'

export function legalDocumentFor(lang: Lang, kind: LegalKind): LegalDoc {
  return (lang === 'uk' ? legalUk : legalEn)[kind]
}

// One legal document (Terms of Use or Privacy Policy) in the interface
// language. Reads no data, vault or session, so it renders on the server and
// while the vault is locked.
export function LegalDocument({ kind }: { kind: LegalKind }) {
  const { lang, t } = useT()
  const doc = legalDocumentFor(lang, kind)

  return (
    <>
      <article className="flex flex-col gap-6 pb-8">
        <header className="flex flex-col gap-2">
          <h1
            data-testid="legal-title"
            className="text-3xl font-bold tracking-tight"
          >
            {doc.title}
          </h1>
          <p
            data-testid="legal-last-updated"
            className="text-sm text-muted-foreground"
          >
            {t('legal.lastUpdated', {
              date: formatFullDate(doc.lastUpdated, lang),
            })}
          </p>
        </header>
        <div
          data-testid="legal-body"
          className="flex flex-col gap-6 leading-relaxed"
        >
          {doc.intro.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
          {doc.sections.map((section) => (
            <section
              key={section.id}
              id={section.id}
              className="flex flex-col gap-3"
            >
              <h2 className="text-xl font-semibold">{section.heading}</h2>
              {section.paragraphs.map((paragraph, i) => (
                <p key={i}>{paragraph}</p>
              ))}
              {section.bullets && (
                <ul className="list-disc flex flex-col gap-1 pl-6">
                  {section.bullets.map((bullet, i) => (
                    <li key={i}>{bullet}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </article>
      <LegalLinks className="border-t border-border pt-4" />
    </>
  )
}
