// React side of spaces (spec §20). SpaceProvider gives the active space to
// every data hook; in this run it is always 'personal' unless a test passes a
// spaceId (nothing renders a switcher yet, and minima_active_space is not
// read here). Query keys of space data are [base, spaceId, ...rest] so the
// caches of two spaces never mix, while invalidating [base] still covers all.

import { createContext, useContext, useMemo } from 'react'

import { dbFor } from './spaceDb'
import { PERSONAL_SPACE_ID } from './types'
import type { ReactNode } from 'react'
import type { SpaceDb } from '../localDb'
import type { SpaceId } from './types'

const SpaceContext = createContext<SpaceId>(PERSONAL_SPACE_ID)

export function SpaceProvider({
  spaceId,
  children,
}: {
  spaceId?: SpaceId
  children: ReactNode
}) {
  return (
    <SpaceContext.Provider value={spaceId ?? PERSONAL_SPACE_ID}>
      {children}
    </SpaceContext.Provider>
  )
}

export function useActiveSpace(): SpaceId {
  return useContext(SpaceContext)
}

// The data handle of the active space. Never destructure it: call `db.fn(...)`.
export function useSpaceDb(): SpaceDb {
  const spaceId = useActiveSpace()
  return useMemo(() => dbFor(spaceId), [spaceId])
}

export function spaceQueryKey(
  spaceId: SpaceId,
  base: string,
  ...rest: Array<unknown>
): Array<unknown> {
  return [base, spaceId, ...rest]
}
