// CONTRACT_GAP: whether a literal inside a ?: or ?? / || expression is reported
// once per literal or once per attribute is not fixed by the Interface Contract,
// so those cases assert "at least one finding, all of kind attribute".
// scanUntranslatedText walks the file system by design; its exclusion rules are
// checked on a throw-away directory under the OS temp dir, and the real
// codebase is scanned from src as the plan requires.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { findUntranslatedText, scanUntranslatedText } from './untranslatedText'

const component = (body: string) => `export const X = () => (\n  <div>${body}</div>\n)\n`

describe('findUntranslatedText: JSX text', () => {
  it('reports <p>Hello</p>', () => {
    const found = findUntranslatedText('export const X = () => <p>Hello</p>')

    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('jsx-text')
    expect(found[0].text).toContain('Hello')
    expect(found[0].line).toBe(1)
    expect(found[0].file).toBe('inline.tsx')
  })

  it('reports the file name and the line of the text', () => {
    const source = 'import x from "y"\n\nexport const X = () => (\n  <section>\n    <p>Hello</p>\n  </section>\n)\n'

    const found = findUntranslatedText(source, 'Foo.tsx')

    expect(found).toHaveLength(1)
    expect(found[0].file).toBe('Foo.tsx')
    expect(found[0].line).toBe(5)
  })

  it('reports each untranslated text', () => {
    const found = findUntranslatedText(component('<p>One</p><p>Two</p><b>Three</b>'))

    expect(found.map((f) => f.text.trim()).sort()).toEqual(['One', 'Three', 'Two'])
  })

  it('reports Ukrainian text too: it must come from the catalog', () => {
    expect(findUntranslatedText(component('<p>Привіт</p>'))).toHaveLength(1)
  })

  it('reports text that mixes an allowed word with other words', () => {
    expect(findUntranslatedText(component('<p>MinimaSpend is great</p>'))).toHaveLength(1)
    expect(findUntranslatedText(component('<p>Pay in UAH today</p>'))).toHaveLength(1)
  })

  it.each([
    ['the brand', '<span>MinimaSpend</span>'],
    ['a currency code UAH', '<span>UAH</span>'],
    ['a currency code USD', '<span>USD</span>'],
    ['a currency code EUR', '<span>EUR</span>'],
    ['emoji and punctuation', '<span>🍔 — ·</span>'],
    ['digits and symbols', '<span>12:30 / 4 %</span>'],
    ['whitespace', '<span> </span>'],
    ['an expression', '<span>{count}</span>'],
    ['a translated call', "<span>{t('dashboard.title')}</span>"],
    ['no text', '<span />'],
  ])('does not report %s', (_name, body) => {
    expect(findUntranslatedText(component(body))).toEqual([])
  })
})

describe('findUntranslatedText: attributes', () => {
  it.each(['aria-label', 'placeholder', 'title', 'alt'])(
    'reports a string literal in %s',
    (attribute) => {
      const found = findUntranslatedText(component(`<img ${attribute}="Close" />`))

      expect(found).toHaveLength(1)
      expect(found[0].kind).toBe('attribute')
      expect(found[0].text).toContain('Close')
    },
  )

  it('reports a string literal inside an expression container', () => {
    const found = findUntranslatedText(component("<button aria-label={'Close'} />"))

    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('attribute')
  })

  it('reports literals in conditional branches', () => {
    const found = findUntranslatedText(
      component("<button aria-label={open ? 'Hide' : 'Show'} />"),
    )

    expect(found.length).toBeGreaterThan(0)
    expect(found.every((f) => f.kind === 'attribute')).toBe(true)
  })

  it('reports the right side of ?? and ||', () => {
    for (const operator of ['??', '||']) {
      const found = findUntranslatedText(
        component(`<input placeholder={name ${operator} 'Name'} />`),
      )

      expect(found.length, operator).toBeGreaterThan(0)
      expect(found.every((f) => f.kind === 'attribute')).toBe(true)
    }
  })

  it('reports a template whose literal parts contain letters', () => {
    const found = findUntranslatedText(
      component('<button aria-label={`Close ${name}`} />'),
    )

    expect(found.length).toBeGreaterThan(0)
    expect(found[0].kind).toBe('attribute')
  })

  it('reports a no-substitution template literal', () => {
    expect(
      findUntranslatedText(component('<button title={`Close`} />')).length,
    ).toBeGreaterThan(0)
  })

  it.each([
    ['a translated call', "<button aria-label={t('common.close')} />"],
    ['a variable', '<button aria-label={label} />'],
    ['a template without letters', '<button aria-label={`${count}`} />'],
    ['digits', '<button aria-label="123" />'],
    ['the brand', '<button aria-label="MinimaSpend" />'],
    ['a currency code', '<button title="UAH" />'],
    ['an unrelated attribute', '<button className="btn primary" type="button" id="x" />'],
    ['a link target', '<a href="/settings">{t("nav.settings")}</a>'],
  ])('does not report %s', (_name, body) => {
    expect(findUntranslatedText(component(body))).toEqual([])
  })
})

