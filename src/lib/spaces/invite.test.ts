// @vitest-environment node
// No CONTRACT_GAPs: the invite helpers are specified in the Interface Contract
// (invite.ts). Known-answer vectors are computed with node's own hkdfSync and
// createHash, so the module is checked against an independent implementation.

import { createHash, hkdfSync } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  INVITE_PATH,
  INVITE_SECRET_BYTES,
  INVITE_TOKEN_INFO,
  buildInviteUrl,
  createInviteSecret,
  inviteToken,
  inviteTokenHash,
  parseInviteFragment,
} from '@/lib/spaces/invite'

const ID = '3f2b1c4e-5a6d-4e8f-9a0b-1c2d3e4f5a6b'

function bytes(start: number, length = 32): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_, i) => (start + i) % 256)
}

function b64url(data: Uint8Array): string {
  return Buffer.from(data).toString('base64url')
}

function nodeToken(secret: Uint8Array): string {
  const okm = hkdfSync('sha256', secret, new Uint8Array(0), 'minima-invite-token-v1', 32)
  return Buffer.from(okm).toString('base64url')
}

describe('constants', () => {
  it('has the documented values', () => {
    expect(INVITE_TOKEN_INFO).toBe('minima-invite-token-v1')
    expect(INVITE_SECRET_BYTES).toBe(32)
    expect(INVITE_PATH).toBe('/join')
  })
})

describe('createInviteSecret', () => {
  it('returns 32 random bytes, different every time', () => {
    const a = createInviteSecret()
    const b = createInviteSecret()
    expect(a).toBeInstanceOf(Uint8Array)
    expect(a).toHaveLength(32)
    expect(b).toHaveLength(32)
    expect(Array.from(a)).not.toEqual(Array.from(b))
    expect(a.some((x) => x !== 0)).toBe(true)
  })
})

