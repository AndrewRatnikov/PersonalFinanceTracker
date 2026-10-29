// Family space invite helpers (spec §21, docs/db.md §9). Pure WebCrypto: no
// storage, no network.
//
// An invite link is `${origin}/join#<inviteId>.<base64url(secret)>`. The
// 32-byte secret lives only in the URL fragment, which browsers never send to
// a server. The link carries no space key: the joiner sends an identity public
// key and the owner wraps the space key for it on approval.
//
// The server only ever sees:
//   token      = base64url(HKDF-SHA256(secret, empty salt,
//                info 'minima-invite-token-v1', 256 bits)), 43 chars, sent
//                with get_invite / request_join;
//   token_hash = lowercase hex SHA-256 of utf8(token), stored by create_invite.
// The SQL compares encode(sha256(convert_to(p_token, 'UTF8')), 'hex') with
// token_hash, which is exactly inviteTokenHash(token) (decision D3).

export const INVITE_TOKEN_INFO = 'minima-invite-token-v1'
export const INVITE_SECRET_BYTES = 32
export const INVITE_PATH = '/join'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// 32 bytes are 43 base64url characters without padding.
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/
const B64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function checkSecret(secret: Uint8Array): void {
  if (secret.length !== INVITE_SECRET_BYTES) {
    throw new TypeError(
      `The invite secret must be ${INVITE_SECRET_BYTES} bytes`,
    )
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Decodes unpadded base64url; null for any character outside the alphabet.
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  const out: Array<number> = []
  let buffer = 0
  let bits = 0
  for (const ch of text) {
    const value = B64URL_ALPHABET.indexOf(ch)
    if (value < 0) return null
    buffer = ((buffer << 6) | value) & 0xffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

// 32 random bytes from the platform CSPRNG.
export function createInviteSecret(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(INVITE_SECRET_BYTES))
}

// The token sent to the server: base64url (no padding, 43 chars) of
// HKDF-SHA256(secret, empty salt, info INVITE_TOKEN_INFO, 256 bits). The
// secret is imported as non-extractable key material.
export async function inviteToken(secret: Uint8Array): Promise<string> {
  checkSecret(secret)
  const material = Uint8Array.from(secret)
  try {
    const key = await crypto.subtle.importKey('raw', material, 'HKDF', false, [
      'deriveBits',
    ])
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(INVITE_TOKEN_INFO),
      },
      key,
      256,
    )
    const derived = new Uint8Array(bits)
    const token = toBase64Url(derived)
    derived.fill(0)
    return token
  } finally {
    material.fill(0)
  }
}

// Lowercase hex SHA-256 of utf8(token): what create_invite stores and what the
// server recomputes from the token it receives.
export async function inviteTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  )
  return toHex(new Uint8Array(digest))
}

// `${origin}/join#<inviteId>.<base64url(secret)>`; one trailing `/` on the
// origin is dropped. The secret only ever appears after the `#`.
export function buildInviteUrl(
  origin: string,
  inviteId: string,
  secret: Uint8Array,
): string {
  checkSecret(secret)
  const base = origin.endsWith('/') ? origin.slice(0, -1) : origin
  return `${base}${INVITE_PATH}#${inviteId}.${toBase64Url(secret)}`
}

// Reads `<inviteId>.<secret>` (with or without the leading `#`). Returns null
// for anything malformed; never throws.
export function parseInviteFragment(
  hash: string,
): { inviteId: string; secret: Uint8Array<ArrayBuffer> } | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash
  const parts = fragment.split('.')
  if (parts.length !== 2) return null
  const [inviteId, encoded] = parts
  if (!UUID_PATTERN.test(inviteId) || !SECRET_PATTERN.test(encoded)) return null
  const secret = fromBase64Url(encoded)
  if (!secret || secret.length !== INVITE_SECRET_BYTES) return null
  return { inviteId, secret }
}
