// No CONTRACT_GAPs: encode/parse/base64 helpers are fully specified in the
// Interface Contract (module: crypto additions).

import { describe, expect, it } from 'vitest'

import {
  RECOVERY_KEY_BYTES,
  base64ToBytes,
  bytesToBase64,
  encodeRecoveryKey,
  parseRecoveryKey,
} from '@/lib/crypto'

const KEY_RE =
  /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}-[0-9A-HJKMNP-TV-Z]{2}$/

// First 10 bytes encode (Crockford, big-endian) to "0123456789ABCDEF".
const KNOWN_BYTES = new Uint8Array(20)
KNOWN_BYTES.set([0x00, 0x44, 0x32, 0x14, 0xc7, 0x42, 0x54, 0xb6, 0x35, 0xcf])
const KNOWN_KEY = '01234-56789-ABCDE-F0000-00000-00000-00'

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

describe('RECOVERY_KEY_BYTES', () => {
  it('is 20 (160 bits)', () => {
    expect(RECOVERY_KEY_BYTES).toBe(20)
  })
})

describe('encodeRecoveryKey', () => {
  it('encodes known bytes to the expected Crockford base32 string', () => {
    expect(encodeRecoveryKey(KNOWN_BYTES)).toBe(KNOWN_KEY)
  })

  it('encodes all-zero and all-0xFF bytes to different, correctly formatted keys', () => {
    const zeros = encodeRecoveryKey(new Uint8Array(20))
    const ones = encodeRecoveryKey(new Uint8Array(20).fill(0xff))
    expect(zeros).toBe('00000-00000-00000-00000-00000-00000-00')
    expect(ones).toBe('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZ')
  })

  it('produces keys matching the documented format for random input', () => {
    for (let i = 0; i < 20; i++) {
      expect(encodeRecoveryKey(randomBytes(20))).toMatch(KEY_RE)
    }
  })

  it('throws for any length other than 20 bytes', () => {
    expect(() => encodeRecoveryKey(new Uint8Array(19))).toThrow()
    expect(() => encodeRecoveryKey(new Uint8Array(21))).toThrow()
    expect(() => encodeRecoveryKey(new Uint8Array(0))).toThrow()
  })
})

describe('parseRecoveryKey', () => {
  it('round-trips random keys', () => {
    for (let i = 0; i < 20; i++) {
      const bytes = randomBytes(20)
      const parsed = parseRecoveryKey(encodeRecoveryKey(bytes))
      expect(parsed).not.toBeNull()
      expect(Array.from(parsed ?? [])).toEqual(Array.from(bytes))
    }
  })

  it('decodes the known key to the known bytes', () => {
    expect(Array.from(parseRecoveryKey(KNOWN_KEY) ?? [])).toEqual(
      Array.from(KNOWN_BYTES),
    )
  })

  it('ignores case, spaces and dashes', () => {
    const bytes = randomBytes(20)
    const key = encodeRecoveryKey(bytes)
    const mangled = key.toLowerCase().replace(/-/g, ' ')
    const noSeparators = ' ' + key.toLowerCase().replace(/-/g, '') + '\n'
    const doubleDashes = key.replace(/-/g, '--')

    for (const input of [mangled, noSeparators, doubleDashes]) {
      expect(Array.from(parseRecoveryKey(input) ?? [])).toEqual(
        Array.from(bytes),
      )
    }
  })

  it('returns different bytes for different keys', () => {
    const a = parseRecoveryKey(encodeRecoveryKey(new Uint8Array(20)))
    const b = parseRecoveryKey(encodeRecoveryKey(new Uint8Array(20).fill(1)))
    expect(Array.from(a ?? [])).not.toEqual(Array.from(b ?? []))
  })

  it('returns null for wrong length', () => {
    expect(parseRecoveryKey('')).toBeNull()
    expect(parseRecoveryKey('01234-56789')).toBeNull()
    expect(parseRecoveryKey(KNOWN_KEY + '0')).toBeNull()
    expect(parseRecoveryKey(KNOWN_KEY.slice(0, -1))).toBeNull()
  })

  it('returns null for characters outside the alphabet', () => {
    // 'U' is not in the Crockford alphabet; 'I' is not aliased to '1'.
    expect(parseRecoveryKey('U' + KNOWN_KEY.slice(1))).toBeNull()
    expect(parseRecoveryKey('I' + KNOWN_KEY.slice(1))).toBeNull()
    expect(parseRecoveryKey('!' + KNOWN_KEY.slice(1))).toBeNull()
  })
})

describe('bytesToBase64 / base64ToBytes', () => {
  it('encodes known bytes to standard base64', () => {
    expect(bytesToBase64(new Uint8Array([72, 101, 108, 108, 111]))).toBe(
      'SGVsbG8=',
    )
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('+//+')
  })

  it('decodes standard base64 to bytes', () => {
    expect(Array.from(base64ToBytes('SGVsbG8='))).toEqual([
      72, 101, 108, 108, 111,
    ])
  })

  it('round-trips random buffers of several lengths', () => {
    for (const n of [0, 1, 2, 3, 12, 16, 32, 33]) {
      const bytes = randomBytes(n)
      expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(
        Array.from(bytes),
      )
    }
  })

  it('gives different strings for different bytes', () => {
    expect(bytesToBase64(new Uint8Array([1, 2, 3]))).not.toBe(
      bytesToBase64(new Uint8Array([1, 2, 4])),
    )
  })
})
