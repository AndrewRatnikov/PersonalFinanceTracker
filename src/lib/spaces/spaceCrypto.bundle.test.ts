// No CONTRACT_GAPs: the bundle helpers, the safety code and their errors are
// specified in plan section 1 and the Interface Contract (spaceCrypto.ts).
//
// Pure WebCrypto tests, no storage and no mocks.

import { describe, expect, it } from 'vitest'

import type { SpaceKeyBundle } from '@/lib/spaces/spaceCrypto'
import {
  SpaceKeyError,
  canonicalPublicJwk,
  decodeSpaceKeyBundle,
  encodeSpaceKeyBundle,
  generateIdentityKeyPair,
  generateIndexKey,
  generateSpaceKey,
  safetyCode,
  unwrapSpaceKey,
  unwrapSpaceKeyBundle,
  wrapSpaceKeyBundleForPublicKey,
  wrapSpaceKeyForPublicKey,
} from '@/lib/spaces/spaceCrypto'

function bundle(keyVersion = 1): SpaceKeyBundle {
  return { v: 1, keyVersion, sk: generateSpaceKey(), indexKey: generateIndexKey() }
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(SpaceKeyError)
  return (err as SpaceKeyError).code
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

describe('generateIndexKey', () => {
  it('returns 32 random bytes, different on every call', () => {
    const a = generateIndexKey()
    const b = generateIndexKey()

    expect(a.byteLength).toBe(32)
    expect(b.byteLength).toBe(32)
    expect(Array.from(a)).not.toEqual(Array.from(b))
  })
})

describe('encodeSpaceKeyBundle / decodeSpaceKeyBundle', () => {
  it('encodes UTF-8 JSON { v, keyVersion, sk, indexKey } with base64 keys', () => {
    const b = bundle(3)

    const json = JSON.parse(new TextDecoder().decode(encodeSpaceKeyBundle(b))) as Record<string, unknown>

    expect(json).toEqual({ v: 1, keyVersion: 3, sk: b64(b.sk), indexKey: b64(b.indexKey) })
  })

  it('round-trips and keeps the version', () => {
    const a = bundle(1)
    const b = bundle(7)

    const backA = decodeSpaceKeyBundle(encodeSpaceKeyBundle(a))
    const backB = decodeSpaceKeyBundle(encodeSpaceKeyBundle(b))

    expect(backA.keyVersion).toBe(1)
    expect(backB.keyVersion).toBe(7)
    expect(Array.from(backA.sk)).toEqual(Array.from(a.sk))
    expect(Array.from(backB.indexKey)).toEqual(Array.from(b.indexKey))
    expect(Array.from(backA.sk)).not.toEqual(Array.from(backB.sk))
  })

  function encodeRaw(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value))
  }

  it.each([
    ['not json', new TextEncoder().encode('nope')],
    ['wrong v', encodeRaw({ v: 2, keyVersion: 1, sk: b64(new Uint8Array(32)), indexKey: b64(new Uint8Array(32)) })],
    ['keyVersion 0', encodeRaw({ v: 1, keyVersion: 0, sk: b64(new Uint8Array(32)), indexKey: b64(new Uint8Array(32)) })],
    ['fractional keyVersion', encodeRaw({ v: 1, keyVersion: 1.5, sk: b64(new Uint8Array(32)), indexKey: b64(new Uint8Array(32)) })],
    ['short sk', encodeRaw({ v: 1, keyVersion: 1, sk: b64(new Uint8Array(16)), indexKey: b64(new Uint8Array(32)) })],
    ['short indexKey', encodeRaw({ v: 1, keyVersion: 1, sk: b64(new Uint8Array(32)), indexKey: b64(new Uint8Array(31)) })],
    ['missing indexKey', encodeRaw({ v: 1, keyVersion: 1, sk: b64(new Uint8Array(32)) })],
  ])('decode rejects %s with SpaceKeyError(invalid)', (_name, bytes) => {
    let thrown: unknown = null
    try {
      decodeSpaceKeyBundle(bytes)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SpaceKeyError)
    expect((thrown as SpaceKeyError).code).toBe('invalid')
  })
})

