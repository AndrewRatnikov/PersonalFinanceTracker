// No CONTRACT_GAPs: defaultDisplayName and memberColor are specified in the
// Interface Contract (member.ts). getCurrentMemberId is unchanged and not
// covered here.

import { describe, expect, it } from 'vitest'

import { MEMBER_COLORS, defaultDisplayName, memberColor } from '@/lib/spaces/member'

describe('defaultDisplayName', () => {
  it('is the part before the @', () => {
    expect(defaultDisplayName('ann.k@x.com')).toBe('ann.k')
    expect(defaultDisplayName('bob@example.org')).toBe('bob')
  })

  it('trims whitespace', () => {
    expect(defaultDisplayName('  ann @x.com')).toBe('ann')
  })

  it('cuts to 40 characters', () => {
    const long = 'a'.repeat(60)
    expect(defaultDisplayName(`${long}@x.com`)).toBe('a'.repeat(40))
  })

  it.each([null, undefined, ''])('returns an empty string for %j', (value) => {
    expect(defaultDisplayName(value)).toBe('')
  })
})

describe('MEMBER_COLORS', () => {
  it('has 6 distinct tokens', () => {
    expect(MEMBER_COLORS).toHaveLength(6)
    expect(new Set(MEMBER_COLORS).size).toBe(6)
    for (const c of MEMBER_COLORS) expect(c).toMatch(/^var\(--/)
  })
})

describe('memberColor', () => {
  it('is always one of MEMBER_COLORS', () => {
    for (let i = 0; i < 50; i++) {
      expect(MEMBER_COLORS).toContain(memberColor(`user-${i}`))
    }
  })

  it('is stable for the same id', () => {
    expect(memberColor('user-42')).toBe(memberColor('user-42'))
  })

  it('spreads different ids over more than one colour', () => {
    const colours = new Set(Array.from({ length: 60 }, (_, i) => memberColor(`id-${i}-${i * 7}`)))
    expect(colours.size).toBeGreaterThan(2)
  })
})
