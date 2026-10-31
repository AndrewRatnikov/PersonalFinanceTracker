// Family members in the UI: the member directory, labels, filter options and
// totals by member (spec §23). Pure: no IndexedDB, no React. Labels follow the
// current language through t() from src/i18n/core.ts.
//
// A former member is a profile whose id is not in the server's active member
// list; when that list is unknown (null), every profile counts as active.
// Totals never round (display does).

import dayjs from 'dayjs'

import { t } from '../i18n/core'
import { mainAmountOf } from './money'
import { isLive } from './syncRecords'
import type { Currency, Expense, IncomeEntry } from './domain'

/** The group key for entries without `paidBy`. */
export const MEMBER_UNKNOWN = 'unknown'

export interface MemberInfo {
  id: string
  displayName: string
  color: string
  active: boolean
}

export interface MemberDirectory {
  me: string | null
  /** Sorted by displayName. */
  members: Array<MemberInfo>
  byId: Map<string, MemberInfo>
}

export interface MemberFilterOption {
  value: string
  label: string
}

export interface MemberTotal {
  memberId: string
  total: number
  share: number
  averagePerMonth: number
}

export function memberInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return '?'
  return words
    .slice(0, 2)
    .map((w) => Array.from(w)[0] ?? '')
    .join('')
    .toUpperCase()
}

export function buildMemberDirectory(
  profiles: ReadonlyArray<{ id: string; displayName: string; color: string }>,
  activeIds: ReadonlyArray<string> | null,
  me: string | null,
): MemberDirectory {
  const members: Array<MemberInfo> = profiles.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    color: p.color,
    active: activeIds === null || activeIds.includes(p.id),
  }))
  members.sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  const byId = new Map<string, MemberInfo>()
  for (const m of members) byId.set(m.id, m)
  return { me, members, byId }
}

export function memberLabel(dir: MemberDirectory, id: string | undefined): string {
  const info = id === undefined ? undefined : dir.byId.get(id)
  return info ? info.displayName : t('members.formerMember')
}

export function memberFilterOptions(
  dir: MemberDirectory,
  entries: ReadonlyArray<{ paidBy?: string }>,
): Array<MemberFilterOption> {
  const used = new Set<string>()
  const ghosts: Array<string> = []
  for (const e of entries) {
    const id = e.paidBy
    if (typeof id !== 'string' || id === '' || used.has(id)) continue
    used.add(id)
    if (!dir.byId.has(id)) ghosts.push(id)
  }
  const options: Array<MemberFilterOption> = [
    { value: 'all', label: t('members.all') },
  ]
  for (const m of dir.members) {
    if (m.active) options.push({ value: m.id, label: m.displayName })
  }
  for (const m of dir.members) {
    if (!m.active && used.has(m.id)) {
      options.push({ value: m.id, label: t('members.left', { name: m.displayName }) })
    }
  }
  for (const id of ghosts) {
    options.push({ value: id, label: t('members.formerMember') })
  }
  return options
}

export function filterByMember<T extends { paidBy?: string }>(
  entries: ReadonlyArray<T>,
  value: string,
): Array<T> {
  if (value === 'all') return entries.slice()
  return entries.filter((e) => e.paidBy === value)
}

export function memberTotals(
  entries: ReadonlyArray<Expense | IncomeEntry>,
  mainCurrency: Currency,
  months = 1,
): { rows: Array<MemberTotal>; pendingCount: number } {
  const totals = new Map<string, number>()
  let pendingCount = 0
  let sum = 0
  for (const e of entries) {
    if (!isLive(e)) continue
    const amount = mainAmountOf(e, mainCurrency)
    if (amount === null) {
      pendingCount += 1
      continue
    }
    if (!(amount > 0)) continue
    const key = e.paidBy ?? MEMBER_UNKNOWN
    totals.set(key, (totals.get(key) ?? 0) + amount)
    sum += amount
  }
  const divisor = Math.max(1, months)
  const rows: Array<MemberTotal> = Array.from(totals, ([memberId, total]) => ({
    memberId,
    total,
    share: sum === 0 ? 0 : total / sum,
    averagePerMonth: total / divisor,
  }))
  rows.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total
    return a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0
  })
  return { rows, pendingCount }
}

/** Local calendar months spanned by the two dates, inclusive; at least 1. */
export function monthsInRange(from: string, to: string): number {
  const a = dayjs(from)
  const b = dayjs(to)
  if (!a.isValid() || !b.isValid()) return 1
  const months = (b.year() - a.year()) * 12 + (b.month() - a.month()) + 1
  return Math.max(1, months)
}

export function topMembers(
  rows: ReadonlyArray<MemberTotal>,
  limit = 3,
): { top: Array<MemberTotal>; more: number } {
  const top = rows.slice(0, Math.max(0, limit))
  return { top, more: Math.max(0, rows.length - top.length) }
}
