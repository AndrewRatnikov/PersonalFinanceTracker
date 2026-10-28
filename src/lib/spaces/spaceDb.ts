// Helpers for modules above localDb (decision D2): they take an optional
// `{ spaceId }` and reach the data through dbFor(spaceId). Personal calls keep
// exactly today's arguments: dbFor('personal') is the localDb module namespace
// itself (so test mocks of its top-level functions are what get called), and
// spaceArgs / withSpaceOption add nothing for personal.

import * as localDb from '../localDb'
import { PERSONAL_SPACE_ID } from './types'
import type { SpaceDb } from '../localDb'
import type { SpaceId } from './types'

export interface SpaceOption {
  spaceId?: SpaceId
}

// Never destructure the result: access `db.fn` at call time only (a mocked
// namespace may not define every member).
export function dbFor(spaceId: SpaceId = PERSONAL_SPACE_ID): SpaceDb {
  if (spaceId === PERSONAL_SPACE_ID) return localDb
  return localDb.spaceDb(spaceId)
}

// Spread as the last argument: `getCurrencySettings(...spaceArgs(spaceId))`.
export function spaceArgs(spaceId: SpaceId): [] | [{ spaceId: string }] {
  return spaceId === PERSONAL_SPACE_ID ? [] : [{ spaceId }]
}

// The same object for personal; a copy with spaceId for a Family space.
export function withSpaceOption<T extends object>(options: T, spaceId: SpaceId): T {
  if (spaceId === PERSONAL_SPACE_ID) return options
  return { ...options, spaceId }
}
