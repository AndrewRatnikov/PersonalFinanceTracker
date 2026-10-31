// The tab's active space (spec §23, D1). ActiveSpaceRoot holds it in React
// state and gives every screen one context (useSpaceSwitch): the held Family,
// whether the shown space is read-only or paused, the member directory,
// switchTo and a drawer guard. `minima_active_space` is only the shared default
// (written on a switch, read once for the start space); this module never
// subscribes to it or to `storage` events, so a switch never moves another tab.
//
// With the Family unavailable (flags off, accounts hidden) or while locked, no
// query runs and the context is the default: personal, family null, ready.
// Only this module calls sync hooks or reads flags (through the sync hooks);
// components read the context. localDb members are reached inside query
// functions only, since partial test mocks of `@/lib/localDb` throw on access.

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { OPEN_APP_IN_QUERY_KEY, getOpenAppIn } from '../appSettings'
import { getMemberProfiles, getSpaceInfo, listLocalSpaces } from '../localDb'
import { buildMemberDirectory } from '../memberStats'
import { useFamilyAvailable, useFamilySyncState, useSyncState } from '../sync/react'
import { getActiveSpaceId, isShortcutUrl, resolveStartSpace, setActiveSpaceId } from './activeSpace'
import { isSpaceReadOnly } from './keyring'
import { getCurrentMemberId } from './member'
import { SpaceProvider } from './react'
import { PERSONAL_SPACE_ID } from './types'
import type { ReactNode } from 'react'
import type { MemberDirectory } from '../memberStats'
import type { FamilySyncState, FamilySyncStatus } from '../sync/types'
import type { SpaceId, SpaceRole } from './types'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useT } from '@/i18n'

export const FAMILY_SPACE_QUERY_KEY = 'family-space'
export const MEMBER_PROFILES_QUERY_KEY = 'member-profiles'

export interface FamilySpaceSummary {
  id: string
  name: string
  role: SpaceRole
  readOnly: boolean
}

export interface SwitchGuard {
  isDirty: () => boolean
  close: () => void
}

export interface ActiveSpaceState {
  /** The tab's active space ('personal' or family.id). */
  spaceId: SpaceId
  /** Null: flags off, locked, or no Family held. */
  family: FamilySpaceSummary | null
  isFamily: boolean
  /** isFamily && the Family is a read-only copy. */
  readOnly: boolean
  /** isFamily && the Family stream is 'paused'. */
  paused: boolean
  familyStatus: FamilySyncStatus | null
  ready: boolean
  /** Non-null only when isFamily. */
  directory: MemberDirectory | null
  memberId: string | null
  switchTo: (spaceId: SpaceId) => void
  registerGuard: (guard: SwitchGuard) => () => void
}

const noop = (): void => undefined

const DEFAULT_STATE: ActiveSpaceState = {
  spaceId: PERSONAL_SPACE_ID,
  family: null,
  isFamily: false,
  readOnly: false,
  paused: false,
  familyStatus: null,
  ready: true,
  directory: null,
  memberId: null,
  switchTo: noop,
  registerGuard: () => noop,
}

const SwitchContext = createContext<ActiveSpaceState>(DEFAULT_STATE)

// Guards register during the commit, so a click right after a render already
// sees them (a passive effect may not have run yet).
const useCommitEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export function useSpaceSwitch(): ActiveSpaceState {
  return useContext(SwitchContext)
}

export function useSpaceAccess(): { readOnly: boolean; paused: boolean } {
  const { readOnly, paused } = useContext(SwitchContext)
  return { readOnly, paused }
}

// Registers `guard` (e.g. an open drawer) while `active` is true. The latest
// guard object is always used, so callers may pass a fresh one per render.
export function useSwitchGuard(active: boolean, guard: SwitchGuard): void {
  const { registerGuard } = useContext(SwitchContext)
  const latest = useRef(guard)
  latest.current = guard
  useCommitEffect(() => {
    if (!active) return undefined
    return registerGuard({
      isDirty: () => latest.current.isDirty(),
      close: () => latest.current.close(),
    })
  }, [active, registerGuard])
}

// For tests: fills every missing field with the default and provides the
// space to the data hooks.
export function SpaceSwitchProvider({
  value,
  children,
}: {
  value: Partial<ActiveSpaceState>
  children: ReactNode
}) {
  const spaceId = value.spaceId ?? PERSONAL_SPACE_ID
  const state: ActiveSpaceState = {
    ...DEFAULT_STATE,
    ...value,
    spaceId,
    isFamily: value.isFamily ?? (value.family != null && spaceId === value.family.id),
  }
  return (
    <SwitchContext.Provider value={state}>
      <SpaceProvider spaceId={spaceId}>{children}</SpaceProvider>
    </SwitchContext.Provider>
  )
}

// Renders children only once the start space is known, so data routes never
// query Personal first and then the Family.
export function SpaceReadyGate({ children }: { children: ReactNode }) {
  const { ready } = useContext(SwitchContext)
  return ready ? <>{children}</> : null
}

async function loadFamilySummary(): Promise<FamilySpaceSummary | null> {
  const spaces = await listLocalSpaces()
  const entry = spaces.at(0)
  if (!entry) return null
  let name = entry.name
  try {
    name = (await getSpaceInfo(entry.id))?.name ?? entry.name
  } catch {
    // Keep the entry name (e.g. the space key is not loaded).
  }
  return { id: entry.id, name, role: entry.role, readOnly: isSpaceReadOnly(entry.id) }
}

// Reports the Family sync state of one space; mounted only while a Family is
// held, so no sync hook with a space id runs otherwise.
function FamilyStateBridge({
  spaceId,
  onState,
}: {
  spaceId: string
  onState: (state: FamilySyncState | null) => void
}) {
  const state = useSyncState(spaceId)
  useEffect(() => {
    onState(state)
  }, [state, onState])
  useEffect(() => () => onState(null), [onState])
  return null
}

