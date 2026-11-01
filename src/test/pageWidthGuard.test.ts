// @vitest-environment node
// No CONTRACT_GAPs: the guard rule, samples and scanned files come from the
// Interface Contract (Guard test). Mirrors chartColourGuard.test.ts.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// Skips the tag name, then walks the attributes to the closing `>`, ignoring
// any `>` inside braces or quotes (e.g. `onClick={() => x}`).
function openingTagAt(source: string, start: number): string {
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (depth === 0 && (ch === '"' || ch === "'")) quote = ch
    else if (depth === 0 && ch === '>') return source.slice(start, i + 1)
  }
  return source.slice(start)
}

// For every <PageShell>, the next JSX opening tag must be <PageContainer, and
// its own attributes must not set max-w-*. Deeper elements may use max-w-*.
function findPageWidthViolations(source: string): Array<string> {
  const found: Array<string> = []
  const shell = /<PageShell(?=[\s>])/g
  let match: RegExpExecArray | null
  while ((match = shell.exec(source)) !== null) {
    const shellTag = openingTagAt(source, match.index)
    const afterShell = match.index + shellTag.length
    const next = /<([A-Za-z][\w.]*)/.exec(source.slice(afterShell))
    if (!next) {
      found.push('PageShell has no child element')
      continue
    }
    if (next[1] !== 'PageContainer') {
      found.push(`first child of PageShell is <${next[1]}>, not <PageContainer>`)
      continue
    }
    const tag = openingTagAt(source, afterShell + next.index)
    if (tag.includes('max-w-')) found.push(`PageContainer sets ${tag.match(/max-w-[\w[\]./-]+/)?.[0]}`)
  }
  return found
}

const root = process.cwd()
const read = (file: string) => readFileSync(join(root, file), 'utf8')

const EXCLUDED_ROUTES = ['login.tsx', 'join.tsx', '__root.tsx', 'auth.callback.tsx']
const routeFiles = readdirSync(join(root, 'src', 'routes'))
  .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx') && !EXCLUDED_ROUTES.includes(f))
  .map((f) => `src/routes/${f}`)
const scanned = [...routeFiles, 'src/components/NotFoundPage.tsx']

const IMPORTS_PAGE_CONTAINER =
  /from\s+['"](?:@\/components\/|\.\.\/components\/|\.\/)PageContainer['"]/

describe('findPageWidthViolations', () => {
  it('flags an outer wrapper with its own max-w', () => {
    const sample = `<PageShell><div className="max-w-xl mx-auto px-4 pt-6">x</div></PageShell>`
    expect(findPageWidthViolations(sample).length).toBeGreaterThan(0)
  })

  it('flags a PageContainer that sets max-w itself', () => {
    const sample = `<PageShell><PageContainer className="max-w-xl">x</PageContainer></PageShell>`
    expect(findPageWidthViolations(sample).length).toBeGreaterThan(0)
  })

  it('passes a PageContainer with an inner max-w element', () => {
    const sample = `<PageShell>
      <PageContainer data-testid="x"><div className="max-w-xl">x</div></PageContainer>
    </PageShell>`
    expect(findPageWidthViolations(sample)).toEqual([])
  })

  it('passes width="reading" and a vertical className', () => {
    expect(
      findPageWidthViolations(
        `<PageShell><PageContainer width="reading" className="py-4 md:py-8">x</PageContainer></PageShell>`,
      ),
    ).toEqual([])
  })

  it('is not fooled by a > inside an attribute expression', () => {
    const bad = `<PageShell><PageContainer onClick={() => go()} className="max-w-3xl">x</PageContainer></PageShell>`
    const good = `<PageShell><PageContainer onClick={() => go()} className="flex">x<div className="max-w-3xl" /></PageContainer></PageShell>`
    expect(findPageWidthViolations(bad).length).toBeGreaterThan(0)
    expect(findPageWidthViolations(good)).toEqual([])
  })

  it('checks every PageShell in a file', () => {
    const sample = `
      <PageShell><PageContainer>a</PageContainer></PageShell>
      <PageShell><div className="max-w-xl">b</div></PageShell>`
    expect(findPageWidthViolations(sample).length).toBe(1)
  })

  it('passes a source without PageShell', () => {
    expect(findPageWidthViolations(`<div className="max-w-sm">x</div>`)).toEqual([])
  })
})

describe('page width guard on the codebase', () => {
  it('actually scans the pages (non-vacuous)', () => {
    for (const file of [
      'src/routes/index.tsx',
      'src/routes/analytics.tsx',
      'src/routes/recurring.tsx',
      'src/routes/settings.tsx',
      'src/routes/transactions.tsx',
      'src/routes/income.tsx',
      'src/routes/profile.tsx',
      'src/routes/terms.tsx',
      'src/routes/privacy.tsx',
      'src/components/NotFoundPage.tsx',
    ]) {
      expect(scanned, file).toContain(file)
    }
    for (const file of ['login.tsx', 'join.tsx', '__root.tsx', 'auth.callback.tsx']) {
      expect(scanned).not.toContain(`src/routes/${file}`)
    }
    expect(scanned.filter((f) => f.includes('.test.'))).toEqual([])
  })

  it.each(scanned)('%s wraps its PageShell content in PageContainer without a max-w', (file) => {
    const source = read(file)
    expect(source).toMatch(/<PageShell(?=[\s>])/)
    expect(findPageWidthViolations(source)).toEqual([])
    expect(source).toMatch(IMPORTS_PAGE_CONTAINER)
  })

  it('PageShell itself sets no max-w', () => {
    expect(read('src/components/PageShell.tsx')).not.toContain('max-w-')
  })
})

describe('static route coverage', () => {
  it('only Terms and Privacy use the reading width', () => {
    expect(read('src/routes/terms.tsx')).toContain('width="reading"')
    expect(read('src/routes/privacy.tsx')).toContain('width="reading"')
    const others = scanned.filter((f) => !/\/(terms|privacy)\.tsx$/.test(f))
    expect(others.length).toBeGreaterThan(5)
    for (const file of others) expect(read(file), file).not.toContain('width="reading"')
  })

  it('Login, Join and the Join page keep their own layout', () => {
    for (const file of ['src/routes/login.tsx', 'src/routes/join.tsx', 'src/components/JoinPage.tsx']) {
      expect(existsSync(join(root, file)), file).toBe(true)
      expect(read(file), file).not.toContain('PageContainer')
    }
  })

  it('Header and SpaceBanner share PAGE_FRAME_CLASS', () => {
    expect(read('src/components/Header.tsx')).toContain('PAGE_FRAME_CLASS')
    expect(read('src/components/space/SpaceBanner.tsx')).toContain('PAGE_FRAME_CLASS')
  })
})
