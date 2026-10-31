// CONTRACT_GAP: the uk wording of keys other than the glossary terms is free;
//   they are only checked to exist, to differ from the English text and to keep
//   the same placeholders.
// CONTRACT_GAP: reading docs/i18n/glossary.md uses node:fs, like the other
//   repo-structure guards in scripts/.

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

const PLAIN_EN: Record<string, string> = {
  'space.personal': 'Personal',
  'space.switcherLabel': 'Space',
  'space.chipLabel': 'Current space: {name}. Tap to switch',
  'space.adding': 'Adding to {name}',
  'space.settingsFor': 'Settings for {name}',
  'space.switchedTo': 'Switched to {name}',
  'space.readOnlyBanner': "Read-only copy of {name}. You're no longer a member.",
  'space.readOnlyLink': 'Open Family settings',
  'space.pausedBanner': '{name} is paused. Your changes stay on this device and sync when it resumes.',
  'space.discardTitle': 'Discard this entry?',
  'space.discardBody': 'Switching space closes the form and your changes are lost.',
  'space.discardConfirm': 'Discard and switch',
  'space.openAppIn': 'Open the app in',
  'space.openAppInLast': 'Last used',
  'space.emptyTitle': '{name} has no entries yet',
  'space.emptyInvite': 'Invite members',
  'space.emptyMove': 'Move entries from Personal',
  'space.emptyAdd': 'Add the first expense',
  'space.open': 'Open',
  'members.paidBy': 'Paid by',
  'members.receivedBy': 'Received by',
  'members.member': 'Member',
  'members.all': 'All members',
  'members.formerMember': 'Former member',
  'members.left': '{name} (left)',
  'members.you': 'You',
  'members.addedBy': 'Added by {name}',
  'members.editedBy': 'Edited by {name}, {date}',
  'members.byMember': 'By member',
  'members.share': 'Share',
  'members.perMonth': '{amount} / month',
  'members.thisMonth': 'This month',
  'members.more': '+{count}',
  'move.toFamily': 'Move to Family',
  'move.toPersonal': 'Move to Personal',
  'move.bodyToFamily': 'Everyone in {name} will see these.',
  'move.bodyToPersonal': 'This removes them from {name} for everyone.',
  'move.confirm': 'Move',
  'move.failed': 'Could not move: {error}',
  'move.selectAll': 'Select all on this page',
  'move.selectRow': 'Select this entry',
  'move.copyCategories': 'Copy categories from Personal',
  'move.copyCategoriesNone': 'Every category is already here',
  'landing.features.familyLine':
    'Family budget: track shared spending together, end-to-end encrypted, free during the beta',
  'errors.app.moveSameSpace': 'The entries are already in this space',
  'errors.app.moveTooMany': 'Too many entries at once (at most {max})',
}

const PLURAL_KEYS = [
  'space.newEntries',
  'move.titleToFamily',
  'move.titleToPersonal',
  'move.done',
  'move.selected',
  'move.copyCategoriesDone',
]

const GLOSSARY_UK: Record<string, string> = {
  'space.personal': 'Особисте',
  'members.paidBy': 'Хто платив',
  'members.receivedBy': 'Хто отримав',
  'move.toFamily': "Перенести в сім'ю",
  'move.toPersonal': 'Перенести в особисте',
  'members.member': 'Учасник',
  'members.formerMember': 'Колишній учасник',
  'space.openAppIn': 'Відкривати застосунок у',
}

function norm(text: string): string {
  return text.replace(/[’ʼ`]/g, "'")
}

describe('plain keys exist in both catalogs with the agreed English text', () => {
  it.each(Object.entries(PLAIN_EN))('%s', (key, text) => {
    expect(lookup(en, key)).toBe(text)
    expect(typeof lookup(uk, key)).toBe('string')
  })

  it.each(Object.keys(PLAIN_EN))('uk %s keeps the placeholders and is translated', (key) => {
    const enText = lookup(en, key) as string
    const ukText = lookup(uk, key) as string

    expect(placeholders(ukText)).toEqual(placeholders(enText))
    expect(ukText.length).toBeGreaterThan(0)
    if (/[A-Za-z]{4,}/.test(enText.replace(/\{\w+\}/g, ''))) expect(ukText).not.toBe(enText)
  })
})

describe('plural keys', () => {
  it.each(PLURAL_KEYS)('%s has one/other in en and one/few/many/other in uk', (key) => {
    const enNode = lookup(en, key) as Record<string, string>
    const ukNode = lookup(uk, key) as Record<string, string>

    expect(Object.keys(enNode).sort()).toEqual(['one', 'other'])
    expect(Object.keys(ukNode).sort()).toEqual(['few', 'many', 'one', 'other'])
    expect(placeholders(enNode.one)).toEqual(placeholders(enNode.other))
  })

  it('has the agreed English forms', () => {
    expect(lookup(en, 'space.newEntries')).toEqual({
      one: '{count} new entry in {name}',
      other: '{count} new entries in {name}',
    })
    expect(lookup(en, 'move.titleToFamily')).toEqual({
      one: 'Move {count} entry to {name}?',
      other: 'Move {count} entries to {name}?',
    })
    expect(lookup(en, 'move.titleToPersonal')).toEqual({
      one: 'Move {count} entry to Personal?',
      other: 'Move {count} entries to Personal?',
    })
    expect(lookup(en, 'move.done')).toEqual({ one: '{count} entry moved', other: '{count} entries moved' })
    expect(lookup(en, 'move.copyCategoriesDone')).toEqual({
      one: '{count} category added',
      other: '{count} categories added',
    })
  })
})

describe('the glossary terms (uk)', () => {
  it.each(Object.entries(GLOSSARY_UK))('%s is %s', (key, text) => {
    expect(norm(lookup(uk, key) as string)).toBe(norm(text))
    expect(norm(translate('uk', key as never))).toBe(norm(text))
  })

  it('docs/i18n/glossary.md lists the new terms', () => {
    const glossary = norm(readFileSync(join(process.cwd(), 'docs/i18n/glossary.md'), 'utf8'))

    for (const text of Object.values(GLOSSARY_UK)) expect(glossary).toContain(norm(text))
  })
})
