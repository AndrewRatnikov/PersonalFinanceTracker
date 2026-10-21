// CONTRACT_GAP: the exact layout of a review row (spacing, backticks around the
// key) and the wording of the intro line are not fixed by the Interface
// Contract, so rows are located by their key and checked for the English and
// Ukrainian cells they must contain. The committed docs/i18n/uk-review.md is
// read from the real repo file on purpose: the plan's verification compares it
// with the generated table.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { catalogKeys } from '@/i18n/core'
import { en } from '@/i18n/messages/en'
import { uk } from '@/i18n/messages/uk'
import { REVIEW_FILE, buildReviewMarkdown, flattenCatalog } from '@/i18n/review'

const SAMPLE_EN = {
  a: {
    x: 'Hello | pipe',
    y: { one: '{count} item', other: '{count} items' },
  },
  z: 'Line1\nLine2',
}

const SAMPLE_UK = {
  a: {
    x: 'Привіт | труба',
    y: {
      one: '{count} штука',
      few: '{count} штуки',
      many: '{count} штук',
      other: '{count} штуки',
    },
  },
  z: 'Рядок1\nРядок2',
}

function rowFor(markdown: string, key: string): string {
  const row = markdown.split('\n').find((line) => line.includes(key))
  if (row === undefined) throw new Error(`no row for ${key}`)
  return row
}

const sortedEntries = (entries: Array<[string, string]>) =>
  [...entries].sort(([a], [b]) => a.localeCompare(b))

describe('REVIEW_FILE', () => {
  it('is the committed review table path', () => {
    expect(REVIEW_FILE).toBe('docs/i18n/uk-review.md')
  })
})

describe('flattenCatalog', () => {
  it('lists every leaf with a dotted key and expands plural forms', () => {
    expect(sortedEntries(flattenCatalog(SAMPLE_UK))).toEqual(
      sortedEntries([
        ['a.x', 'Привіт | труба'],
        ['a.y.one', '{count} штука'],
        ['a.y.few', '{count} штуки'],
        ['a.y.many', '{count} штук'],
        ['a.y.other', '{count} штуки'],
        ['z', 'Рядок1\nРядок2'],
      ]),
    )
    expect(sortedEntries(flattenCatalog(SAMPLE_EN))).toEqual(
      sortedEntries([
        ['a.x', 'Hello | pipe'],
        ['a.y.one', '{count} item'],
        ['a.y.other', '{count} items'],
        ['z', 'Line1\nLine2'],
      ]),
    )
  })

  it('flattens the real catalogs: every key of the catalog is covered', () => {
    const flat = flattenCatalog(uk).map(([key]) => key)

    for (const key of catalogKeys(uk)) {
      expect(flat.some((f) => f === key || f.startsWith(`${key}.`)), key).toBe(true)
    }
    expect(flat).toContain('records.few')
    expect(flat).toContain('records.many')
    expect(new Set(flat).size).toBe(flat.length)
  })
})

describe('buildReviewMarkdown', () => {
  const markdown = buildReviewMarkdown(SAMPLE_EN, SAMPLE_UK)

  it('has the table header and ends with a newline', () => {
    expect(markdown).toContain('| Key | English | Ukrainian |')
    expect(markdown.endsWith('\n')).toBe(true)
  })

  it('has one row per Ukrainian key', () => {
    for (const key of ['a.x', 'a.y.one', 'a.y.few', 'a.y.many', 'a.y.other', 'z']) {
      expect(markdown, key).toContain(key)
    }
    const rows = markdown.split('\n').filter((line) => /^\|.*\|$/.test(line.trim()))
    // header, separator and six data rows
    expect(rows.length).toBe(8)
  })

  it('puts the English and Ukrainian text of a key in its row', () => {
    const row = rowFor(markdown, 'a.y.one')

    expect(row).toContain('{count} item')
    expect(row).toContain('{count} штука')
  })

  it('shows the English "other" form for a Ukrainian form English does not have', () => {
    const few = rowFor(markdown, 'a.y.few')
    const many = rowFor(markdown, 'a.y.many')

    expect(few).toContain('{count} items')
    expect(few).toContain('{count} штуки')
    expect(many).toContain('{count} items')
    expect(many).toContain('{count} штук')
  })

  it('escapes pipes and turns newlines into <br>', () => {
    expect(rowFor(markdown, 'a.x')).toContain('Hello \\| pipe')
    expect(rowFor(markdown, 'a.x')).toContain('Привіт \\| труба')
    const row = rowFor(markdown, 'Line1<br>Line2')
    expect(row).toContain('Line1<br>Line2')
    expect(row).toContain('Рядок1<br>Рядок2')
    expect(markdown).not.toContain('Line1\nLine2')
  })

  it('is deterministic and follows its input', () => {
    expect(buildReviewMarkdown(SAMPLE_EN, SAMPLE_UK)).toBe(markdown)
    expect(buildReviewMarkdown(SAMPLE_EN, { ...SAMPLE_UK, z: 'Інше' })).not.toBe(markdown)
  })
})

describe('docs/i18n/uk-review.md', () => {
  const committed = readFileSync(resolve(process.cwd(), REVIEW_FILE), 'utf8')

  it('is exactly the generated table (run npm run i18n:review)', () => {
    expect(committed).toBe(buildReviewMarkdown(en, uk))
  })

  it('lists every message key', () => {
    for (const key of catalogKeys(uk)) {
      expect(committed, key).toContain(key)
    }
  })

  it('lists the plural forms of records', () => {
    for (const form of ['one', 'few', 'many', 'other']) {
      expect(committed).toContain(`records.${form}`)
    }
  })
})
