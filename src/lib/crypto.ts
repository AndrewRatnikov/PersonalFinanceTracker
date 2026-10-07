const SALT_KEY_PREFIX = 'minima_device_salt_'

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hexDecode(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export function getOrCreateDeviceSalt(userId: string): Uint8Array<ArrayBuffer> {
  if (typeof window === 'undefined') {
    throw new Error('getOrCreateDeviceSalt must be called on the client')
  }
  const key = SALT_KEY_PREFIX + userId
  const stored = localStorage.getItem(key)
  if (stored) return hexDecode(stored)
  const salt = crypto.getRandomValues(new Uint8Array(32))
  localStorage.setItem(key, hexEncode(salt))
  return salt
}

// Reads the v1 device salt without ever creating one (used by the v1 -> v2
// migration only).
export function readDeviceSalt(userId: string): Uint8Array<ArrayBuffer> | null {
  if (typeof window === 'undefined') return null
  const stored = localStorage.getItem(SALT_KEY_PREFIX + userId)
  if (!stored || stored.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(stored)) {
    return null
  }
  return hexDecode(stored)
}

// ── Base64 (header fields) ────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ── Recovery key (160-bit, Crockford base32) ──────────────────────────────────

export const RECOVERY_KEY_BYTES = 20

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RECOVERY_KEY_CHARS = (RECOVERY_KEY_BYTES * 8) / 5 // 32
const RECOVERY_KEY_GROUP = 5

// 20 bytes -> "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX" (big-endian bit order).
export function encodeRecoveryKey(bytes: Uint8Array): string {
  if (bytes.length !== RECOVERY_KEY_BYTES) {
    throw new Error(
      `encodeRecoveryKey: expected ${RECOVERY_KEY_BYTES} bytes, got ${bytes.length}`,
    )
  }
  let chars = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff
    bits += 8
    while (bits >= 5) {
      bits -= 5
      chars += CROCKFORD_ALPHABET[(buffer >> bits) & 0x1f]
    }
  }
  const groups: Array<string> = []
  for (let i = 0; i < chars.length; i += RECOVERY_KEY_GROUP) {
    groups.push(chars.slice(i, i + RECOVERY_KEY_GROUP))
  }
  return groups.join('-')
}

// Ignores case, whitespace and dashes. Anything that isn't exactly 32 alphabet
// characters returns null.
export function parseRecoveryKey(input: string): Uint8Array<ArrayBuffer> | null {
  const clean = input.toUpperCase().replace(/[\s-]/g, '')
  if (clean.length !== RECOVERY_KEY_CHARS) return null
  const bytes = new Uint8Array(RECOVERY_KEY_BYTES)
  let buffer = 0
  let bits = 0
  let index = 0
  for (const ch of clean) {
    const value = CROCKFORD_ALPHABET.indexOf(ch)
    if (value === -1) return null
    buffer = ((buffer << 5) | value) & 0xfff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes[index++] = (buffer >> bits) & 0xff
    }
  }
  return bytes
}

export async function deriveKey(
  password: string,
  deviceSalt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: deviceSalt, iterations: 200_000 },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

const VERIFIER_KEY_PREFIX = 'minima_key_verify_'
const VERIFIER_SENTINEL = 'minima-verify-v1'

export async function storeKeyVerifier(
  key: CryptoKey,
  userId: string,
): Promise<void> {
  const encrypted = await encryptValue(key, VERIFIER_SENTINEL)
  localStorage.setItem(VERIFIER_KEY_PREFIX + userId, hexEncode(encrypted))
}

export async function checkKeyVerifier(
  key: CryptoKey,
  userId: string,
): Promise<boolean> {
  const stored = localStorage.getItem(VERIFIER_KEY_PREFIX + userId)
  if (!stored) return false
  try {
    const decrypted = await decryptValue(key, hexDecode(stored))
    return decrypted === VERIFIER_SENTINEL
  } catch {
    return false
  }
}

export async function encryptValue(
  key: CryptoKey,
  value: unknown,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(JSON.stringify(value))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded,
  )
  const result = new Uint8Array(12 + ciphertext.byteLength)
  result.set(iv, 0)
  result.set(new Uint8Array(ciphertext), 12)
  return result
}

export async function decryptValue(
  key: CryptoKey,
  data: Uint8Array,
): Promise<unknown> {
  const iv = data.slice(0, 12)
  const ciphertext = data.slice(12)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  )
  return JSON.parse(new TextDecoder().decode(plaintext))
}
