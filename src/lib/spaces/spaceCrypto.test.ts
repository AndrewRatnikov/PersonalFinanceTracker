// CONTRACT_GAP: the exact HKDF info string of the invite-secret wrap is only
//   named in the plan's approach (SPACE_KEY_INVITE_INFO), tested as an
//   exported constant, not through the derived bytes.
// CONTRACT_GAP: the Interface Contract does not say what wrapSpaceKeyForPublicKey
//   does with an sk that is not 32 bytes; it is not tested.
//
// Pure WebCrypto tests, no storage and no mocks.

import { describe, expect, it } from 'vitest'

import type { WrappedSpaceKey } from '@/lib/spaces/spaceCrypto'
import type { SyncRecord } from '@/lib/syncRecords'
import {
  SPACE_KEY_BYTES,
  SPACE_KEY_INVITE_INFO,
  SPACE_KEY_WRAP_INFO,
  SpaceKeyError,
  generateIdentityKeyPair,
  generateSpaceKey,
  importSpaceKey,
  unwrapSpaceKey,
  unwrapSpaceKeyWithSecret,
  wrapSpaceKeyForPublicKey,
  wrapSpaceKeyWithSecret,
} from '@/lib/spaces/spaceCrypto'
import {
  decryptSyncRecord,
  deriveSyncKeys,
  encryptSyncRecord,
  recordKeyFor,
} from '@/lib/cloud/recordCrypto'
import { decryptValue, encryptValue } from '@/lib/crypto'

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n))
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(SpaceKeyError)
  return (err as SpaceKeyError).code
}

describe('constants', () => {
  it('names the key size and the HKDF infos', () => {
    expect(SPACE_KEY_BYTES).toBe(32)
    expect(SPACE_KEY_WRAP_INFO).toBe('minima-space-key-wrap-v1')
    expect(SPACE_KEY_INVITE_INFO).toBe('minima-space-key-invite-v1')
  })
})

describe('generateSpaceKey', () => {
  it('returns 32 random bytes, different on every call', () => {
    const a = generateSpaceKey()
    const b = generateSpaceKey()

    expect(a).toBeInstanceOf(Uint8Array)
    expect(a.byteLength).toBe(32)
    expect(b.byteLength).toBe(32)
    expect(Array.from(a)).not.toEqual(Array.from(b))
    expect(a.some((byte) => byte !== 0)).toBe(true)
  })
})

describe('importSpaceKey', () => {
  it('returns a non-extractable AES-GCM key that encrypts and decrypts', async () => {
    const key = await importSpaceKey(generateSpaceKey())

    expect(key.algorithm.name).toBe('AES-GCM')
    expect(key.extractable).toBe(false)
    expect([...key.usages].sort()).toEqual(['decrypt', 'encrypt'])

    const blob = await encryptValue(key, [{ id: 'x', amount: 5 }])
    expect(await decryptValue(key, blob)).toEqual([{ id: 'x', amount: 5 }])
  })

  it('two different space keys cannot open each other’s data', async () => {
    const a = await importSpaceKey(generateSpaceKey())
    const b = await importSpaceKey(generateSpaceKey())

    const blob = await encryptValue(a, { v: 1 })

    await expect(decryptValue(b, blob)).rejects.toBeDefined()
    expect(await decryptValue(a, blob)).toEqual({ v: 1 })
  })

  it('the same bytes give a key that opens the same data', async () => {
    const bytes = generateSpaceKey()
    const first = await importSpaceKey(bytes)
    const second = await importSpaceKey(bytes)

    const blob = await encryptValue(first, 'hello')

    expect(await decryptValue(second, blob)).toBe('hello')
  })

  it('a device key (DEK) cannot open data encrypted with a space key', async () => {
    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])
    const sk = await importSpaceKey(generateSpaceKey())

    const blob = await encryptValue(sk, ['family'])

    await expect(decryptValue(dek, blob)).rejects.toBeDefined()
  })
})

describe('generateIdentityKeyPair', () => {
  it('returns an ECDH P-256 pair with an extractable private JWK', async () => {
    const pair = await generateIdentityKeyPair()

    expect(pair.publicKeyJwk.kty).toBe('EC')
    expect(pair.publicKeyJwk.crv).toBe('P-256')
    expect(pair.publicKeyJwk.x).toEqual(expect.any(String))
    expect(pair.publicKeyJwk.y).toEqual(expect.any(String))
    expect(pair.publicKeyJwk.d).toBeUndefined()

    expect(pair.privateKeyJwk.kty).toBe('EC')
    expect(pair.privateKeyJwk.crv).toBe('P-256')
    expect(pair.privateKeyJwk.d).toEqual(expect.any(String))
    // The public half is the same point.
    expect(pair.privateKeyJwk.x).toBe(pair.publicKeyJwk.x)
    expect(pair.privateKeyJwk.y).toBe(pair.publicKeyJwk.y)
  })

  it('two pairs differ', async () => {
    const a = await generateIdentityKeyPair()
    const b = await generateIdentityKeyPair()

    expect(a.publicKeyJwk.x).not.toBe(b.publicKeyJwk.x)
    expect(a.privateKeyJwk.d).not.toBe(b.privateKeyJwk.d)
  })
})

