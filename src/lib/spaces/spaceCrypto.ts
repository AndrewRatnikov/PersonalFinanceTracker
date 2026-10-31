// Pure space-key crypto (spec §20, WebCrypto only). No storage; never imports
// localDb or vault.
//
// - A space key (SK) is 32 random bytes. Imported as a non-extractable AES-GCM
//   key it encrypts the Family records in the same format as the DEK encrypts
//   personal ones (crypto.ts encryptValue / decryptValue).
// - A member identity is an ECDH P-256 key pair (extractable private JWK, so
//   it can travel in the encrypted personal `identity` record).
// - wrapSpaceKeyForPublicKey: ECIES style. An ephemeral ECDH P-256 pair,
//   ECDH(ephemeral, recipient) -> 256 bits -> HKDF-SHA256 (empty salt, info
//   SPACE_KEY_WRAP_INFO) -> AES-GCM-256 key; the SK is encrypted with a random
//   12-byte iv. Output { v: 1, epk, iv, ct }.
// - wrapSpaceKeyWithSecret: HKDF-SHA256 from a 32-byte invite secret (empty
//   salt, info SPACE_KEY_INVITE_INFO) -> AES-GCM-256. Output { v: 1, iv, ct }.
// Raw buffers created here for derivation are zeroed after use; the caller's
// SK and secret are never changed.

import { base64ToBytes, bytesToBase64 } from '../crypto'

export const SPACE_KEY_BYTES = 32
export const SPACE_KEY_WRAP_INFO = 'minima-space-key-wrap-v1'
export const SPACE_KEY_INVITE_INFO = 'minima-space-key-invite-v1'

export interface WrappedSpaceKey {
  v: 1
  epk: JsonWebKey
  iv: string
  ct: string
}

export interface SecretWrappedSpaceKey {
  v: 1
  iv: string
  ct: string
}

export interface IdentityKeyPair {
  publicKeyJwk: JsonWebKey
  privateKeyJwk: JsonWebKey
}

export type SpaceKeyErrorCode = 'unwrap-failed' | 'invalid'

export class SpaceKeyError extends Error {
  readonly code: SpaceKeyErrorCode
  constructor(code: SpaceKeyErrorCode, message: string = code) {
    super(message)
    this.name = 'SpaceKeyError'
    this.code = code
  }
}

const IV_BYTES = 12
const EC_PARAMS: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' }
const utf8 = new TextEncoder()
const EMPTY_SALT = new Uint8Array(0)

export function generateSpaceKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SPACE_KEY_BYTES))
}

export async function importSpaceKey(sk: Uint8Array): Promise<CryptoKey> {
  if (sk.byteLength !== SPACE_KEY_BYTES) {
    throw new SpaceKeyError('invalid', 'A space key must be 32 bytes')
  }
  const material = new Uint8Array(sk)
  try {
    return await crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ])
  } finally {
    material.fill(0)
  }
}

export async function generateIdentityKeyPair(): Promise<IdentityKeyPair> {
  const pair = await crypto.subtle.generateKey(EC_PARAMS, true, ['deriveBits'])
  const [publicKeyJwk, privateKeyJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', pair.publicKey),
    crypto.subtle.exportKey('jwk', pair.privateKey),
  ])
  return { publicKeyJwk, privateKeyJwk }
}

// HKDF-SHA256 (empty salt, `info`) over `ikm` -> a non-extractable AES-GCM-256
// key. `ikm` is zeroed.
async function aesKeyFrom(ikm: Uint8Array<ArrayBuffer>, info: string): Promise<CryptoKey> {
  try {
    const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey'])
    return await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: EMPTY_SALT, info: utf8.encode(info) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  } finally {
    ikm.fill(0)
  }
}

async function ecdhBits(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256),
  )
}

function publicOnly(jwk: JsonWebKey): JsonWebKey {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }
}

async function sealWith(key: CryptoKey, sk: Uint8Array): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const plain = new Uint8Array(sk)
  try {
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))
    return { iv: bytesToBase64(iv), ct: bytesToBase64(ct) }
  } finally {
    plain.fill(0)
  }
}

// The length-free open: the plaintext of any size (a key bundle).
async function openRawWith(key: CryptoKey, iv: Uint8Array<ArrayBuffer>, ct: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct))
  } catch {
    throw new SpaceKeyError('unwrap-failed', 'The space key could not be unwrapped')
  }
}

