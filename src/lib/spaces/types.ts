// Spaces (spec §20): ids, storage keys, record types and errors. Pure: no
// imports except types.
//
// The Personal space keeps every storage key unchanged. A Family space stores
// the same data keys under `space:<spaceId>:<baseKey>`; keyFor is the only
// place such a key is built.

export type SpaceId = string

export const PERSONAL_SPACE_ID = 'personal'
export const SPACE_KEY_PREFIX = 'space:'

const FAMILY_ID_RE = /^[A-Za-z0-9-]{1,64}$/
const SPACE_STORAGE_KEY_RE = /^space:([A-Za-z0-9-]{1,64}):(.+)$/

export function isPersonalSpace(spaceId: SpaceId): boolean {
  return spaceId === PERSONAL_SPACE_ID
}

export function isValidFamilySpaceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== PERSONAL_SPACE_ID &&
    FAMILY_ID_RE.test(value)
  )
}

// personal -> baseKey unchanged; a Family id -> `space:<id>:<baseKey>`.
export function keyFor(spaceId: SpaceId, baseKey: string): string {
  if (spaceId === PERSONAL_SPACE_ID) return baseKey
  if (!isValidFamilySpaceId(spaceId)) {
    throw new TypeError(`keyFor: invalid space id "${spaceId}"`)
  }
  return `${SPACE_KEY_PREFIX}${spaceId}:${baseKey}`
}

// `space:<id>:<rest>` -> { spaceId, baseKey }; anything else (personal keys,
// quarantine copies) -> null.
export function parseSpaceStorageKey(
  key: string,
): { spaceId: string; baseKey: string } | null {
  const match = SPACE_STORAGE_KEY_RE.exec(key)
  if (!match || match[1] === PERSONAL_SPACE_ID) return null
  return { spaceId: match[1], baseKey: match[2] }
}

export type SpaceRole = 'owner' | 'member'

// The share status of a space on this user's devices (spec §22). Absent on
// an entry means a local-only space that was never shared.
export type SpaceShareStatus = 'active' | 'removed' | 'left' | 'space-gone'

// Statuses that keep a read-only local copy: readable, backed up, exported,
// never written by the user.
export const READ_ONLY_SPACE_STATUSES: ReadonlyArray<SpaceShareStatus> = [
  'removed',
  'left',
  'space-gone',
]

export function isReadOnlyShareStatus(status: SpaceShareStatus | undefined): boolean {
  return status !== undefined && READ_ONLY_SPACE_STATUSES.includes(status)
}

// The owner's bookkeeping of who holds a wrap of keyVersion (decision D3).
export interface SpaceKeyWrapSet {
  keyVersion: number
  userIds: Array<string>
}

// One entry of the personal `spaceKeys` record per space (id = spaceId). The
// newest key writes; older versions in previousKeys are only read.
export interface SpaceKeyEntry {
  id: string
  keyVersion: number
  /** base64 of 32 bytes; '' on a tombstone. */
  key: string
  previousKeys?: Array<{ keyVersion: number; key: string }>
  name: string
  role: SpaceRole
  joinedAt: string
  updatedAt: string
  deletedAt?: string
  rev?: number
  /** base64 of 32 bytes: the Family record index key; never rotated. */
  indexKey?: string
  /** The share status; absent for a local-only space. */
  status?: SpaceShareStatus
  /** Owner only: who holds a wrap of `wrappedFor.keyVersion`. */
  wrappedFor?: SpaceKeyWrapSet
}

export interface IdentityRecord {
  id: 'identity'
  publicKeyJwk: JsonWebKey
  privateKeyJwk: JsonWebKey
  createdAt: string
  updatedAt: string
  rev?: number
}

export interface SpaceInfoRecord {
  id: 'space'
  name: string
  createdAt: string
  updatedAt: string
  createdBy?: string
  updatedBy?: string
  rev?: number
}

export interface MemberProfile {
  id: string
  displayName: string
  color: string
  updatedAt: string
  updatedBy?: string
  deletedAt?: string
  rev?: number
}

export interface LocalSpace {
  id: string
  name: string
  role: SpaceRole
  keyVersion: number
  joinedAt: string
}

// A Family space whose key is missing, or whose key is not available because
// the vault is locked. Family data is never read or written with the DEK.
export class SpaceLockedError extends Error {
  readonly code = 'space-locked' as const
  readonly spaceId: string
  constructor(spaceId: string) {
    super(`Space ${spaceId} is locked or its key is missing`)
    this.name = 'SpaceLockedError'
    this.spaceId = spaceId
  }
}

export function isSpaceLockedError(err: unknown): err is SpaceLockedError {
  if (err instanceof SpaceLockedError) return true
  return (
    err instanceof Error &&
    err.name === 'SpaceLockedError' &&
    typeof (err as { spaceId?: unknown }).spaceId === 'string'
  )
}

// A user write into a Family space this user no longer belongs to (removed,
// left, or the space was deleted). Nothing is written.
export class SpaceReadOnlyError extends Error {
  readonly code = 'space-read-only' as const
  readonly spaceId: string
  constructor(spaceId: string) {
    super(`Space ${spaceId} is read-only`)
    this.name = 'SpaceReadOnlyError'
    this.spaceId = spaceId
  }
}

export function isSpaceReadOnlyError(err: unknown): err is SpaceReadOnlyError {
  if (err instanceof SpaceReadOnlyError) return true
  return (
    err instanceof Error &&
    err.name === 'SpaceReadOnlyError' &&
    typeof (err as { spaceId?: unknown }).spaceId === 'string'
  )
}

export type SpaceErrorCode = 'invalid-name' | 'family-space-exists' | 'unknown-space'

export class SpaceError extends Error {
  readonly code: SpaceErrorCode
  constructor(code: SpaceErrorCode, message: string = code) {
    super(message)
    this.name = 'SpaceError'
    this.code = code
  }
}