describe('wrapSpaceKeyForPublicKey / unwrapSpaceKey', () => {
  it('round-trips a space key', async () => {
    const sk = generateSpaceKey()
    const me = await generateIdentityKeyPair()

    const wrapped = await wrapSpaceKeyForPublicKey(sk, me.publicKeyJwk)
    const opened = await unwrapSpaceKey(wrapped, me.privateKeyJwk)

    expect(Array.from(opened)).toEqual(Array.from(sk))
  })

  it('has the shape { v: 1, epk, iv, ct } with a public ephemeral key', async () => {
    const me = await generateIdentityKeyPair()

    const wrapped = await wrapSpaceKeyForPublicKey(generateSpaceKey(), me.publicKeyJwk)

    expect(Object.keys(wrapped).sort()).toEqual(['ct', 'epk', 'iv', 'v'])
    expect(wrapped.v).toBe(1)
    expect(wrapped.epk.kty).toBe('EC')
    expect(wrapped.epk.crv).toBe('P-256')
    expect(wrapped.epk.d).toBeUndefined()
    expect(wrapped.epk.x).not.toBe(me.publicKeyJwk.x)
    expect(typeof wrapped.iv).toBe('string')
    expect(typeof wrapped.ct).toBe('string')
  })

  it('uses a fresh ephemeral key and iv for every wrap', async () => {
    const sk = generateSpaceKey()
    const me = await generateIdentityKeyPair()

    const first = await wrapSpaceKeyForPublicKey(sk, me.publicKeyJwk)
    const second = await wrapSpaceKeyForPublicKey(sk, me.publicKeyJwk)

    expect(first.epk.x).not.toBe(second.epk.x)
    expect(first.iv).not.toBe(second.iv)
    expect(first.ct).not.toBe(second.ct)
    // Both still open.
    expect(Array.from(await unwrapSpaceKey(second, me.privateKeyJwk))).toEqual(
      Array.from(sk),
    )
  })

  it('does not contain the raw key in the clear', async () => {
    const sk = generateSpaceKey()
    const me = await generateIdentityKeyPair()

    const wrapped = await wrapSpaceKeyForPublicKey(sk, me.publicKeyJwk)

    const b64 = btoa(String.fromCharCode(...sk))
    expect(JSON.stringify(wrapped)).not.toContain(b64)
  })

  it('unwrapping with a different private key fails with unwrap-failed', async () => {
    const sk = generateSpaceKey()
    const me = await generateIdentityKeyPair()
    const other = await generateIdentityKeyPair()

    const wrapped = await wrapSpaceKeyForPublicKey(sk, me.publicKeyJwk)

    expect(await codeOf(unwrapSpaceKey(wrapped, other.privateKeyJwk))).toBe(
      'unwrap-failed',
    )
  })

  it('a tampered ciphertext fails with unwrap-failed', async () => {
    const me = await generateIdentityKeyPair()
    const wrapped = await wrapSpaceKeyForPublicKey(generateSpaceKey(), me.publicKeyJwk)
    const bytes = Uint8Array.from(atob(wrapped.ct), (c) => c.charCodeAt(0))
    bytes[0] ^= 0xff
    const tampered: WrappedSpaceKey = {
      ...wrapped,
      ct: btoa(String.fromCharCode(...bytes)),
    }

    expect(await codeOf(unwrapSpaceKey(tampered, me.privateKeyJwk))).toBe(
      'unwrap-failed',
    )
  })

  it('a malformed wrapped key fails with invalid', async () => {
    const me = await generateIdentityKeyPair()

    expect(
      await codeOf(unwrapSpaceKey({} as unknown as WrappedSpaceKey, me.privateKeyJwk)),
    ).toBe('invalid')
  })
})