describe('inviteToken', () => {
  it('is 43 base64url characters without padding', async () => {
    const token = await inviteToken(createInviteSecret())
    expect(token).toHaveLength(43)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('is deterministic and depends on the secret', async () => {
    const a = bytes(0)
    const b = bytes(1)
    expect(await inviteToken(a)).toBe(await inviteToken(bytes(0)))
    expect(await inviteToken(a)).not.toBe(await inviteToken(b))
  })

  it.each([0, 100, 200])('matches HKDF-SHA256 computed by node (known answer from byte %i)', async (start) => {
    const secret = bytes(start)
    expect(await inviteToken(secret)).toBe(nodeToken(secret))
  })

  it('is not the secret itself or a plain hash of it', async () => {
    const secret = bytes(7)
    const token = await inviteToken(secret)
    expect(token).not.toBe(b64url(secret))
    expect(token).not.toBe(createHash('sha256').update(secret).digest('base64url'))
  })

  it('rejects a secret that is not 32 bytes with a TypeError', async () => {
    for (const length of [0, 16, 31, 33, 64]) {
      await expect(inviteToken(new Uint8Array(length))).rejects.toThrow(TypeError)
    }
  })

  it('accepts a view into a bigger buffer', async () => {
    const big = bytes(0, 64)
    const view = big.subarray(10, 42)
    expect(await inviteToken(view)).toBe(nodeToken(Uint8Array.from(view)))
  })
})

describe('inviteTokenHash', () => {
  it('is 64 lowercase hex characters', async () => {
    const hash = await inviteTokenHash(await inviteToken(createInviteSecret()))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("equals node's sha256 of the UTF-8 token", async () => {
    for (const token of ['abc', 'a'.repeat(43), 'héllo-wörld', '']) {
      expect(await inviteTokenHash(token)).toBe(
        createHash('sha256').update(token, 'utf8').digest('hex'),
      )
    }
  })

  it('has the SHA-256 known answer for "abc"', async () => {
    expect(await inviteTokenHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('differs for different tokens and is deterministic', async () => {
    expect(await inviteTokenHash('one')).not.toBe(await inviteTokenHash('two'))
    expect(await inviteTokenHash('one')).toBe(await inviteTokenHash('one'))
  })

  it('hashes the base64url token string, not the raw bytes', async () => {
    const secret = bytes(3)
    const token = await inviteToken(secret)
    const rawBytes = Buffer.from(token, 'base64url')
    expect(await inviteTokenHash(token)).not.toBe(createHash('sha256').update(rawBytes).digest('hex'))
    expect(await inviteTokenHash(token)).toBe(createHash('sha256').update(token).digest('hex'))
  })
})

describe('buildInviteUrl', () => {
  it('puts the invite id and the secret after a # and never in a query string', () => {
    const secret = bytes(9)
    const url = buildInviteUrl('https://app.example.com', ID, secret)
    expect(url).toBe(`https://app.example.com/join#${ID}.${b64url(secret)}`)
    expect(url).not.toContain('?')
    expect(url.split('#')).toHaveLength(2)
    expect(new URL(url).search).toBe('')
    expect(new URL(url).pathname).toBe('/join')
    // The part the server would see (everything before #) has no secret.
    expect(url.split('#')[0]).not.toContain(b64url(secret))
  })

  it('drops one trailing slash from the origin', () => {
    const secret = bytes(9)
    expect(buildInviteUrl('http://localhost:3000/', ID, secret)).toBe(
      `http://localhost:3000/join#${ID}.${b64url(secret)}`,
    )
    expect(buildInviteUrl('http://localhost:3000', ID, secret)).toBe(
      buildInviteUrl('http://localhost:3000/', ID, secret),
    )
  })

  it('encodes different secrets differently, with 43 base64url characters', () => {
    const a = buildInviteUrl('https://x.test', ID, bytes(1))
    const b = buildInviteUrl('https://x.test', ID, bytes(2))
    expect(a).not.toBe(b)
    expect(a.split('.').at(-1)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('throws a TypeError for a secret that is not 32 bytes', () => {
    for (const length of [0, 31, 33]) {
      expect(() => buildInviteUrl('https://x.test', ID, new Uint8Array(length))).toThrow(TypeError)
    }
  })
})

describe('parseInviteFragment', () => {
  it('round-trips with and without the leading #', () => {
    const secret = createInviteSecret()
    const url = buildInviteUrl('https://app.example.com', ID, secret)
    const hash = new URL(url).hash
    expect(hash.startsWith('#')).toBe(true)

    for (const input of [hash, hash.slice(1)]) {
      const parsed = parseInviteFragment(input)
      expect(parsed?.inviteId).toBe(ID)
      expect(Array.from(parsed?.secret ?? [])).toEqual(Array.from(secret))
    }
  })

  it('round-trips into the same token the owner hashed', async () => {
    const secret = createInviteSecret()
    const parsed = parseInviteFragment(new URL(buildInviteUrl('https://x.test', ID, secret)).hash)
    expect(parsed).not.toBeNull()
    expect(await inviteToken(parsed?.secret ?? new Uint8Array(0))).toBe(await inviteToken(secret))
  })

  it('accepts an upper-case invite id', () => {
    const secret = bytes(5)
    const parsed = parseInviteFragment(`#${ID.toUpperCase()}.${b64url(secret)}`)
    expect(parsed?.inviteId.toLowerCase()).toBe(ID)
  })

  it('returns a 32-byte secret', () => {
    const parsed = parseInviteFragment(`${ID}.${b64url(bytes(5))}`)
    expect(parsed?.secret).toHaveLength(32)
  })

  const SECRET = b64url(bytes(5))
  const MALFORMED: Array<[string, string]> = [
    ['empty', ''],
    ['only a #', '#'],
    ['no dot', `${ID}${SECRET}`],
    ['id only', ID],
    ['id and a dot', `${ID}.`],
    ['secret only', `.${SECRET}`],
    ['bad uuid', `not-a-uuid.${SECRET}`],
    ['uuid with a wrong length', `${ID.slice(1)}.${SECRET}`],
    ['uuid with non-hex characters', `${ID.replace('3f2b', 'zzzz')}.${SECRET}`],
    ['secret too short (42 chars)', `${ID}.${SECRET.slice(1)}`],
    ['secret too long (44 chars)', `${ID}.${SECRET}A`],
    ['padding', `${ID}.${SECRET}=`],
    ['standard base64 characters', `${ID}.${SECRET.slice(0, 40)}+/A`],
    ['a space in the secret', `${ID}.${SECRET.slice(0, 40)} AA`],
    ['extra parts', `${ID}.${SECRET}.${SECRET}`],
    ['two dots', `${ID}..${SECRET}`],
    ['a query string', `${ID}.${SECRET}?x=1`],
    ['a second #', `#${ID}.${SECRET}#`],
    ['a very long input', 'x'.repeat(20000)],
  ]

  it.each(MALFORMED)('returns null for %s', (_name, input) => {
    expect(parseInviteFragment(input)).toBeNull()
  })

  it('never throws', () => {
    for (const [, input] of MALFORMED) {
      expect(() => parseInviteFragment(input)).not.toThrow()
    }
  })
})