describe('findUntranslatedText: toast', () => {
  it.each([
    "toast.success('Saved')",
    "toast.error('Oops')",
    "toast('Hello there')",
    "toast.info('Heads up')",
    'toast.error(`Failed: ${message}`)',
  ])('reports %s', (call) => {
    const found = findUntranslatedText(`export function f() {\n  ${call}\n}\n`)

    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('toast')
    expect(found[0].line).toBe(2)
  })

  it.each([
    "toast.success(t('toasts.saved'))",
    'toast.error(message)',
    "toast.success(plural('toasts.recurringCreated', 3))",
    "notToast('Hello')",
    "console.log('Hello')",
    "const label = 'Hello'",
  ])('does not report %s', (code) => {
    expect(findUntranslatedText(`export function f() {\n  ${code}\n}\n`)).toEqual([])
  })
})

describe('findUntranslatedText: a clean component', () => {
  it('passes', () => {
    const source = `
import { useT } from '@/i18n'
export function Clean({ count }: { count: number }) {
  const { t } = useT()
  return (
    <section aria-label={t('common.loading')} className="p-4">
      <h1>{t('dashboard.title')}</h1>
      <span>MinimaSpend</span>
      <span>{count} UAH</span>
    </section>
  )
}
`

    expect(findUntranslatedText(source, 'Clean.tsx')).toEqual([])
  })
})

describe('scanUntranslatedText', () => {
  const dirs: Array<string> = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function makeTree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'untranslated-'))
    dirs.push(root)
    for (const [relative, content] of Object.entries(files)) {
      const full = join(root, relative)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content)
    }
    return root
  }

  it('finds problems in nested .tsx files and reports paths relative to the root', () => {
    const root = makeTree({
      'routes/Bad.tsx': 'export const A = () => <p>Hello</p>',
      'components/Deep/Worse.tsx': 'export const B = () => <button title="Close" />',
      'components/Clean.tsx': "export const C = () => <p>{t('x')}</p>",
    })

    const found = scanUntranslatedText(root)

    expect(found.map((f) => f.file).sort()).toEqual([
      join('components', 'Deep', 'Worse.tsx'),
      join('routes', 'Bad.tsx'),
    ])
  })

  it('skips test files, non-tsx files and anything under components/ui', () => {
    const root = makeTree({
      'routes/Bad.test.tsx': 'export const A = () => <p>Hello</p>',
      'components/ui/Button.tsx': 'export const B = () => <p>Hello</p>',
      'lib/text.ts': "export const hello = 'Hello'",
      'routes/Good.tsx': 'export const D = () => <p>MinimaSpend</p>',
    })

    expect(scanUntranslatedText(root)).toEqual([])
  })

  it('an empty directory has nothing to report', () => {
    expect(scanUntranslatedText(makeTree({}))).toEqual([])
  })

  it(
    'the real codebase has no untranslated text',
    () => {
      const found = scanUntranslatedText(resolve('src'))

      expect(found.map((f) => `${f.file}:${f.line} [${f.kind}] ${f.text.trim()}`)).toEqual([])
    },
    60_000,
  )
})
