// @vitest-environment node
// No CONTRACT_GAPs: the Family record format (index key, data key, AAD with the
// key version) is specified in plan section 1 and the Interface Contract.
// SyncRecordError's constructor is never called here; only code / instanceof.

import { createDecipheriv, createHmac, hkdfSync } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { EncryptedSpaceRow } from '@/lib/cloud/types'
import type { SyncRecord } from '@/lib/syncRecords'
import { SPACE_INDEX_INFO, SYNC_DATA_INFO } from '@/lib/cloud/types'
import {
  SyncRecordError,
  decryptSpaceRecord,
  decryptSyncRecord,
  deriveSpaceDataKey,
  deriveSpaceIndexKey,
  deriveSpaceSyncKeys,
  deriveSyncKeys,
  encryptSpaceRecord,
  encryptSyncRecord,
  recordKeyFor,
  spaceRecordAad,
} from '@/lib/cloud/recordCrypto'

const RECORD: SyncRecord = {
  type: 'expense',
  id: 'family-expense-0123456789',
  updatedAt: '2026-10-30T10:00:00.000Z',
  data: { amount: 4242, description: 'Family dinner' },
}

function rnd(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32))
}

function hkdf(ikm: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32))
}

function toRow(enc: { record_key: string; ciphertext: string; iv: string; enc_v: number }, keyVersion: number): EncryptedSpaceRow {
  return {
    record_key: enc.record_key,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    enc_v: enc.enc_v,
    key_version: keyVersion,
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(SyncRecordError)
  return (err as SyncRecordError).code
}

describe('constants and AAD', () => {
  it('names the index info', () => {
    expect(SPACE_INDEX_INFO).toBe('minima-space-index-v1')
  })

  it('the AAD is record_key:keyVersion', () => {
    expect(spaceRecordAad('abc', 1)).toBe('abc:1')
    expect(spaceRecordAad('abc', 12)).toBe('abc:12')
    expect(spaceRecordAad('abc', 2)).not.toBe(spaceRecordAad('abc', 1))
  })
})

describe('record keys', () => {
  it('equal HMAC-SHA256(HKDF(indexKey, minima-space-index-v1), type:id), base64url', async () => {
    const indexKey = rnd()
    const keys = await deriveSpaceSyncKeys(indexKey, rnd())

    const recordKey = await recordKeyFor(keys, 'expense', 'e-1')

    const expected = createHmac('sha256', hkdf(indexKey, 'minima-space-index-v1'))
      .update('expense:e-1')
      .digest('base64url')
    expect(recordKey).toBe(expected)
  })

  it('are identical for every sk (key version) and differ per indexKey, type and id', async () => {
    const indexKey = rnd()
    const v1 = await deriveSpaceSyncKeys(indexKey, rnd())
    const v2 = await deriveSpaceSyncKeys(indexKey, rnd())
    const other = await deriveSpaceSyncKeys(rnd(), rnd())

    const a = await recordKeyFor(v1, 'expense', 'x')
    expect(await recordKeyFor(v2, 'expense', 'x')).toBe(a)
    expect(await recordKeyFor(other, 'expense', 'x')).not.toBe(a)
    expect(await recordKeyFor(v1, 'income', 'x')).not.toBe(a)
    expect(await recordKeyFor(v1, 'expense', 'y')).not.toBe(a)
  })

  it('deriveSpaceIndexKey is a non-extractable HMAC signing key', async () => {
    const key = await deriveSpaceIndexKey(rnd())

    expect(key.algorithm.name).toBe('HMAC')
    expect(key.extractable).toBe(false)
    expect(key.usages).toEqual(['sign'])
  })

  it('deriveSpaceDataKey is a non-extractable AES-GCM key', async () => {
    const key = await deriveSpaceDataKey(rnd())

    expect(key.algorithm.name).toBe('AES-GCM')
    expect(key.extractable).toBe(false)
  })
})

describe('encryptSpaceRecord / decryptSpaceRecord', () => {
  it('round-trips and carries enc_v 1', async () => {
    const keys = await deriveSpaceSyncKeys(rnd(), rnd())

    const enc = await encryptSpaceRecord(keys, RECORD, 3)
    const back = await decryptSpaceRecord(keys, toRow(enc, 3))

    expect(enc.enc_v).toBe(1)
    expect(back).toEqual(RECORD)
    expect(enc.ciphertext).not.toContain('Family dinner')
    expect(enc.record_key).toBe(await recordKeyFor(keys, RECORD.type, RECORD.id))
  })

  it('is decryptable with node:crypto using the sk data key and the AAD record_key:keyVersion', async () => {
    const sk = rnd()
    const keys = await deriveSpaceSyncKeys(rnd(), sk)
    const enc = await encryptSpaceRecord(keys, RECORD, 4)

    const raw = Buffer.from(enc.ciphertext, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', hkdf(sk, SYNC_DATA_INFO), Buffer.from(enc.iv, 'base64'))
    decipher.setAAD(Buffer.from(`${enc.record_key}:4`, 'utf8'))
    decipher.setAuthTag(raw.subarray(raw.length - 16))
    const plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8')

    expect(plain).toContain('Family dinner')
  })

  it('fails with a wrong key version (the AAD binds it)', async () => {
    const keys = await deriveSpaceSyncKeys(rnd(), rnd())
    const enc = await encryptSpaceRecord(keys, RECORD, 1)

    expect(await codeOf(decryptSpaceRecord(keys, toRow(enc, 2)))).toBeDefined()
    await expect(decryptSpaceRecord(keys, toRow(enc, 1))).resolves.toEqual(RECORD)
  })

  it('fails when the record_key was tampered with', async () => {
    const keys = await deriveSpaceSyncKeys(rnd(), rnd())
    const enc = await encryptSpaceRecord(keys, RECORD, 1)
    const row = toRow(enc, 1)

    const swapped = { ...row, record_key: row.record_key.slice(0, -1) + (row.record_key.endsWith('A') ? 'B' : 'A') }

    expect(await codeOf(decryptSpaceRecord(keys, swapped))).toBeDefined()
  })

  it('fails with the data key of another sk', async () => {
    const indexKey = rnd()
    const mine = await deriveSpaceSyncKeys(indexKey, rnd())
    const theirs = await deriveSpaceSyncKeys(indexKey, rnd())
    const enc = await encryptSpaceRecord(mine, RECORD, 1)

    expect(await codeOf(decryptSpaceRecord(theirs, toRow(enc, 1)))).toBeDefined()
  })

  it('rejects an unknown enc_v', async () => {
    const keys = await deriveSpaceSyncKeys(rnd(), rnd())
    const enc = await encryptSpaceRecord(keys, RECORD, 1)

    expect(await codeOf(decryptSpaceRecord(keys, { ...toRow(enc, 1), enc_v: 99 }))).toBeDefined()
  })

  it('re-encrypting at a new version keeps the record_key and changes the ciphertext', async () => {
    const indexKey = rnd()
    const v1 = await deriveSpaceSyncKeys(indexKey, rnd())
    const v2 = await deriveSpaceSyncKeys(indexKey, rnd())

    const a = await encryptSpaceRecord(v1, RECORD, 1)
    const b = await encryptSpaceRecord(v2, RECORD, 2)

    expect(b.record_key).toBe(a.record_key)
    expect(b.ciphertext).not.toBe(a.ciphertext)
    await expect(decryptSpaceRecord(v2, toRow(b, 2))).resolves.toEqual(RECORD)
  })
})

describe('personal sync format is untouched', () => {
  it('a personal record still round-trips with the AAD record_key alone', async () => {
    const keys = await deriveSyncKeys(rnd())

    const enc = await encryptSyncRecord(keys, RECORD)

    await expect(decryptSyncRecord(keys, enc)).resolves.toEqual(RECORD)
  })

  it('a personal record does not open as a Family row', async () => {
    const ikm = rnd()
    const personal = await deriveSyncKeys(ikm)
    const enc = await encryptSyncRecord(personal, RECORD)

    expect(await codeOf(decryptSpaceRecord(personal, toRow(enc, 1)))).toBeDefined()
  })
})
