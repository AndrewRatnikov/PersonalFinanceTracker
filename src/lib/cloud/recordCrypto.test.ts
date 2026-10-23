// @vitest-environment node
// No CONTRACT_GAPs: recordCrypto exports, the HKDF infos, the HMAC record key
// and the AES-GCM layout are specified in plan section 1 and the Interface
// Contract. SyncRecordError's constructor is not specified, so it is never
// constructed here; only name, code and instanceof are checked.

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { SyncKeys } from '@/lib/cloud/types'
import type { SyncRecord, SyncRecordType } from '@/lib/syncRecords'
import {
  SYNC_DATA_INFO,
  SYNC_ENC_V,
  SYNC_INDEX_INFO,
} from '@/lib/cloud/types'
import { base64ToBytes } from '@/lib/crypto'
import {
  SyncRecordError,
  decryptSyncRecord,
  deriveSyncKeys,
  encryptSyncRecord,
  recordKeyFor,
} from '@/lib/cloud/recordCrypto'

const ALL_TYPES: Array<SyncRecordType> = [
  'expense',
  'income',
  'category',
  'incomeCategory',
  'budget',
  'recurring',
  'settings',
]

function randomIkm(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32))
}

async function newKeys(ikm: Uint8Array<ArrayBuffer> = randomIkm()): Promise<SyncKeys> {
  return deriveSyncKeys(ikm)
}

const RECORD: SyncRecord = {
  type: 'expense',
  id: 'transaction-id-abcdef0123456789',
  updatedAt: '2026-10-23T10:00:00.000Z',
  data: { amount: 12345, description: 'Coffee ☕ кава', categoryId: 'cat-9' },
}

function hkdf(ikm: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32))
}

// Encrypts like the spec does, using node:crypto (WebCrypto layout: the
// 16-byte tag is appended to the ciphertext).
function nodeEncrypt(
  ikm: Uint8Array,
  plaintext: string,
  recordKey: string,
): { ciphertext: string; iv: string } {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', hkdf(ikm, SYNC_DATA_INFO), iv)
  cipher.setAAD(Buffer.from(recordKey, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: Buffer.concat([body, tag]).toString('base64'),
    iv: iv.toString('base64'),
  }
}

function nodeDecrypt(
  ikm: Uint8Array,
  row: { ciphertext: string; iv: string; record_key: string },
): string {
  const raw = Buffer.from(row.ciphertext, 'base64')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    hkdf(ikm, SYNC_DATA_INFO),
    Buffer.from(row.iv, 'base64'),
  )
  decipher.setAAD(Buffer.from(row.record_key, 'utf8'))
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  return Buffer.concat([
    decipher.update(raw.subarray(0, raw.length - 16)),
    decipher.final(),
  ]).toString('utf8')
}

function nodeRecordKey(ikm: Uint8Array, type: string, id: string): string {
  return createHmac('sha256', hkdf(ikm, SYNC_INDEX_INFO))
    .update(`${type}:${id}`, 'utf8')
    .digest('base64url')
}

async function expectSyncError(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(SyncRecordError)
  expect((err as SyncRecordError).name).toBe('SyncRecordError')
  expect((err as SyncRecordError).code).toBe(code)
}

describe('constants', () => {
  it('uses the specified HKDF infos and enc_v', () => {
    expect(SYNC_INDEX_INFO).toBe('minima-sync-index-v1')
    expect(SYNC_DATA_INFO).toBe('minima-sync-data-v1')
    expect(SYNC_ENC_V).toBe(1)
  })
})