describe('wrapSpaceKeyWithSecret / unwrapSpaceKeyWithSecret', () => {
  it('round-trips with a 32-byte secret', async () => {
    const sk = generateSpaceKey()
    const secret = randomBytes(32)

    const wrapped = await wrapSpaceKeyWithSecret(sk, secret)
    const opened = await unwrapSpaceKeyWithSecret(wrapped, secret)

    expect(Array.from(opened)).toEqual(Array.from(sk))
  })

  it('has the shape { v: 1, iv, ct } and no ephemeral key', async () => {
    const wrapped = await wrapSpaceKeyWithSecret(generateSpaceKey(), randomBytes(32))

    expect(Object.keys(wrapped).sort()).toEqual(['ct', 'iv', 'v'])
    expect(wrapped.v).toBe(1)
  })

  it('a wrong secret fails with unwrap-failed', async () => {
    const sk = generateSpaceKey()
    const wrapped = await wrapSpaceKeyWithSecret(sk, randomBytes(32))

    expect(await codeOf(unwrapSpaceKeyWithSecret(wrapped, randomBytes(32)))).toBe(
      'unwrap-failed',
    )
  })

  it('does not change the caller’s secret buffer', async () => {
    const secret = randomBytes(32)
    const copy = Array.from(secret)
    const wrapped = await wrapSpaceKeyWithSecret(generateSpaceKey(), secret)

    expect(Array.from(secret)).toEqual(copy)
    // The same secret still opens it.
    await expect(unwrapSpaceKeyWithSecret(wrapped, secret)).resolves.toBeDefined()
  })

  it.each([0, 16, 31, 33, 64])(
    'a secret of %i bytes is rejected with invalid (wrap and unwrap)',
    async (length) => {
      const good = await wrapSpaceKeyWithSecret(generateSpaceKey(), randomBytes(32))

      expect(
        await codeOf(wrapSpaceKeyWithSecret(generateSpaceKey(), randomBytes(length))),
      ).toBe('invalid')
      expect(await codeOf(unwrapSpaceKeyWithSecret(good, randomBytes(length)))).toBe(
        'invalid',
      )
    },
  )

  it('the secret wrap and the public key wrap are different formats', async () => {
    const sk = generateSpaceKey()
    const me = await generateIdentityKeyPair()

    const bySecret = await wrapSpaceKeyWithSecret(sk, randomBytes(32))
    const byKey = await wrapSpaceKeyForPublicKey(sk, me.publicKeyJwk)

    expect('epk' in bySecret).toBe(false)
    expect('epk' in byKey).toBe(true)
  })
})

describe('deriveSyncKeys accepts a space key', () => {
  it('derives different record keys from the SK and from a DEK-like root key', async () => {
    const skBytes = generateSpaceKey()
    const dekBytes = generateSpaceKey()

    const fromSk = await deriveSyncKeys(skBytes)
    const fromDek = await deriveSyncKeys(dekBytes)

    const a = await recordKeyFor(fromSk, 'expense', 'x')
    const b = await recordKeyFor(fromDek, 'expense', 'x')

    expect(a).not.toBe(b)
    expect(a).toHaveLength(43)
  })

  it('is deterministic for the same root key bytes', async () => {
    const bytes = generateSpaceKey()

    const first = await recordKeyFor(await deriveSyncKeys(bytes), 'expense', 'x')
    const second = await recordKeyFor(await deriveSyncKeys(bytes), 'expense', 'x')
    const otherId = await recordKeyFor(await deriveSyncKeys(bytes), 'expense', 'y')

    expect(first).toBe(second)
    expect(otherId).not.toBe(first)
  })

  it('does not zero or change the caller’s root key bytes', async () => {
    const bytes = generateSpaceKey()
    const copy = Array.from(bytes)

    await deriveSyncKeys(bytes)

    expect(Array.from(bytes)).toEqual(copy)
  })

  it.each([0, 16, 31, 33])('refuses raw root keys of %i bytes', async (length) => {
    await expect(deriveSyncKeys(randomBytes(length))).rejects.toBeInstanceOf(TypeError)
  })
})

describe('the new sync record types', () => {
  const NEW_TYPES = ['identity', 'spaceKey', 'spaceInfo', 'memberProfile'] as const

  it.each(NEW_TYPES)('%s encrypts and decrypts through the record format', async (type) => {
    const keys = await deriveSyncKeys(generateSpaceKey())
    const record: SyncRecord = {
      type,
      id: `${type}-1`,
      updatedAt: '2026-10-28T10:00:00.000Z',
      data: { id: `${type}-1`, note: 'payload' },
    }

    const row = await encryptSyncRecord(keys, record)
    const opened = await decryptSyncRecord(keys, row)

    expect(opened).toEqual(record)
  })

  it('records of different types with the same id get different record keys', async () => {
    const keys = await deriveSyncKeys(generateSpaceKey())

    const ids = await Promise.all(
      (['identity', 'spaceKey', 'spaceInfo', 'memberProfile'] as const).map((type) =>
        recordKeyFor(keys, type, 'same'),
      ),
    )

    expect(new Set(ids).size).toBe(4)
  })
})