async function openWith(key: CryptoKey, iv: Uint8Array<ArrayBuffer>, ct: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const opened = await openRawWith(key, iv, ct)
  if (opened.byteLength !== SPACE_KEY_BYTES) {
    opened.fill(0)
    throw new SpaceKeyError('invalid', 'The unwrapped space key is not 32 bytes')
  }
  return opened
}

function decodeParts(input: unknown): {
  iv: Uint8Array<ArrayBuffer>
  ct: Uint8Array<ArrayBuffer>
} {
  const wrapped =
    typeof input === 'object' && input !== null
      ? (input as { v?: unknown; iv?: unknown; ct?: unknown })
      : null
  if (
    !wrapped ||
    wrapped.v !== 1 ||
    typeof wrapped.iv !== 'string' ||
    typeof wrapped.ct !== 'string'
  ) {
    throw new SpaceKeyError('invalid', 'Malformed wrapped space key')
  }
  try {
    const iv = base64ToBytes(wrapped.iv)
    const ct = base64ToBytes(wrapped.ct)
    if (iv.byteLength !== IV_BYTES) throw new Error('iv')
    return { iv, ct }
  } catch {
    throw new SpaceKeyError('invalid', 'Malformed wrapped space key')
  }
}

function checkSecret(secret: Uint8Array): void {
  if (!ArrayBuffer.isView(secret) || secret.byteLength !== SPACE_KEY_BYTES) {
    throw new SpaceKeyError('invalid', 'An invite secret must be 32 bytes')
  }
}

export async function wrapSpaceKeyForPublicKey(
  sk: Uint8Array,
  recipientPublicJwk: JsonWebKey,
): Promise<WrappedSpaceKey> {
  let recipient: CryptoKey
  try {
    recipient = await crypto.subtle.importKey('jwk', publicOnly(recipientPublicJwk), EC_PARAMS, false, [])
  } catch {
    throw new SpaceKeyError('invalid', 'Invalid recipient public key')
  }
  const ephemeral = await crypto.subtle.generateKey(EC_PARAMS, true, ['deriveBits'])
  const key = await aesKeyFrom(await ecdhBits(ephemeral.privateKey, recipient), SPACE_KEY_WRAP_INFO)
  const epk = publicOnly(await crypto.subtle.exportKey('jwk', ephemeral.publicKey))
  const { iv, ct } = await sealWith(key, sk)
  return { v: 1, epk, iv, ct }
}

export async function unwrapSpaceKey(
  wrapped: WrappedSpaceKey,
  myPrivateJwk: JsonWebKey,
): Promise<Uint8Array<ArrayBuffer>> {
  const { key, iv, ct } = await envelopeKey(wrapped, myPrivateJwk)
  return openWith(key, iv, ct)
}

// The ECIES receiving side: the AES key of an envelope for my private key.
async function envelopeKey(
  wrapped: WrappedSpaceKey,
  myPrivateJwk: JsonWebKey,
): Promise<{ key: CryptoKey; iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> }> {
  const { iv, ct } = decodeParts(wrapped)
  const epkJwk = (wrapped as { epk?: unknown }).epk
  if (typeof epkJwk !== 'object' || epkJwk === null) {
    throw new SpaceKeyError('invalid', 'Malformed wrapped space key')
  }
  let epk: CryptoKey
  let mine: CryptoKey
  try {
    epk = await crypto.subtle.importKey('jwk', publicOnly(epkJwk as JsonWebKey), EC_PARAMS, false, [])
  } catch {
    throw new SpaceKeyError('invalid', 'Malformed ephemeral key')
  }
  try {
    mine = await crypto.subtle.importKey('jwk', myPrivateJwk, EC_PARAMS, false, ['deriveBits'])
  } catch {
    throw new SpaceKeyError('invalid', 'Invalid private key')
  }
  let bits: Uint8Array<ArrayBuffer>
  try {
    bits = await ecdhBits(mine, epk)
  } catch {
    throw new SpaceKeyError('unwrap-failed', 'The space key could not be unwrapped')
  }
  const key = await aesKeyFrom(bits, SPACE_KEY_WRAP_INFO)
  return { key, iv, ct }
}

// ---- Key bundles (spec §22, decision D1) -----------------------------------
// What is wrapped for a member: UTF-8 JSON
// {"v":1,"keyVersion":n,"sk":"<b64>","indexKey":"<b64>"}. The index key never
// changes (Family record keys stay stable across rotations); sk is per version.

