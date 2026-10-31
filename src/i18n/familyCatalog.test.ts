// @vitest-environment node
// CONTRACT_GAP: the Ukrainian wording of keys outside the ten glossary terms is
//   the Coder's; for those only structure is checked (same keys, same
//   placeholders, Cyrillic text).
//
// Family strings (plan section 8, criterion 33): every key of the table exists
// in both catalogs with the same placeholders and plural shapes, the glossary
// terms are used as the glossary says, and docs/i18n/glossary.md lists them.
// The glossary file is the one file this test reads from disk.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { catalogKeys, translate, translatePlural } from '@/i18n/core'
import { en } from '@/i18n/messages/en'
import { uk } from '@/i18n/messages/uk'

const CYRILLIC = /[А-Яа-яІіЇїЄєҐґ]/

type Node = string | Record<string, unknown>

function lookup(tree: object, key: string): Node | undefined {
  let node: unknown = tree
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node as Node | undefined
}

function placeholders(text: string): Array<string> {
  return Array.from(new Set(text.match(/\{[A-Za-z0-9_]+\}/g) ?? [])).sort()
}

const STRING_KEYS: Array<[string, Array<string>]> = [
  ['settings.tabs.family', []],
  ['family.title', []],
  ['family.defaultName', []],
  ['family.signIn.body', []],
  ['family.signIn.link', []],
  ['family.syncOff.body', []],
  ['family.syncOff.button', []],
  ['family.notInPlan', []],
  ['family.loading', []],
  ['family.create.title', []],
  ['family.create.nameLabel', []],
  ['family.create.submit', []],
  ['family.create.hint', []],
  ['family.state.syncing', []],
  ['family.state.synced', []],
  ['family.state.offline', []],
  ['family.state.paused', []],
  ['family.state.rotationPending', []],
  ['family.state.error', ['{code}']],
  ['family.pending.waiting', ['{email}']],
  ['family.pending.waitingOwner', []],
  ['family.lastSync', ['{when}']],
  ['family.neverSynced', []],
  ['family.planLine', ['{count}', '{max}']],
  ['family.progress.pull', ['{done}']],
  ['family.progress.push', ['{done}', '{total}']],
  ['family.progress.reencrypt', ['{done}', '{total}']],
  ['family.spaceName.label', []],
  ['family.myName.label', []],
  ['family.save', []],
  ['family.members.title', []],
  ['family.members.you', []],
  ['family.members.owner', []],
  ['family.members.member', []],
  ['family.members.joined', ['{date}']],
  ['family.members.remove', []],
  ['family.members.transfer', []],
  ['family.requests.title', []],
  ['family.requests.asked', ['{when}']],
  ['family.requests.safetyCode', ['{code}']],
  ['family.requests.hint', ['{email}']],
  ['family.requests.approve', []],
  ['family.requests.reject', []],
  ['family.invites.title', []],
  ['family.invites.invite', []],
  ['family.invites.expires', ['{when}']],
  ['family.invites.revoke', []],
  ['family.invites.full', []],
  ['family.inviteDialog.title', []],
  ['family.inviteDialog.note', []],
  ['family.inviteDialog.copy', []],
  ['family.inviteDialog.copied', []],
  ['family.inviteDialog.share', []],
  ['family.inviteDialog.close', []],
  ['family.remove.title', ['{name}']],
  ['family.remove.body', []],
  ['family.remove.confirm', []],
  ['family.transfer.title', ['{name}']],
  ['family.transfer.body', []],
  ['family.transfer.confirm', []],
  ['family.leave.button', []],
  ['family.leave.title', ['{name}']],
  ['family.leave.body', []],
  ['family.leave.confirm', []],
  ['family.delete.button', []],
  ['family.delete.title', ['{name}']],
  ['family.delete.body', []],
  ['family.delete.backup', []],
  ['family.delete.typeName', []],
  ['family.delete.confirm', []],
  ['family.cancel', []],
  ['family.readOnly.body', ['{name}']],
  ['family.readOnly.forget', []],
  ['family.safetyCode.mine', ['{code}']],
  ['family.safetyCode.hint', []],
  ['family.toast.joined', ['{name}']],
  ['family.toast.request', ['{email}']],
  ['family.errors.inviteInvalid', []],
  ['family.errors.alreadyInSpace', []],
  ['family.errors.memberLimit', []],
  ['family.errors.paused', []],
  ['family.errors.offline', []],
  ['family.errors.inviteLimit', []],
  ['family.errors.notOwner', []],
  ['family.errors.ownerMustTransfer', []],
  ['family.errors.nameMismatch', []],
  ['family.errors.invalidName', []],
  ['family.errors.notInPlan', []],
  ['family.errors.syncOff', []],
  ['family.errors.readOnly', []],
  ['family.errors.generic', ['{code}']],
  ['join.notAvailable', []],
  ['join.invalid', []],
  ['join.title', []],
  ['join.loading', []],
  ['join.noVault.body', []],
  ['join.noVault.create', []],
  ['join.noVault.restore', []],
  ['join.locked', []],
  ['join.signIn.body', []],
  ['join.signIn.link', []],
  ['join.syncOff.body', []],
  ['join.syncOff.button', []],
  ['join.info', ['{email}', '{members}', '{when}']],
  ['join.ask', []],
  ['join.cancel', []],
  ['join.pendingBody', []],
  ['join.alreadyMember', []],
]

