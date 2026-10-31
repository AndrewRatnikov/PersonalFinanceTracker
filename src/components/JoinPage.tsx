import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'

import type { ReactNode } from 'react'
import type { PendingInvite } from '@/lib/spaces/pendingInvite'
import type { FamilyActions, FamilySyncState, JoinRequestResult } from '@/lib/sync/types'
import { useT } from '@/i18n'
import { familyErrorMessage } from '@/i18n/errors'
import { formatFullDate, formatTime } from '@/i18n/format'
import { useAccountSession } from '@/lib/accountSession'
import { parseInviteFragment } from '@/lib/spaces/invite'
import { clearPendingInvite, readPendingInvite, savePendingInvite } from '@/lib/spaces/pendingInvite'
import { useFamilyAvailable, useFamilySyncState, useSyncState } from '@/lib/sync/react'
import { requestSyncRestore } from '@/lib/sync/restoreRequest'
import { getSyncRuntime } from '@/lib/sync/runtime'
import { requestCreateVault, useVaultSession } from '@/lib/vaultSession'
import { Button, buttonVariants } from '@/components/ui/button'

// What the invite preview (get_invite) returns.
type InvitePreview = Awaited<ReturnType<FamilyActions['previewInvite']>>

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; info: InvitePreview }
  | { kind: 'expired' }
  | { kind: 'error'; message: string }

const JOIN_PATH = '/join'
const IN_FAMILY_STATUSES: ReadonlyArray<FamilySyncState['status']> = [
  'synced',
  'syncing',
  'paused',
  'rotation-pending',
]

function isInviteInvalid(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === 'CloudError' &&
    (err as { code?: unknown }).code === 'invite_invalid'
  )
}

// /join: reads the invite from the address bar fragment (or the copy kept in
// this tab for an hour), walks the user through the vault, sign-in and sync
// steps, previews the invite and sends the join request. With the Family flags
// off it shows only "Not available" and touches nothing.
export function JoinPage() {
  const available = useFamilyAvailable()
  const { t } = useT()
  return (
    <div data-testid="join-page" className="max-w-md mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-4">
      {available ? (
        <JoinFlow />
      ) : (
        <p data-testid="join-not-available" className="text-muted-foreground">
          {t('join.notAvailable')}
        </p>
      )}
    </div>
  )
}