const DISMISSED_STATUSES: ReadonlyArray<FamilySyncStatus> = ['removed', 'space-gone']

export function ActiveSpaceRoot({
  unlocked,
  children,
}: {
  unlocked: boolean
  children: ReactNode
}) {
  const { t } = useT()
  const available = useFamilyAvailable()
  const famState = useFamilySyncState()
  const enabled = available && unlocked

  const familyQuery = useQuery({
    queryKey: [
      FAMILY_SPACE_QUERY_KEY,
      famState.spaceId,
      famState.status,
      famState.name,
      famState.readOnly,
    ],
    queryFn: loadFamilySummary,
    enabled,
    placeholderData: keepPreviousData,
  })
  const openInQuery = useQuery({
    queryKey: OPEN_APP_IN_QUERY_KEY,
    queryFn: () => getOpenAppIn(),
    enabled,
  })
  const family = enabled ? (familyQuery.data ?? null) : null

  // Captured at the first render: the shortcut follows the last used space.
  const [shortcut] = useState(
    () =>
      typeof window !== 'undefined' &&
      isShortcutUrl(window.location.pathname, window.location.search),
  )
  const [active, setActive] = useState<SpaceId>(PERSONAL_SPACE_ID)
  const [started, setStarted] = useState(false)
  const familySettled =
    enabled && !familyQuery.isPending && !familyQuery.isPlaceholderData && !openInQuery.isPending

  // The start space, once per page load, the first time the queries settle
  // while unlocked. Held in state only, never written to storage.
  useEffect(() => {
    if (started || !familySettled) return
    const summary = familyQuery.data ?? null
    setActive(
      resolveStartSpace({
        openIn: openInQuery.data ?? 'last',
        lastUsed: getActiveSpaceId(),
        familyId: summary?.id ?? null,
        shortcut,
      }),
    )
    setStarted(true)
  }, [started, familySettled, familyQuery.data, openInQuery.data, shortcut])

  const [fs, setFs] = useState<FamilySyncState | null>(null)
  const familyId = family?.id ?? null
  const spaceId: SpaceId = familyId !== null && active === familyId ? familyId : PERSONAL_SPACE_ID
  const isFamily = familyId !== null && spaceId === familyId
  const syncState = familyId !== null && fs?.spaceId !== null ? fs : null
  const readOnly =
    isFamily &&
    (family?.readOnly === true ||
      syncState?.readOnly === true ||
      (syncState !== null && DISMISSED_STATUSES.includes(syncState.status)))
  const paused = isFamily && syncState?.status === 'paused'
  const familyStatus = familyId !== null ? (syncState?.status ?? null) : null

  const profilesQuery = useQuery({
    queryKey: [MEMBER_PROFILES_QUERY_KEY, familyId],
    queryFn: () => getMemberProfiles(familyId as string),
    enabled: isFamily,
  })
  const memberQuery = useQuery({
    queryKey: ['current-member'],
    queryFn: async () => (await getCurrentMemberId()) ?? null,
    enabled: isFamily,
  })
  const memberId = isFamily ? (memberQuery.data ?? null) : null
  const members = syncState?.space?.members
  const directory = useMemo((): MemberDirectory | null => {
    if (!isFamily || !profilesQuery.data) return null
    const activeIds = members
      ? members.filter((m) => m.status === 'active').map((m) => m.user_id)
      : null
    return buildMemberDirectory(profilesQuery.data, activeIds, memberId)
  }, [isFamily, profilesQuery.data, members, memberId])

  // Guards (an open drawer with unsaved changes).
  const guards = useRef(new Set<SwitchGuard>())
  const registerGuard = useCallback((guard: SwitchGuard) => {
    guards.current.add(guard)
    return () => {
      guards.current.delete(guard)
    }
  }, [])
  const [pending, setPending] = useState<SpaceId | null>(null)

  const commitSwitch = useCallback((target: SpaceId) => {
    setActive(target)
    setActiveSpaceId(target)
  }, [])
  const closeGuards = useCallback(() => {
    for (const guard of Array.from(guards.current)) guard.close()
  }, [])

  const switchTo = useCallback(
    (target: SpaceId) => {
      if (target !== PERSONAL_SPACE_ID && target !== familyId) return
      if (target === spaceId) return
      const dirty = Array.from(guards.current).some((g) => g.isDirty())
      if (dirty) {
        setPending(target)
        return
      }
      closeGuards()
      commitSwitch(target)
    },
    [familyId, spaceId, closeGuards, commitSwitch],
  )

  const discardAndSwitch = () => {
    const target = pending
    setPending(null)
    if (target === null) return
    closeGuards()
    commitSwitch(target)
  }

  const ready = !enabled || started
  const value = useMemo(
    (): ActiveSpaceState => ({
      spaceId,
      family,
      isFamily,
      readOnly,
      paused,
      familyStatus,
      ready,
      directory,
      memberId,
      switchTo,
      registerGuard,
    }),
    [spaceId, family, isFamily, readOnly, paused, familyStatus, ready, directory, memberId, switchTo, registerGuard],
  )

  return (
    <SwitchContext.Provider value={value}>
      {familyId !== null && <FamilyStateBridge spaceId={familyId} onState={setFs} />}
      <SpaceProvider spaceId={spaceId}>{children}</SpaceProvider>
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
      >
        <AlertDialogContent data-testid="space-switch-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('space.discardTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('space.discardBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="space-switch-confirm-cancel">
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="space-switch-confirm-discard"
              onClick={discardAndSwitch}
            >
              {t('space.discardConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SwitchContext.Provider>
  )
}