describe('deriveSyncKeys', () => {
  it('derives a non-extractable HMAC index key and AES-GCM data key', async () => {
    const keys = await newKeys()

    expect(keys.index.algorithm.name).toBe('HMAC')
    expect(keys.index.extractable).toBe(false)
    expect(keys.index.usages).toEqual(['sign'])
    expect(keys.data.algorithm.name).toBe('AES-GCM')
    expect((keys.data.algorithm as AesKeyAlgorithm).length).toBe(256)
    expect(keys.data.extractable).toBe(false)
    expect([...keys.data.usages].sort()).toEqual(['decrypt', 'encrypt'])
  })

  it('the same bytes give the same keys, different bytes give different keys', async () => {
    const ikm = randomIkm()
    const k1 = await newKeys(ikm)
    const k2 = await newKeys(ikm)
    const other = await newKeys(randomIkm())

    expect(await recordKeyFor(k1, 'expense', 'e1')).toBe(await recordKeyFor(k2, 'expense', 'e1'))
    expect(await recordKeyFor(k1, 'expense', 'e1')).not.toBe(
      await recordKeyFor(other, 'expense', 'e1'),
    )
  })

  it('accepts an HKDF CryptoKey and gives the same result as the bytes', async () => {
    const ikm = randomIkm()
    const hkdfKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey'])

    const fromKey = await deriveSyncKeys(hkdfKey)
    const fromBytes = await deriveSyncKeys(ikm)

    expect(await recordKeyFor(fromKey, 'income', 'i1')).toBe(
      await recordKeyFor(fromBytes, 'income', 'i1'),
    )
  })

  it('rejects an AES-GCM CryptoKey (the DEK) with a TypeError that mentions HKDF', async () => {
    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])

    const err = await deriveSyncKeys(dek).then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(TypeError)
    expect((err as TypeError).message).toMatch(/HKDF/)
  })
})

