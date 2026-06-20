const SALT_KEY_PREFIX = 'minima_device_salt_'

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hexDecode(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export function getOrCreateDeviceSalt(userId: string): Uint8Array {
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

export async function deriveKey(
  password: string,
  deviceSalt: Uint8Array,
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
