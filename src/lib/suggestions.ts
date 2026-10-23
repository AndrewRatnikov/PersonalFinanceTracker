// Description suggestions, computed in memory from already-decrypted entries.
// Pure: no IndexedDB, no React. Nothing new is stored. Deleted entries
// (tombstones) are skipped.

import { isLive } from './syncRecords'
import type { Currency } from './domain'

export interface SuggestionEntry {
  description?: string | null
  categoryId: string
  amount: number
  currency: Currency
  createdAt: string
  /** Set on a soft-deleted entry; such entries are ignored. */
  deletedAt?: string
}

export interface DescriptionSuggestion {
  description: string
  categoryId: string
  amount: number
  currency: Currency
  lastUsed: string
  count: number
}

export interface SuggestOptions {
  query: string
  categoryId?: string
  limit?: number
  now?: Date
}

const DAY_MS = 86_400_000
const RECENT_DAYS = 90

// Trimmed, whitespace-collapsed spelling.
function collapse(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

// Case and spacing variants share a key; diacritics are kept.
function groupKey(s: string): string {
  return collapse(s).toLowerCase()
}

// Lowercased, collapsed and without diacritics: used for matching only.
export function normalizeForMatch(s: string): string {
  return groupKey(s)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
}

interface Group {
  representative: SuggestionEntry
  time: number
  count: number
  score: number
}

export function suggestDescriptions(
  entries: ReadonlyArray<SuggestionEntry>,
  options: SuggestOptions,
): Array<DescriptionSuggestion> {
  const { query, categoryId, limit = 5 } = options
  const now = (options.now ?? new Date()).getTime()

  const groups = new Map<string, Group>()
  for (const entry of entries) {
    if (!isLive(entry)) continue
    const description = entry.description
    if (typeof description !== 'string') continue
    const key = groupKey(description)
    if (key === '') continue
    const time = new Date(entry.createdAt).getTime()
    const weight = now - time <= RECENT_DAYS * DAY_MS ? 2 : 1
    const group = groups.get(key)
    if (!group) {
      groups.set(key, { representative: entry, time, count: 1, score: weight })
      continue
    }
    group.count += 1
    group.score += weight
    if (time > group.time) {
      group.representative = entry
      group.time = time
    }
  }

  const q = normalizeForMatch(query)
  const ranked: Array<{ group: Group; text: string; tier: number }> = []
  for (const group of groups.values()) {
    const text = collapse(group.representative.description ?? '')
    let tier = 0
    if (q !== '') {
      const normalized = normalizeForMatch(text)
      if (normalized.startsWith(q)) tier = 0
      else if (normalized.includes(q)) tier = 1
      else continue
    }
    ranked.push({ group, text, tier })
  }

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (categoryId !== undefined) {
      const aIn = a.group.representative.categoryId === categoryId ? 0 : 1
      const bIn = b.group.representative.categoryId === categoryId ? 0 : 1
      if (aIn !== bIn) return aIn - bIn
    }
    if (a.group.score !== b.group.score) return b.group.score - a.group.score
    if (a.group.time !== b.group.time) return b.group.time - a.group.time
    if (a.text < b.text) return -1
    if (a.text > b.text) return 1
    return 0
  })

  return ranked.slice(0, Math.max(0, limit)).map(({ group, text }) => ({
    description: text,
    categoryId: group.representative.categoryId,
    amount: group.representative.amount,
    currency: group.representative.currency,
    lastUsed: group.representative.createdAt,
    count: group.count,
  }))
}
