// CONTRACT_GAP: the exact label text of members.left / members.formerMember is
//   not fixed by the contract; labels are asserted through translate() on the
//   catalog keys named in the contract.
// CONTRACT_GAP: the order of options for two former profiles is not specified;
//   only one former profile is used per case.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Expense, IncomeEntry } from '@/lib/domain'
import { setLang, translate } from '@/i18n/core'
import {
  MEMBER_UNKNOWN,
  buildMemberDirectory,
  filterByMember,
  memberFilterOptions,
  memberInitials,
  memberLabel,
  memberTotals,
  monthsInRange,
  topMembers,
} from '@/lib/memberStats'

const PROFILES = [
  { id: 'u-olena', displayName: 'Olena', color: 'var(--chart-2)' },
  { id: 'u-me', displayName: 'Andrii', color: 'var(--chart-1)' },
  { id: 'u-taras', displayName: 'Taras', color: 'var(--chart-3)' },
  { id: 'u-left', displayName: 'Maksym', color: 'var(--chart-4)' },
]
const ACTIVE = ['u-me', 'u-olena', 'u-taras']

function expense(id: string, amount: number, paidBy?: string, extra: Partial<Expense> = {}): Expense {
  return {
    id,
    amount,
    currency: 'UAH',
    categoryId: 'cat-food',
    createdAt: '2026-10-12T10:00:00.000Z',
    ...(paidBy === undefined ? {} : { paidBy }),
    ...extra,
  }
}

function income(id: string, amount: number, paidBy?: string): IncomeEntry {
  return {
    id,
    amount,
    currency: 'UAH',
    categoryId: 'cat-salary',
    createdAt: '2026-10-12T10:00:00.000Z',
    ...(paidBy === undefined ? {} : { paidBy }),
  }
}

beforeEach(() => setLang('en', { persist: false }))
afterEach(() => setLang('en', { persist: false }))

describe('memberInitials', () => {
  it('takes the first letter of the first two words, uppercased', () => {
    expect(memberInitials('olena kovalenko')).toBe('OK')
    expect(memberInitials('Andrii')).toBe('A')
    expect(memberInitials('  taras   shevchenko  extra ')).toBe('TS')
  })

  it('gives ? for an empty name', () => {
    expect(memberInitials('')).toBe('?')
    expect(memberInitials('   ')).toBe('?')
  })
})

describe('buildMemberDirectory', () => {
  it('sorts members by displayName and flags active ones', () => {
    const dir = buildMemberDirectory(PROFILES, ACTIVE, 'u-me')

    expect(dir.me).toBe('u-me')
    expect(dir.members.map((m) => m.displayName)).toEqual(['Andrii', 'Maksym', 'Olena', 'Taras'])
    expect(dir.byId.get('u-left')?.active).toBe(false)
    expect(dir.byId.get('u-olena')?.active).toBe(true)
    expect(dir.byId.get('u-me')?.color).toBe('var(--chart-1)')
  })

  it('treats every profile as active when the active list is unknown (null)', () => {
    const dir = buildMemberDirectory(PROFILES, null, null)

    expect(dir.me).toBeNull()
    expect(dir.members.every((m) => m.active)).toBe(true)
  })
})

describe('memberLabel', () => {
  it('uses the profile name, and "Former member" for unknown or missing ids', () => {
    const dir = buildMemberDirectory(PROFILES, ACTIVE, 'u-me')

    expect(memberLabel(dir, 'u-olena')).toBe('Olena')
    expect(memberLabel(dir, 'u-left')).toBe('Maksym')
    expect(memberLabel(dir, 'u-ghost')).toBe(translate('en', 'members.formerMember'))
    expect(memberLabel(dir, undefined)).toBe(translate('en', 'members.formerMember'))
  })

  it('follows the current language', () => {
    const dir = buildMemberDirectory(PROFILES, ACTIVE, 'u-me')
    const en = memberLabel(dir, 'u-ghost')
    setLang('uk', { persist: false })

    expect(memberLabel(dir, 'u-ghost')).toBe(translate('uk', 'members.formerMember'))
    expect(memberLabel(dir, 'u-ghost')).not.toBe(en)
  })
})

describe('memberFilterOptions', () => {
  const dir = buildMemberDirectory(PROFILES, ACTIVE, 'u-me')

  it('lists All, the active members, a (left) former profile with entries, then ids without a profile', () => {
    const options = memberFilterOptions(dir, [
      { paidBy: 'u-left' },
      { paidBy: 'u-ghost' },
      { paidBy: 'u-me' },
      {},
    ])

    expect(options).toEqual([
      { value: 'all', label: translate('en', 'members.all') },
      { value: 'u-me', label: 'Andrii' },
      { value: 'u-olena', label: 'Olena' },
      { value: 'u-taras', label: 'Taras' },
      { value: 'u-left', label: translate('en', 'members.left', { name: 'Maksym' }) },
      { value: 'u-ghost', label: translate('en', 'members.formerMember') },
    ])
  })

  it('omits a former profile that has no entries', () => {
    const values = memberFilterOptions(dir, [{ paidBy: 'u-me' }]).map((o) => o.value)

    expect(values).not.toContain('u-left')
    expect(values).not.toContain('u-ghost')
    expect(values[0]).toBe('all')
  })

  it('labels the left member differently from an active one', () => {
    const left = memberFilterOptions(dir, [{ paidBy: 'u-left' }]).find((o) => o.value === 'u-left')
    expect(left?.label).not.toBe('Maksym')
    expect(left?.label).toContain('Maksym')
  })
})