function JoinFlow() {
  const { t, plural } = useT()
  const vault = useVaultSession()
  const session = useAccountSession()
  const personal = useSyncState()
  const family = useFamilySyncState()

  // undefined: the link has not been read yet (first client effect).
  const [invite, setInvite] = useState<PendingInvite | null | undefined>(undefined)
  const [linkInvalid, setLinkInvalid] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' })
  const [joined, setJoined] = useState<JoinRequestResult | null>(null)
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)
  const [turningOn, setTurningOn] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)

  useEffect(() => {
    const hash = window.location.hash
    if (hash !== '' && hash !== '#') {
      const parsed = parseInviteFragment(hash)
      // The secret never stays in the address bar or the history entry.
      window.history.replaceState(null, '', JOIN_PATH)
      if (parsed) {
        savePendingInvite(parsed)
        setInvite(parsed)
      } else {
        setLinkInvalid(true)
        setInvite(null)
      }
      return
    }
    setInvite(readPendingInvite())
  }, [])

  const signedIn = session != null
  const syncOn = personal.status !== 'off'
  const inFamily = family.space !== null && IN_FAMILY_STATUSES.includes(family.status)
  const canPreview =
    invite != null &&
    !joined &&
    vault.phase === 'unlocked' &&
    signedIn &&
    syncOn &&
    !inFamily &&
    family.status !== 'pending-approval'

  // Previews once all the steps are done; again only when they change.
  useEffect(() => {
    if (!canPreview || !invite) return
    const actions = getSyncRuntime().familyActions
    if (!actions) return
    let active = true
    setPreview({ kind: 'loading' })
    actions.previewInvite(invite).then(
      (info) => {
        if (active) setPreview({ kind: 'ready', info })
      },
      (err: unknown) => {
        if (!active) return
        if (isInviteInvalid(err)) {
          // Used, expired, revoked or wrong: one message, and the copy goes.
          clearPendingInvite()
          setPreview({ kind: 'expired' })
        } else {
          setPreview({ kind: 'error', message: familyErrorMessage(err) })
        }
      },
    )
    return () => {
      active = false
    }
  }, [canPreview, invite])

  const turnOnSync = async () => {
    if (turningOn) return
    setTurningOn(true)
    setSyncError(null)
    try {
      const result = await getSyncRuntime().actions.turnOn()
      if (result.kind === 'needs-link') {
        setSyncError(t('family.errors.generic', { code: 'needs_link' }))
      }
    } catch (err) {
      setSyncError(familyErrorMessage(err))
    } finally {
      setTurningOn(false)
    }
  }

  const ask = async () => {
    const actions = getSyncRuntime().familyActions
    if (!actions || !invite || preview.kind !== 'ready' || asking) return
    setAsking(true)
    setAskError(null)
    try {
      setJoined(await actions.requestJoin(invite, preview.info.owner_email))
    } catch (err) {
      setAskError(familyErrorMessage(err))
    } finally {
      setAsking(false)
    }
  }

  const cancel = () => {
    clearPendingInvite()
    setInvite(null)
    setCancelled(true)
    setPreview({ kind: 'idle' })
  }

  const title = <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('join.title')}</h1>
  const frame = (content: ReactNode) => (
    <>
      {title}
      {content}
    </>
  )
  const loading = (
    <p data-testid="join-loading" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {t('join.loading')}
    </p>
  )

  if (invite === undefined) return frame(loading)

  // A request already sent (here or on another device of this account).
  if (joined || family.status === 'pending-approval') {
    return frame(
      <div data-testid="join-pending" className="flex flex-col gap-2">
        <p>{t('join.pendingBody')}</p>
        {joined && (
          <>
            <p data-testid="join-safety-code" className="font-mono">
              {t('family.safetyCode.mine', { code: joined.safetyCode })}
            </p>
            <p data-testid="join-safety-hint" className="text-sm text-muted-foreground">
              {t('family.safetyCode.hint')}
            </p>
          </>
        )}
      </div>,
    )
  }

  if (cancelled) return frame(null)

  if (linkInvalid || invite === null) {
    return frame(
      <p data-testid="join-invalid" className="text-muted-foreground">
        {t('join.invalid')}
      </p>,
    )
  }

  if (vault.phase === 'checking') return frame(loading)

  if (vault.phase === 'none') {
    return frame(
      <div data-testid="join-no-vault" className="flex flex-col gap-3">
        <p>{t('join.noVault.body')}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" data-testid="join-create-vault-btn" onClick={() => requestCreateVault()}>
            {t('join.noVault.create')}
          </Button>
          {signedIn ? (
            <Button
              type="button"
              variant="outline"
              data-testid="join-restore-btn"
              onClick={() => {
                requestSyncRestore()
                requestCreateVault()
              }}
            >
              {t('join.noVault.restore')}
            </Button>
          ) : (
            <Link
              to="/login"
              search={{ redirect: JOIN_PATH }}
              data-testid="join-restore-btn"
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('join.noVault.restore')}
            </Link>
          )}
        </div>
      </div>,
    )
  }

  if (vault.phase === 'locked') {
    return frame(
      <p data-testid="join-locked" className="text-muted-foreground">
        {t('join.locked')}
      </p>,
    )
  }

  if (!signedIn) {
    return frame(
      <div data-testid="join-sign-in" className="flex flex-col gap-3">
        <p>{t('join.signIn.body')}</p>
        <Link
          to="/login"
          search={{ redirect: JOIN_PATH }}
          data-testid="join-sign-in-link"
          className={buttonVariants({ variant: 'outline' })}
        >
          {t('join.signIn.link')}
        </Link>
      </div>,
    )
  }

  if (!syncOn) {
    return frame(
      <div data-testid="join-sync-off" className="flex flex-col gap-3">
        <p>{t('join.syncOff.body')}</p>
        <Button
          type="button"
          data-testid="join-turn-on-sync-btn"
          className="self-start"
          disabled={turningOn}
          onClick={() => void turnOnSync()}
        >
          {turningOn && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('join.syncOff.button')}
        </Button>
        {syncError && (
          <p data-testid="join-error" role="alert" className="text-sm text-destructive">
            {syncError}
          </p>
        )}
      </div>,
    )
  }

  if (inFamily) {
    return frame(
      <p data-testid="join-already-member" className="text-muted-foreground">
        {t('join.alreadyMember')}
      </p>,
    )
  }

  if (preview.kind === 'expired') {
    return frame(
      <p data-testid="join-invite-expired" className="text-muted-foreground">
        {t('family.errors.inviteInvalid')}
      </p>,
    )
  }

  if (preview.kind === 'error') {
    return frame(
      <div className="flex flex-col gap-3">
        <p data-testid="join-error" role="alert" className="text-sm text-destructive">
          {preview.message}
        </p>
        <Button type="button" variant="outline" data-testid="join-cancel-btn" className="self-start" onClick={cancel}>
          {t('join.cancel')}
        </Button>
      </div>,
    )
  }

  if (preview.kind !== 'ready') return frame(loading)

  const { info } = preview
  return frame(
    <div className="flex flex-col gap-3">
      <p data-testid="join-invite-info">
        {t('join.info', {
          email: info.owner_email ?? '',
          members: plural('join.members', info.members_count),
          when: `${formatFullDate(info.expires_at)} ${formatTime(info.expires_at)}`,
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" data-testid="join-ask-btn" disabled={asking} onClick={() => void ask()}>
          {asking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('join.ask')}
        </Button>
        <Button type="button" variant="outline" data-testid="join-cancel-btn" disabled={asking} onClick={cancel}>
          {t('join.cancel')}
        </Button>
      </div>
      {askError && (
        <p data-testid="join-error" role="alert" className="text-sm text-destructive">
          {askError}
        </p>
      )}
    </div>,
  )
}
