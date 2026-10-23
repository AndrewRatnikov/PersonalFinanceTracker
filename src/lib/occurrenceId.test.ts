// No CONTRACT_GAPs: occurrenceRecordId, its fixed vector and its output format
// are fully specified in the Interface Contract (module: occurrenceId).

import { describe, expect, it } from 'vitest'

import { occurrenceRecordId } from '@/lib/occurrenceId'

const V5_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// An independent computation of the documented rule: SHA-256 of
// `${recurringId}:${occurrenceDate}`, first 16 bytes, version 5, RFC variant.
async function expectedId(recurringId: string, date: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${recurringId}:${date}`),
    ),
  )
  const b = digest.slice(0, 16)
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

describe('occurrenceRecordId', () => {
  it('matches the fixed vector for ("abc", "2026-10-01")', async () => {
    expect(await occurrenceRecordId('abc', '2026-10-01')).toBe(
      'f19f9bd1-f932-563a-a091-4f463d766b91',
    )
  })

  it('is a version 5 style UUID in lower case', async () => {
    const id = await occurrenceRecordId('abc', '2026-10-01')

    expect(id).toMatch(V5_UUID)
    expect(id).toBe(id.toLowerCase())
    expect(id).toHaveLength(36)
  })

  it('keeps the format for other inputs', async () => {
    for (const [recurringId, date] of [
      ['r1', '2026-01-31'],
      ['7b0e8c1a-2c63-4c2f-a0d0-7d1b9f3c1e55', '2027-02-28'],
      ['', '2026-12-31'],
    ]) {
      expect(await occurrenceRecordId(recurringId, date)).toMatch(V5_UUID)
    }
  })

  it('gives the same id for the same input every time', async () => {
    const first = await occurrenceRecordId('item-1', '2026-05-15')
    const second = await occurrenceRecordId('item-1', '2026-05-15')

    expect(second).toBe(first)
  })

  it('gives different ids for a different date or a different item', async () => {
    const base = await occurrenceRecordId('abc', '2026-10-01')

    expect(await occurrenceRecordId('abc', '2026-10-02')).not.toBe(base)
    expect(await occurrenceRecordId('abd', '2026-10-01')).not.toBe(base)
    expect(await occurrenceRecordId('abc', '2026-11-01')).not.toBe(
      await occurrenceRecordId('abc', '2026-10-02'),
    )
  })

  it('hashes `${recurringId}:${occurrenceDate}`', async () => {
    for (const [recurringId, date] of [
      ['abc', '2026-10-01'],
      ['r-77', '2026-03-09'],
      ['another-item', '2030-12-31'],
    ]) {
      expect(await occurrenceRecordId(recurringId, date)).toBe(
        await expectedId(recurringId, date),
      )
    }
  })
})