describe('recordKeyFor', () => {
  it('is 43 base64url characters without padding', async () => {
    const keys = await newKeys()
    const key = await recordKeyFor(keys, 'expense', 'e1')
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('is stable for the same type and id across calls', async () => {
    const keys = await newKeys()
    const a = await recordKeyFor(keys, 'expense', RECORD.id)
    const b = await recordKeyFor(keys, 'expense', RECORD.id)
    expect(a).toBe(b)
  })

  it('differs for a different id and for a different type', async () => {
    const keys = await newKeys()
    const base = await recordKeyFor(keys, 'expense', 'same-id')
    expect(await recordKeyFor(keys, 'expense', 'other-id')).not.toBe(base)
    expect(await recordKeyFor(keys, 'income', 'same-id')).not.toBe(base)

    const seen = new Set<string>()
    for (const type of ALL_TYPES) seen.add(await recordKeyFor(keys, type, 'same-id'))
    expect(seen.size).toBe(ALL_TYPES.length)
  })

  it('does not contain the type or the id', async () => {
    const keys = await newKeys()
    const key = await recordKeyFor(keys, 'incomeCategory', RECORD.id)
    expect(key).not.toContain('incomeCategory')
    expect(key).not.toContain(RECORD.id)
    expect(key.toLowerCase()).not.toContain('income')
  })

  it('is HMAC-SHA256(K_index, "type:id") with K_index from HKDF(empty salt)', async () => {
    const ikm = randomIkm()
    const keys = await newKeys(ikm)

    expect(await recordKeyFor(keys, 'expense', 'abc')).toBe(nodeRecordKey(ikm, 'expense', 'abc'))
    expect(await recordKeyFor(keys, 'budget', 'b-9')).toBe(nodeRecordKey(ikm, 'budget', 'b-9'))
    expect(nodeRecordKey(ikm, 'expense', 'abc')).not.toBe(nodeRecordKey(ikm, 'budget', 'b-9'))
  })
})

describe('encryptSyncRecord', () => {
  it('returns exactly the wire fields', async () => {
    const keys = await newKeys()
    const row = await encryptSyncRecord(keys, RECORD)

    expect(Object.keys(row).sort()).toEqual([
      'ciphertext',
      'enc_v',
      'iv',
      'record_key',
      'updated_at_ms',
    ])
    expect(row.enc_v).toBe(1)
    expect(row.updated_at_ms).toBe(Date.parse(RECORD.updatedAt))
    expect(Number.isInteger(row.updated_at_ms)).toBe(true)
    expect(row.record_key).toBe(await recordKeyFor(keys, RECORD.type, RECORD.id))
  })

  it('uses a random 12-byte IV: same record twice gives the same key but new ciphertext', async () => {
    const keys = await newKeys()
    const a = await encryptSyncRecord(keys, RECORD)
    const b = await encryptSyncRecord(keys, RECORD)

    expect(a.record_key).toBe(b.record_key)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(base64ToBytes(a.iv)).toHaveLength(12)
    expect(a.iv).toHaveLength(16)
  })

  it('does not leak the type, id or content into the ciphertext fields', async () => {
    const keys = await newKeys()
    const row = await encryptSyncRecord(keys, RECORD)
    const wire = JSON.stringify(row)
    expect(wire).not.toContain(RECORD.id)
    expect(wire).not.toContain('expense')
    expect(wire).not.toContain('Coffee')
    expect(wire).not.toContain('12345')
  })

  it('updated_at_ms follows the record time', async () => {
    const keys = await newKeys()
    const a = await encryptSyncRecord(keys, { ...RECORD, updatedAt: '2026-01-01T00:00:00.000Z' })
    const b = await encryptSyncRecord(keys, { ...RECORD, updatedAt: '2026-01-01T00:00:01.500Z' })
    expect(b.updated_at_ms - a.updated_at_ms).toBe(1500)
  })

  it('rejects an unparsable updatedAt with invalid-record', async () => {
    const keys = await newKeys()
    await expectSyncError(
      encryptSyncRecord(keys, { ...RECORD, updatedAt: 'not a date' }),
      'invalid-record',
    )
  })

  it('writes AES-GCM(K_data, iv, JSON) with record_key as AAD (checked with node:crypto)', async () => {
    const ikm = randomIkm()
    const keys = await newKeys(ikm)
    const row = await encryptSyncRecord(keys, RECORD)

    expect(JSON.parse(nodeDecrypt(ikm, row))).toEqual(RECORD)
  })
})

describe('decryptSyncRecord', () => {
  it('round-trips a record, with unicode and a tombstone', async () => {
    const keys = await newKeys()
    const tomb: SyncRecord = {
      type: 'category',
      id: 'cat-1',
      updatedAt: '2026-10-24T08:30:00.000Z',
      deletedAt: '2026-10-24T08:30:00.000Z',
      data: { name: 'Їжа' },
    }

    expect(await decryptSyncRecord(keys, await encryptSyncRecord(keys, RECORD))).toEqual(RECORD)
    expect(await decryptSyncRecord(keys, await encryptSyncRecord(keys, tomb))).toEqual(tomb)
  })

  it('decrypts what node:crypto encrypted per the spec', async () => {
    const ikm = randomIkm()
    const keys = await newKeys(ikm)
    const record_key = nodeRecordKey(ikm, RECORD.type, RECORD.id)
    const { ciphertext, iv } = nodeEncrypt(ikm, JSON.stringify(RECORD), record_key)

    expect(await decryptSyncRecord(keys, { record_key, ciphertext, iv, enc_v: 1 })).toEqual(RECORD)
  })

  it('fails with decrypt-failed when a ciphertext character is flipped', async () => {
    const keys = await newKeys()
    const row = await encryptSyncRecord(keys, RECORD)
    const first = row.ciphertext[0] === 'A' ? 'B' : 'A'
    const tampered = { ...row, ciphertext: first + row.ciphertext.slice(1) }

    await expectSyncError(decryptSyncRecord(keys, tampered), 'decrypt-failed')
    // The untouched row still opens, so the failure is caused by the flip.
    await expect(decryptSyncRecord(keys, row)).resolves.toEqual(RECORD)
  })

  it('fails with decrypt-failed when the iv is changed', async () => {
    const keys = await newKeys()
    const a = await encryptSyncRecord(keys, RECORD)
    const b = await encryptSyncRecord(keys, RECORD)

    await expectSyncError(decryptSyncRecord(keys, { ...a, iv: b.iv }), 'decrypt-failed')
  })

  it("fails with decrypt-failed when another record's record_key is swapped in", async () => {
    const keys = await newKeys()
    const a = await encryptSyncRecord(keys, RECORD)
    const b = await encryptSyncRecord(keys, { ...RECORD, id: 'a-different-record-id' })

    expect(a.record_key).not.toBe(b.record_key)
    await expectSyncError(
      decryptSyncRecord(keys, { ...a, record_key: b.record_key }),
      'decrypt-failed',
    )
  })

  it('fails with decrypt-failed under other keys', async () => {
    const keys = await newKeys()
    const row = await encryptSyncRecord(keys, RECORD)
    await expectSyncError(decryptSyncRecord(await newKeys(), row), 'decrypt-failed')
  })

  it('fails with decrypt-failed on bad base64', async () => {
    const keys = await newKeys()
    const row = await encryptSyncRecord(keys, RECORD)
    await expectSyncError(
      decryptSyncRecord(keys, { ...row, ciphertext: '!!! not base64 !!!' }),
      'decrypt-failed',
    )
    await expectSyncError(decryptSyncRecord(keys, { ...row, iv: '***' }), 'decrypt-failed')
  })

  it('rejects enc_v 2 with unsupported-version before trying to decrypt', async () => {
    const keys = await newKeys()
    const row = await encryptSyncRecord(keys, RECORD)

    await expectSyncError(decryptSyncRecord(keys, { ...row, enc_v: 2 }), 'unsupported-version')
    await expectSyncError(
      decryptSyncRecord(keys, { ...row, enc_v: 2, ciphertext: 'garbage' }),
      'unsupported-version',
    )
    await expectSyncError(decryptSyncRecord(keys, { ...row, enc_v: 0 }), 'unsupported-version')
  })

  describe('a valid ciphertext that is not a valid record', () => {
    const cases: Array<[string, unknown]> = [
      ['an unknown type', { type: 'bogus', id: 'x', updatedAt: 't', data: {} }],
      ['a numeric id', { type: 'expense', id: 5, updatedAt: 't', data: {} }],
      ['a missing updatedAt', { type: 'expense', id: 'x', data: {} }],
      ['a numeric deletedAt', { type: 'expense', id: 'x', updatedAt: 't', deletedAt: 5, data: {} }],
      ['a null data', { type: 'expense', id: 'x', updatedAt: 't', data: null }],
      ['a missing data', { type: 'expense', id: 'x', updatedAt: 't' }],
      ['a string data', { type: 'expense', id: 'x', updatedAt: 't', data: 'text' }],
      ['a JSON string', 'just a string'],
      ['JSON null', null],
    ]

    it.each(cases)('is rejected with invalid-record for %s', async (_name, payload) => {
      const ikm = randomIkm()
      const keys = await newKeys(ikm)
      const record_key = 'k'.repeat(43)
      const { ciphertext, iv } = nodeEncrypt(ikm, JSON.stringify(payload), record_key)

      await expectSyncError(
        decryptSyncRecord(keys, { record_key, ciphertext, iv, enc_v: 1 }),
        'invalid-record',
      )
    })
  })

  it('fails with decrypt-failed when the record content does not match its record_key', async () => {
    const ikm = randomIkm()
    const keys = await newKeys(ikm)
    // A valid record, authentic under AAD = wrongKey, but wrongKey is not
    // HMAC(type:id).
    const record_key = 'w'.repeat(43)
    const { ciphertext, iv } = nodeEncrypt(ikm, JSON.stringify(RECORD), record_key)

    await expectSyncError(
      decryptSyncRecord(keys, { record_key, ciphertext, iv, enc_v: 1 }),
      'decrypt-failed',
    )
    // And the same record under its real key opens.
    const real = nodeRecordKey(ikm, RECORD.type, RECORD.id)
    const ok = nodeEncrypt(ikm, JSON.stringify(RECORD), real)
    await expect(
      decryptSyncRecord(keys, { record_key: real, ciphertext: ok.ciphertext, iv: ok.iv, enc_v: 1 }),
    ).resolves.toEqual(RECORD)
  })
})