describe('filterByMember', () => {
  const list = [expense('a', 1, 'u-me'), expense('b', 2, 'u-olena'), expense('c', 3)]

  it('returns everything for all', () => {
    expect(filterByMember(list, 'all')).toHaveLength(3)
  })

  it('keeps only the entries paid by the member', () => {
    expect(filterByMember(list, 'u-olena').map((e) => e.id)).toEqual(['b'])
    expect(filterByMember(list, 'u-me').map((e) => e.id)).toEqual(['a'])
    expect(filterByMember(list, 'u-ghost')).toEqual([])
  })
})

describe('memberTotals', () => {
  it('groups by payer with share, average per month and sorting (hand-computed)', () => {
    const result = memberTotals(
      [
        expense('1', 100, 'u-me'),
        expense('2', 50, 'u-me'),
        expense('3', 150, 'u-olena'),
        expense('4', 100),
      ],
      'UAH',
      3,
    )

    expect(result.pendingCount).toBe(0)
    expect(result.rows.map((r) => r.memberId)).toEqual(['u-me', 'u-olena', MEMBER_UNKNOWN])
    expect(result.rows.map((r) => r.total)).toEqual([150, 150, 100])
    expect(result.rows[0].share).toBeCloseTo(0.375, 10)
    expect(result.rows[2].share).toBeCloseTo(0.25, 10)
    expect(result.rows[0].averagePerMonth).toBeCloseTo(50, 10)
    expect(result.rows[2].averagePerMonth).toBeCloseTo(100 / 3, 10)
  })

  it('a different input gives a different result', () => {
    const a = memberTotals([expense('1', 100, 'u-me'), expense('2', 300, 'u-olena')], 'UAH')
    const b = memberTotals([expense('1', 300, 'u-me'), expense('2', 100, 'u-olena')], 'UAH')

    expect(a.rows[0].memberId).toBe('u-olena')
    expect(b.rows[0].memberId).toBe('u-me')
    expect(a.rows[0].share).toBeCloseTo(0.75, 10)
  })

  it('skips deleted entries and non-positive amounts', () => {
    const result = memberTotals(
      [
        expense('1', 100, 'u-me'),
        expense('2', 999, 'u-me', { deletedAt: '2026-10-13T00:00:00.000Z' }),
        expense('3', 0, 'u-olena'),
      ],
      'UAH',
    )

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].total).toBe(100)
    expect(result.rows[0].share).toBe(1)
  })

  it('counts entries without a main-currency amount as pending and leaves them out', () => {
    const result = memberTotals(
      [expense('1', 100, 'u-me'), expense('2', 40, 'u-olena', { currency: 'USD' })],
      'UAH',
    )

    expect(result.pendingCount).toBe(1)
    expect(result.rows.map((r) => r.memberId)).toEqual(['u-me'])
  })

  it('uses a converted amount when the conversion matches the main currency', () => {
    const result = memberTotals(
      [
        expense('1', 10, 'u-olena', {
          currency: 'USD',
          conversion: { mainCurrency: 'UAH', rate: 40, mainAmount: 400, rateDate: '2026-10-12', source: 'nbu' },
        }),
      ],
      'UAH',
    )

    expect(result.pendingCount).toBe(0)
    expect(result.rows[0].total).toBe(400)
  })

  it('works for income entries and gives share 0-safe empty output', () => {
    expect(memberTotals([income('1', 70, 'u-me'), income('2', 30, 'u-taras')], 'UAH').rows[0].share).toBeCloseTo(0.7, 10)
    expect(memberTotals([], 'UAH')).toEqual({ rows: [], pendingCount: 0 })
  })

  it('never divides by less than one month', () => {
    const rows = memberTotals([expense('1', 90, 'u-me')], 'UAH', 0).rows

    expect(rows[0].averagePerMonth).toBe(90)
  })
})

describe('monthsInRange', () => {
  it('counts the calendar months spanned, inclusive', () => {
    expect(monthsInRange('2026-01-15', '2026-03-02')).toBe(3)
    expect(monthsInRange('2026-10-01', '2026-10-31')).toBe(1)
    expect(monthsInRange('2025-11-30', '2026-02-01')).toBe(4)
  })

  it('is at least 1', () => {
    expect(monthsInRange('2026-10-05', '2026-10-05')).toBe(1)
  })
})

describe('topMembers', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].map((memberId, i) => ({
    memberId,
    total: 100 - i,
    share: 0.2,
    averagePerMonth: 1,
  }))

  it('keeps three by default and counts the rest', () => {
    const result = topMembers(rows)

    expect(result.top.map((r) => r.memberId)).toEqual(['a', 'b', 'c'])
    expect(result.more).toBe(2)
  })

  it('respects the limit and never goes negative', () => {
    expect(topMembers(rows, 5)).toEqual({ top: rows, more: 0 })
    expect(topMembers(rows.slice(0, 2)).more).toBe(0)
    expect(topMembers(rows, 1).more).toBe(4)
  })
})