export interface SpaceKeyBundle {
  v: 1
  keyVersion: number
  sk: Uint8Array
  indexKey: Uint8Array
}

export function generateIndexKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SPACE_KEY_BYTES))
}

export function encodeSpaceKeyBundle(bundle: SpaceKeyBundle): Uint8Array<ArrayBuffer> {
  if (bundle.sk.byteLength !== SPACE_KEY_BYTES || bundle.indexKey.byteLength !== SPACE_KEY_BYTES) {
    throw new SpaceKeyError('invalid', 'A key bundle holds two 32-byte keys')
  }
  const json = JSON.stringify({
    v: 1,
    keyVersion: bundle.keyVersion,
    sk: bytesToBase64(bundle.sk),
    indexKey: bytesToBase64(bundle.indexKey),
  })
  return utf8.encode(json)
}

function decodeKey32(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string') return null
  try {
    const bytes = base64ToBytes(value)
    return bytes.byteLength === SPACE_KEY_BYTES ? bytes : null
  } catch {
    return null
  }
}

export function decodeSpaceKeyBundle(bytes: Uint8Array): SpaceKeyBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new SpaceKeyError('invalid', 'Malformed key bundle')
  }
  const obj =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  const keyVersion = obj?.keyVersion
  if (
    !obj ||
    obj.v !== 1 ||
    typeof keyVersion !== 'number' ||
    !Number.isInteger(keyVersion) ||
    keyVersion < 1
  ) {
    throw new SpaceKeyError('invalid', 'Malformed key bundle')
  }
  const sk = decodeKey32(obj.sk)
  const indexKey = decodeKey32(obj.indexKey)
  if (!sk || !indexKey) {
    sk?.fill(0)
    indexKey?.fill(0)
    throw new SpaceKeyError('invalid', 'Malformed key bundle')
  }
  return { v: 1, keyVersion, sk, indexKey }
}

// The same ECIES envelope as wrapSpaceKeyForPublicKey, over the encoded bundle.
export async function wrapSpaceKeyBundleForPublicKey(
  bundle: SpaceKeyBundle,
  recipientPublicJwk: JsonWebKey,
): Promise<WrappedSpaceKey> {
  const plain = encodeSpaceKeyBundle(bundle)
  try {
    return await wrapSpaceKeyForPublicKey(plain, recipientPublicJwk)
  } finally {
    plain.fill(0)
  }
}

export async function unwrapSpaceKeyBundle(
  wrapped: WrappedSpaceKey,
  myPrivateJwk: JsonWebKey,
): Promise<SpaceKeyBundle> {
  const { key, iv, ct } = await envelopeKey(wrapped, myPrivateJwk)
  const plain = await openRawWith(key, iv, ct)
  try {
    return decodeSpaceKeyBundle(plain)
  } finally {
    plain.fill(0)
  }
}

// RFC 7638 member order: exactly crv, kty, x, y.
export function canonicalPublicJwk(jwk: JsonWebKey): string {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
}

// The first 6 bytes of SHA-256(canonical JWK) as XXXX-XXXX-XXXX upper-case
// hex. Owner and joiner compute it from the same public key and compare.
export async function safetyCode(publicJwk: JsonWebKey): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', utf8.encode(canonicalPublicJwk(publicJwk))),
  )
  let hex = ''
  for (const b of digest.slice(0, 6)) hex += b.toString(16).padStart(2, '0')
  hex = hex.toUpperCase()
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`
}

// Reserved: not used. Invites carry no key (see invite.ts); kept for a possible future flow.
export async function wrapSpaceKeyWithSecret(
  sk: Uint8Array,
  inviteSecret: Uint8Array,
): Promise<SecretWrappedSpaceKey> {
  checkSecret(inviteSecret)
  const key = await aesKeyFrom(new Uint8Array(inviteSecret), SPACE_KEY_INVITE_INFO)
  const { iv, ct } = await sealWith(key, sk)
  return { v: 1, iv, ct }
}

// Reserved: not used. Invites carry no key (see invite.ts); kept for a possible future flow.
export async function unwrapSpaceKeyWithSecret(
  wrapped: SecretWrappedSpaceKey,
  inviteSecret: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  checkSecret(inviteSecret)
  const { iv, ct } = decodeParts(wrapped)
  const key = await aesKeyFrom(new Uint8Array(inviteSecret), SPACE_KEY_INVITE_INFO)
  return openWith(key, iv, ct)
}