describe('wrapSpaceKeyBundleForPublicKey / unwrapSpaceKeyBundle', () => {
  it('uses the same { v: 1, epk, iv, ct } ECIES envelope as the plain key wrap', async () => {
    const pair = await generateIdentityKeyPair()

    const bundled = await wrapSpaceKeyBundleForPublicKey(bundle(), pair.publicKeyJwk)
    const plain = await wrapSpaceKeyForPublicKey(generateSpaceKey(), pair.publicKeyJwk)

    expect(Object.keys(bundled).sort()).toEqual(Object.keys(plain).sort())
    expect(bundled.v).toBe(1)
    expect(bundled.epk.kty).toBe('EC')
    expect(bundled.epk.crv).toBe('P-256')
  })

  it('round-trips keyVersion, sk and indexKey for the recipient', async () => {
    const pair = await generateIdentityKeyPair()
    const one = bundle(2)
    const two = bundle(5)

    const backOne = await unwrapSpaceKeyBundle(
      await wrapSpaceKeyBundleForPublicKey(one, pair.publicKeyJwk),
      pair.privateKeyJwk,
    )
    const backTwo = await unwrapSpaceKeyBundle(
      await wrapSpaceKeyBundleForPublicKey(two, pair.publicKeyJwk),
      pair.privateKeyJwk,
    )

    expect(backOne).toMatchObject({ v: 1, keyVersion: 2 })
    expect(Array.from(backOne.sk)).toEqual(Array.from(one.sk))
    expect(Array.from(backOne.indexKey)).toEqual(Array.from(one.indexKey))
    expect(backTwo.keyVersion).toBe(5)
    expect(Array.from(backTwo.sk)).not.toEqual(Array.from(backOne.sk))
  })

  it('a bundle wrapped for key P cannot be unwrapped with another private key', async () => {
    const p = await generateIdentityKeyPair()
    const other = await generateIdentityKeyPair()
    const wrapped = await wrapSpaceKeyBundleForPublicKey(bundle(), p.publicKeyJwk)

    expect(await codeOf(unwrapSpaceKeyBundle(wrapped, other.privateKeyJwk))).toBe('unwrap-failed')
  })

  it('a tampered ciphertext fails with unwrap-failed', async () => {
    const pair = await generateIdentityKeyPair()
    const wrapped = await wrapSpaceKeyBundleForPublicKey(bundle(), pair.publicKeyJwk)
    const flipped = { ...wrapped, ct: (wrapped.ct.startsWith('A') ? 'B' : 'A') + wrapped.ct.slice(1) }

    expect(await codeOf(unwrapSpaceKeyBundle(flipped, pair.privateKeyJwk))).toBe('unwrap-failed')
  })

  it('wrapping twice gives different envelopes (fresh ephemeral key and iv)', async () => {
    const pair = await generateIdentityKeyPair()
    const b = bundle()

    const first = await wrapSpaceKeyBundleForPublicKey(b, pair.publicKeyJwk)
    const second = await wrapSpaceKeyBundleForPublicKey(b, pair.publicKeyJwk)

    expect(first.ct).not.toBe(second.ct)
    expect(first.iv).not.toBe(second.iv)
  })

  it('the 32-byte key wrap is unchanged and does not open as a bundle', async () => {
    const pair = await generateIdentityKeyPair()
    const sk = generateSpaceKey()
    const wrapped = await wrapSpaceKeyForPublicKey(sk, pair.publicKeyJwk)

    expect(Array.from(await unwrapSpaceKey(wrapped, pair.privateKeyJwk))).toEqual(Array.from(sk))
    expect(await codeOf(unwrapSpaceKeyBundle(wrapped, pair.privateKeyJwk))).toBe('invalid')
  })
})

describe('canonicalPublicJwk', () => {
  it('is JSON of crv, kty, x, y in that order and ignores other members', async () => {
    const { publicKeyJwk } = await generateIdentityKeyPair()

    const canonical = canonicalPublicJwk({ ...publicKeyJwk, key_ops: [], ext: true })

    expect(canonical).toBe(
      JSON.stringify({
        crv: publicKeyJwk.crv,
        kty: publicKeyJwk.kty,
        x: publicKeyJwk.x,
        y: publicKeyJwk.y,
      }),
    )
  })
})

describe('safetyCode', () => {
  it('looks like XXXX-XXXX-XXXX in upper-case hex', async () => {
    const { publicKeyJwk } = await generateIdentityKeyPair()

    expect(await safetyCode(publicKeyJwk)).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
  })

  it('is the first 6 bytes of SHA-256 of the canonical JWK', async () => {
    const { publicKeyJwk } = await generateIdentityKeyPair()
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalPublicJwk(publicKeyJwk))),
    )
    const hex = Array.from(digest.slice(0, 6), (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()

    expect(await safetyCode(publicKeyJwk)).toBe(`${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`)
  })

  it('is the same for the same key (owner and joiner agree) and differs between keys', async () => {
    const a = await generateIdentityKeyPair()
    const b = await generateIdentityKeyPair()

    expect(await safetyCode(a.publicKeyJwk)).toBe(await safetyCode({ ...a.publicKeyJwk }))
    expect(await safetyCode(a.publicKeyJwk)).not.toBe(await safetyCode(b.publicKeyJwk))
  })
})
