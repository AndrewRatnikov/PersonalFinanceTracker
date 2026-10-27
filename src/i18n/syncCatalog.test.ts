// @vitest-environment node
// CONTRACT_GAP: the Ukrainian wording of keys outside the five glossary terms is
//   the Coder's; for those only structure is checked (same keys, same
//   placeholders, Cyrillic text).
//
// Sync strings (plan section 10, i18n table): the required keys exist in both
// catalogs with the same placeholders, the five glossary terms are used as the
// glossary says, docs/i18n/glossary.md lists them, and the privacy text no
// longer says sync is "coming soon". The glossary file is the one file this
// test reads from disk.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { catalogKeys } from '@/i18n/core'
import { en } from '@/i18n/messages/en'
import { uk } from '@/i18n/messages/uk'
import { legalEn } from '@/content/legal/en'
import { legalUk } from '@/content/legal/uk'
import { LEGAL_LAST_UPDATED } from '@/lib/legal'

const CYRILLIC = /[А-Яа-яІіЇїЄєҐґ]/

type Node = string | Record<string, string> | Record<string, unknown>

function lookup(tree: object, key: string): Node | undefined {
  let node: unknown = tree
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node as Node | undefined
}

function texts(node: Node | undefined): Array<string> {
  if (typeof node === 'string') return [node]
  if (node && typeof node === 'object') {
    return Object.values(node).filter((v): v is string => typeof v === 'string')
  }
  return []
}

function placeholders(text: string): Array<string> {
  return Array.from(new Set(text.match(/\{[A-Za-z0-9_]+\}/g) ?? [])).sort()
}

const STRING_KEYS: Array<[string, Array<string>]> = [
  ['settings.tabs.sync', []],
  ['sync.signIn.title', []],
  ['sync.signIn.body', []],
  ['sync.plan.beta', []],
  ['sync.state.off', []],
  ['sync.state.syncing', []],
  ['sync.state.synced', []],
  ['sync.state.offline', []],
  ['sync.state.paused', []],
  ['sync.state.deviceRemoved', []],
  ['sync.state.cloudDeleted', []],
  ['sync.state.vaultMismatch', []],
  ['sync.state.otherAccount', []],
  ['sync.state.signedOut', []],
  ['sync.state.error', ['{code}']],
  ['sync.now', []],
  ['sync.lastSynced', ['{when}']],
  ['sync.neverSynced', []],
  ['sync.turnOn', []],
  ['sync.uploadAgain', []],
  ['sync.turnOff.button', []],
  ['sync.turnOff.body', []],
  ['sync.turnOff.alsoRemoveDevice', []],
  ['sync.turnOff.confirm', []],
  ['sync.progress.upload', ['{done}', '{total}']],
  ['sync.progress.download', ['{done}']],
  ['sync.usage.records', ['{limit}', '{used}']],
  ['sync.usage.storage', ['{limit}', '{used}']],
  ['sync.devices.title', []],
  ['sync.devices.thisDevice', []],
  ['sync.devices.lastSeen', ['{when}']],
  ['sync.deleteCloud.button', []],
  ['sync.deleteCloud.title', []],
  ['sync.deleteCloud.body', []],
  ['sync.deleteCloud.passwordLabel', []],
  ['sync.deleteCloud.confirm', []],
  ['sync.link.title', []],
  ['sync.link.body', []],
  ['sync.link.join', []],
  ['sync.link.replace', []],
  ['sync.link.backupFirst', []],
  ['sync.link.passwordLabel', []],
  ['sync.link.confirm', []],
  ['sync.restore.entry', []],
  ['sync.restore.title', []],
  ['sync.restore.body', []],
  ['sync.restore.signIn', []],
  ['sync.restore.submit', []],
  ['sync.restore.useRecovery', []],
  ['sync.restore.noVault', []],
  ['sync.restore.progress', []],
  ['sync.toast.passwordChanged', []],
  ['sync.toast.turnedOn', []],
  ['sync.toast.turnedOff', []],
  ['sync.toast.cloudDeleted', []],
  ['sync.indicator.synced', []],
  ['sync.indicator.syncing', []],
  ['sync.indicator.offline', []],
  ['sync.indicator.problem', []],
  ['sync.errors.actionFailed', ['{code}']],
  ['landing.privacy.bullet2Sync', []],
  ['landing.features.syncLine', []],
]

describe('the required sync keys', () => {
  it.each(STRING_KEYS)('%s exists in both catalogs as non-empty text', (key) => {
    for (const catalog of [en, uk]) {
      const node = lookup(catalog, key)
      expect(typeof node, key).toBe('string')
      expect((node as string).trim().length, key).toBeGreaterThan(0)
    }
  })

  it.each(STRING_KEYS)('%s has the same placeholders in both languages', (key, expected) => {
    expect(placeholders(lookup(en, key) as string), key).toEqual(expected)
    expect(placeholders(lookup(uk, key) as string), key).toEqual(expected)
  })

  it.each(STRING_KEYS)('%s is translated, not copied', (key) => {
    const ukText = lookup(uk, key) as string
    const enText = lookup(en, key) as string
    expect(CYRILLIC.test(ukText), key).toBe(true)
    expect(ukText, key).not.toBe(enText)
  })

  it('sync.skipped is a plural node with the forms each language needs', () => {
    const enNode = lookup(en, 'sync.skipped') as Record<string, string>
    const ukNode = lookup(uk, 'sync.skipped') as Record<string, string>
    expect(typeof enNode).toBe('object')
    expect(Object.keys(enNode)).toEqual(expect.arrayContaining(['one', 'other']))
    expect(Object.keys(ukNode)).toEqual(expect.arrayContaining(['one', 'few', 'many', 'other']))
    for (const text of [...texts(enNode), ...texts(ukNode)]) {
      expect(text).toContain('{count}')
    }
    expect(enNode.one).not.toBe(enNode.other)
  })

  it('both catalogs have exactly the same sync keys', () => {
    const inSync = (keys: Array<string>) =>
      keys.filter((k) => k.startsWith('sync.') || k.startsWith('landing.') || k.startsWith('settings.')).sort()
    expect(inSync(catalogKeys(uk))).toEqual(inSync(catalogKeys(en)))
    expect(catalogKeys(en).filter((k) => k.startsWith('sync.')).length).toBeGreaterThan(40)
  })
})

