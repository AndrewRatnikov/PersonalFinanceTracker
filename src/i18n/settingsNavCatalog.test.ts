// CONTRACT_GAP: the uk wording of keys other than the glossary terms is free
//   (the plan says the Coder may polish it); they are only checked to exist, to
//   be non-empty, to differ from the English text and to keep the placeholders.
// CONTRACT_GAP: the English descriptions are asserted verbatim as the plan's
//   Strings section gives them, except that the General description must not
//   mention auto-lock (it lives in Security).
// CONTRACT_GAP: reading docs/i18n/glossary.md uses node:fs, like
//   familyUxCatalog.test.ts.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { translate } from '@/i18n/core'
import { en } from '@/i18n/messages/en'
import { uk } from '@/i18n/messages/uk'

function lookup(catalog: unknown, key: string): unknown {
  let node: unknown = catalog
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

function placeholders(text: string): Array<string> {
  return Array.from(text.matchAll(/\{(\w+)\}/g))
    .map((m) => m[1])
    .sort()
}

function norm(text: string): string {
  return text.replace(/[’ʼ`]/g, "'")
}

const IDS = [
  'general',
  'categories',
  'budget',
  'security',
  'data',
  'account',
  'sync',
  'family',
] as const

const NEW_KEYS = [
  'settings.groups.budget',
  'settings.groups.budgetFor',
  'settings.groups.device',
  'settings.groups.cloud',
  ...IDS.map((id) => `settings.descriptions.${id}`),
  'settings.nav.label',
  'settings.nav.back',
]

const EN_EXACT: Record<string, string> = {
  'settings.groups.budget': 'Budget',
  'settings.groups.budgetFor': 'Budget · {name}',
  'settings.groups.device': 'This device',
  'settings.groups.cloud': 'Account & cloud',
  'settings.nav.label': 'Settings sections',
  'settings.nav.back': 'Back to settings',
}

const GLOSSARY_UK: Record<string, string> = {
  'settings.groups.device': 'Цей пристрій',
  'settings.groups.cloud': 'Обліковий запис і хмара',
}

describe('the new settings navigation keys', () => {
  it.each(NEW_KEYS)('%s is a non-empty string in en and uk', (key) => {
    for (const catalog of [en, uk]) {
      const value = lookup(catalog, key)
      expect(typeof value).toBe('string')
      expect((value as string).trim().length).toBeGreaterThan(0)
    }
  })

  it.each(NEW_KEYS)('%s keeps the same placeholders in uk and en', (key) => {
    expect(placeholders(lookup(uk, key) as string)).toEqual(placeholders(lookup(en, key) as string))
  })

  it.each(NEW_KEYS)('uk %s is translated, not the English text', (key) => {
    expect(lookup(uk, key)).not.toBe(lookup(en, key))
  })

  it.each(Object.entries(EN_EXACT))('en %s is "%s"', (key, text) => {
    expect(lookup(en, key)).toBe(text)
  })

  it('the Budget header takes the space name', () => {
    expect(placeholders(lookup(en, 'settings.groups.budgetFor') as string)).toEqual(['name'])
    expect(translate('en', 'settings.groups.budgetFor', { name: 'Home' })).toBe('Budget · Home')
    expect(translate('en', 'settings.groups.budgetFor', { name: 'Cabin' })).toBe('Budget · Cabin')
    expect(translate('uk', 'settings.groups.budgetFor', { name: 'Home' })).toContain('Home')
  })

  it('each of the eight sections has its own description', () => {
    const descriptions = IDS.map((id) => lookup(en, `settings.descriptions.${id}`) as string)
    expect(new Set(descriptions).size).toBe(IDS.length)
    const ukDescriptions = IDS.map((id) => lookup(uk, `settings.descriptions.${id}`) as string)
    expect(new Set(ukDescriptions).size).toBe(IDS.length)
  })

  it('the General description does not claim auto-lock (it lives in Security)', () => {
    expect((lookup(en, 'settings.descriptions.general') as string).toLowerCase()).not.toContain('auto-lock')
    expect((lookup(en, 'settings.descriptions.security') as string).toLowerCase()).toContain('auto-lock')
  })

  it('the group titles are different from each other', () => {
    const titles = ['budget', 'device', 'cloud'].map((g) => lookup(en, `settings.groups.${g}`) as string)
    expect(new Set(titles).size).toBe(3)
  })
})

describe('the glossary terms (uk)', () => {
  it.each(Object.entries(GLOSSARY_UK))('%s is %s', (key, text) => {
    expect(norm(lookup(uk, key) as string)).toBe(norm(text))
    expect(norm(translate('uk', key as never))).toBe(norm(text))
  })

  it('docs/i18n/glossary.md lists both terms', () => {
    const glossary = norm(readFileSync(join(process.cwd(), 'docs/i18n/glossary.md'), 'utf8'))

    for (const text of Object.values(GLOSSARY_UK)) expect(glossary).toContain(norm(text))
    expect(glossary).toContain('Account & cloud')
  })
})
