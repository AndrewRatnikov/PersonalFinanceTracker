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

async function openWith(key: CryptoKey, iv: Uint8Array<ArrayBuffer>, ct: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  let opened: Uint8Array<ArrayBuffer>
  try {
    opened = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct))
  } catch {
    throw new SpaceKeyError('unwrap-failed', 'The space key could not be unwrapped')
  }
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
  return openWith(key, iv, ct)
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