describe('texts quoted by the requirements', () => {
  it('state and toast wording', () => {
    expect(lookup(en, 'sync.state.deviceRemoved')).toBe(
      'This device was removed from sync. Turn sync on again to reconnect.',
    )
    expect(lookup(en, 'sync.toast.passwordChanged')).toBe(
      'Your password was changed on another device. Use the new password next time you unlock.',
    )
    expect(lookup(en, 'sync.restore.entry')).toBe(
      'Already use MinimaSpend sync? Sign in to restore your data',
    )
    expect(lookup(en, 'sync.plan.beta')).toBe('Beta: free during the beta')
  })

  it('landing copy', () => {
    expect(lookup(en, 'landing.privacy.bullet2Sync') as string).toContain(
      'Optional encrypted sync: our server stores only data it can',
    )
    expect(lookup(en, 'landing.features.syncLine')).toBe('Sync across devices (free during beta)')
    expect(lookup(en, 'landing.privacy.bullet2') as string).toContain('Zero financial data')
    expect(lookup(en, 'landing.privacy.bullet3') as string).toContain('No account needed')
  })
})

describe('glossary terms (criterion 22)', () => {
  const terms: Array<[string, string, string, string]> = [
    ['Sync now', 'sync.now', 'Sync now', 'Синхронізувати зараз'],
    ['Last synced', 'sync.lastSynced', 'Last synced', 'Остання синхронізація'],
    ['Turn on sync', 'sync.turnOn', 'Turn on sync', 'Увімкнути синхронізацію'],
    ['This device', 'sync.devices.thisDevice', 'This device', 'Цей пристрій'],
    ['Delete cloud data', 'sync.deleteCloud.button', 'Delete cloud data', 'Видалити дані з хмари'],
  ]

  it.each(terms)('%s is used as the glossary says', (_term, key, english, ukrainian) => {
    expect(lookup(en, key) as string).toContain(english)
    expect(lookup(uk, key) as string).toContain(ukrainian)
  })

  it('"Delete cloud data" and "Sync now" differ in Ukrainian (no term copied to another)', () => {
    expect(lookup(uk, 'sync.now')).not.toBe(lookup(uk, 'sync.deleteCloud.button'))
  })

  it('docs/i18n/glossary.md lists all five terms', () => {
    const glossary = readFileSync(join(process.cwd(), 'docs/i18n/glossary.md'), 'utf8')
    for (const [term, , english, ukrainian] of terms) {
      const row = glossary.split('\n').find((line) => line.includes(english) && line.includes(ukrainian))
      expect(row, term).toBeTruthy()
    }
  })

  it('docs/i18n/glossary.md still has its table header', () => {
    const glossary = readFileSync(join(process.cwd(), 'docs/i18n/glossary.md'), 'utf8')
    expect(glossary).toContain('| English | Ukrainian |')
  })
})

describe('privacy text matches the beta (criterion 27)', () => {
  const syncSection = (doc: typeof legalEn.privacy) => doc.sections.find((s) => s.id === 'sync')

  it('LEGAL_LAST_UPDATED is bumped and used by both documents', () => {
    expect(LEGAL_LAST_UPDATED).toBe('2026-10-24')
    expect(legalEn.privacy.lastUpdated).toBe('2026-10-24')
    expect(legalUk.privacy.lastUpdated).toBe('2026-10-24')
    expect(legalEn.terms.lastUpdated).toBe('2026-10-24')
  })

  it('no longer says sync is coming soon, in either language', () => {
    const enAll = JSON.stringify(legalEn)
    const ukAll = JSON.stringify(legalUk)
    expect(enAll.toLowerCase()).not.toContain('coming soon')
    expect(ukAll).not.toContain('незабаром')
    expect(enAll).toContain('Sync across devices is optional and in beta.')
  })

  it('the sync section lists what the engine really sends', () => {
    const section = syncSection(legalEn.privacy)
    expect(section).toBeTruthy()
    const text = [...(section?.paragraphs ?? []), ...(section?.bullets ?? [])].join('\n').toLowerCase()
    expect(text).toMatch(/key/)
    expect(text).toMatch(/encrypted/)
    expect(text).toMatch(/edited|edit time|last edit/)
    expect(text).toMatch(/size/)
    expect(text).toMatch(/device/)
    expect(text).toMatch(/header/)
    expect(text).toMatch(/last seen|seen/)
  })

  it('both languages have the same section ids and bullet counts', () => {
    expect(legalUk.privacy.sections.map((s) => s.id)).toEqual(legalEn.privacy.sections.map((s) => s.id))
    expect(legalUk.terms.sections.map((s) => s.id)).toEqual(legalEn.terms.sections.map((s) => s.id))
    for (const [i, section] of legalEn.privacy.sections.entries()) {
      expect(legalUk.privacy.sections[i].bullets?.length ?? 0, section.id).toBe(
        section.bullets?.length ?? 0,
      )
    }
  })

  it('retention explains how to delete only the cloud data', () => {
    const retention = legalEn.privacy.sections.find((s) => s.id === 'retention')
    expect(retention?.paragraphs.join(' ')).toContain('Delete cloud data')
  })
})