const PLURAL_KEYS = ['family.entries', 'join.members']

describe('the Family keys', () => {
  it.each(STRING_KEYS)('%s exists in both languages with the same placeholders', (key, expected) => {
    const e = lookup(en, key)
    const u = lookup(uk, key)

    expect(typeof e, `en ${key}`).toBe('string')
    expect(typeof u, `uk ${key}`).toBe('string')
    expect(placeholders(e as string)).toEqual(expected.slice().sort())
    expect(placeholders(u as string)).toEqual(expected.slice().sort())
  })

  it('the Ukrainian text is Ukrainian', () => {
    for (const [key] of STRING_KEYS) {
      if (key === 'family.signIn.link' || key === 'join.signIn.link') continue
      expect(CYRILLIC.test(lookup(uk, key) as string), key).toBe(true)
    }
  })

  it('the English Family tab label and default name are as specified', () => {
    expect(lookup(en, 'settings.tabs.family')).toBe('Family')
    expect(lookup(en, 'family.defaultName')).toBe('Family')
    expect(lookup(uk, 'family.defaultName')).not.toBe('Family')
  })

  it('the invite dialog note is the exact specified sentence', () => {
    expect(lookup(en, 'family.inviteDialog.note')).toBe(
      'Anyone with this link can ask to join. You approve every request. The link works once and expires in 48 hours.',
    )
  })

  it('the paused and read-only texts are as specified', () => {
    expect(lookup(en, 'family.state.paused')).toBe(
      "Family sync is paused: the owner's plan doesn't include it. Changes are kept and will sync when it's back.",
    )
    expect(lookup(en, 'family.readOnly.body')).toBe(
      "You're no longer in {name}. You can keep a read-only copy on this device or remove it.",
    )
    expect(lookup(en, 'family.remove.body')).toBe('They keep what was already on their devices but get nothing new.')
  })
})

describe('plurals', () => {
  it.each(PLURAL_KEYS)('%s is { one, other } in English and { one, few, many, other } in Ukrainian', (key) => {
    expect(Object.keys(lookup(en, key) as object).sort()).toEqual(['one', 'other'])
    expect(Object.keys(lookup(uk, key) as object).sort()).toEqual(['few', 'many', 'one', 'other'])
  })

  it('count is substituted and the forms differ', () => {
    expect(translatePlural('en', 'family.entries' as never, 1)).not.toBe(translatePlural('en', 'family.entries' as never, 5))
    expect(translatePlural('en', 'family.entries' as never, 5)).toContain('5')
    const forms = new Set([1, 2, 5, 21].map((n) => translatePlural('uk', 'join.members' as never, n)))
    expect(forms.size).toBeGreaterThan(2)
  })
})

describe('both catalogs have the same Family keys', () => {
  it('no family.*, join.* key is missing on either side', () => {
    const own = (k: string) => k.startsWith('family.') || k.startsWith('join.') || k === 'settings.tabs.family'
    const enKeys = catalogKeys(en).filter(own)
    const ukKeys = catalogKeys(uk).filter(own)

    expect(enKeys.length).toBeGreaterThan(90)
    expect([...ukKeys].sort()).toEqual([...enKeys].sort())
  })

  it('translate returns the catalog string with parameters filled in', () => {
    expect(translate('en', 'family.pending.waiting' as never, { email: 'a@b.c' } as never)).toBe('Waiting for a@b.c to approve')
    expect(translate('en', 'family.pending.waiting' as never, { email: 'x@y.z' } as never)).not.toContain('a@b.c')
  })
})

describe('glossary', () => {
  const pairs: Array<[string, string]> = [
    ['family.title', "Сім'я"],
    ['family.invites.invite', 'Запросити'],
    ['join.ask', 'Попросити приєднатися'],
    ['family.requests.approve', 'Схвалити'],
    ['family.requests.reject', 'Відхилити'],
    ['family.requests.safetyCode', 'Код безпеки'],
    ['family.leave.button', 'Вийти'],
    ['family.members.transfer', 'Передати права власника'],
    ['family.members.owner', 'Власник'],
    ['family.members.member', 'Учасник'],
  ]

  it.each(pairs)('%s uses the glossary term %s', (key, term) => {
    const text = (lookup(uk, key) as string).replace(/[’ʼ`]/g, "'")
    expect(text).toContain(term)
  })

  it('docs/i18n/glossary.md lists the Family terms', () => {
    const glossary = readFileSync(join(process.cwd(), 'docs/i18n/glossary.md'), 'utf8').replace(/[’ʼ`]/g, "'")

    for (const term of ["Сім'я", 'Запросити', 'Попросити приєднатися', 'Схвалити', 'Відхилити', 'Код безпеки', 'Вийти', 'Передати права власника', 'Власник', 'Учасник']) {
      expect(glossary, term).toContain(term)
    }
  })
})
