import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Users } from 'lucide-react'

import type { ReactNode } from 'react'
import type {
  CreateFamilyResult,
  CreatedFamilyInvite,
  FamilyActions,
  FamilyOverview,
  FamilySyncState,
} from '@/lib/sync/types'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { familyErrorMessage } from '@/i18n/errors'
import { formatFullDate, formatTime } from '@/i18n/format'
import { useAccountSession } from '@/lib/accountSession'
import { downloadBackup } from '@/lib/backup'
import { hasFeature, useSyncStatus } from '@/lib/cloud/entitlements'
import { useFamilySyncState, useSyncState } from '@/lib/sync/react'
import { getSyncRuntime } from '@/lib/sync/runtime'
import { FamilyDeleteDialog } from '@/components/settings/FamilyDeleteDialog'
import { FamilyInviteDialog } from '@/components/settings/FamilyInviteDialog'
import { FamilyMembersList } from '@/components/settings/FamilyMembersList'
import { FamilyRequestsList } from '@/components/settings/FamilyRequestsList'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface FamilyTabProps {
  onOpenSyncTab?: () => void
}

const FAMILY_OVERVIEW_KEY = 'family-overview'
const MAX_NAME_LENGTH = 60

type RunAction = (fn: () => Promise<unknown>) => Promise<boolean>

function getFamilyActions(): FamilyActions | null {
  return getSyncRuntime().familyActions
}

function validName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length >= 1 && trimmed.length <= MAX_NAME_LENGTH
}

function formatWhen(iso: string): string {
  return `${formatFullDate(iso)} ${formatTime(iso)}`
}

const STATE_KEYS: Partial<Record<FamilySyncState['status'], MessageKey>> = {
  syncing: 'family.state.syncing',
  synced: 'family.state.synced',
  offline: 'family.state.offline',
  paused: 'family.state.paused',
  'rotation-pending': 'family.state.rotationPending',
}

function useFamilyOverview(spaceId: string | null) {
  return useQuery<FamilyOverview>({
    queryKey: [FAMILY_OVERVIEW_KEY, spaceId],
    queryFn: () => {
      const actions = getFamilyActions()
      if (!actions || !spaceId) return Promise.resolve({ info: null, profiles: [], entryCount: 0 })
      return actions.getOverview(spaceId)
    },
    enabled: spaceId !== null,
  })
}

// Settings → Family: one view per state (signed out, sync off, read-only,
// pending, in a Family, no Family). Action errors show under the view.
export function FamilyTab({ onOpenSyncTab }: FamilyTabProps) {
  const session = useAccountSession()
  const personal = useSyncState()
  const family = useFamilySyncState()
  const plan = useSyncStatus()
  const queryClient = useQueryClient()
  const { t } = useT()
  const [actionError, setActionError] = useState<string | null>(null)

  const runAction: RunAction = async (fn) => {
    setActionError(null)
    try {
      await fn()
      void queryClient.invalidateQueries({ queryKey: [FAMILY_OVERVIEW_KEY] })
      return true
    } catch (err) {
      setActionError(familyErrorMessage(err))
      return false
    }
  }

  const readOnly =
    family.spaceId !== null &&
    (family.readOnly || family.status === 'removed' || family.status === 'space-gone')

  let body: ReactNode
  if (!session) {
    body = (
      <Card data-testid="family-sign-in-card">
        <CardHeader>
          <CardTitle>{t('family.title')}</CardTitle>
          <CardDescription>{t('family.signIn.body')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            to="/login"
            search={{ redirect: '/settings?tab=family' }}
            data-testid="family-sign-in-link"
            className={buttonVariants({ variant: 'outline' })}
          >
            {t('family.signIn.link')}
          </Link>
        </CardContent>
      </Card>
    )
  } else if (personal.status === 'off') {
    body = (
      <Card data-testid="family-sync-off">
        <CardHeader>
          <CardTitle>{t('family.title')}</CardTitle>
          <CardDescription>{t('family.syncOff.body')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            variant="outline"
            data-testid="family-sync-settings-btn"
            onClick={() => onOpenSyncTab?.()}
          >
            {t('family.syncOff.button')}
          </Button>
        </CardContent>
      </Card>
    )
  } else if (readOnly && family.spaceId) {
    body = <ReadOnlyView family={family} spaceId={family.spaceId} runAction={runAction} />
  } else if (family.status === 'pending-approval') {
    body = <PendingView family={family} />
  } else if (family.space && family.space.status === 'active' && family.spaceId) {
    body = (
      <OverviewView
        family={family}
        space={family.space}
        spaceId={family.spaceId}
        myUserId={session.userId}
        runAction={runAction}
        onError={setActionError}
      />
    )
  } else if (plan.state === 'loading') {
    body = (
      <div data-testid="family-loading" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('family.loading')}
      </div>
    )
  } else if (plan.state === 'ready' && !hasFeature(plan.status, 'shared_spaces')) {
    body = (
      <Card data-testid="family-not-in-plan">
        <CardHeader>
          <CardTitle>{t('family.title')}</CardTitle>
          <CardDescription>{t('family.notInPlan')}</CardDescription>
        </CardHeader>
      </Card>
    )
  } else {
    body = <CreateForm runAction={runAction} onError={setActionError} />
  }

  return (
    <div data-testid="family-tab" className="flex flex-col gap-4">
      {body}
      {actionError && (
        <p data-testid="family-action-error" role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
    </div>
  )
}

function CreateForm({
  runAction,
  onError,
}: {
  runAction: RunAction
  onError: (message: string | null) => void
}) {
  const { t } = useT()
  const [name, setName] = useState(() => t('family.defaultName'))
  const [pending, setPending] = useState(false)

  const submit = async () => {
    if (pending) return
    if (!validName(name)) {
      onError(t('family.errors.invalidName'))
      return
    }
    const actions = getFamilyActions()
    if (!actions) return
    setPending(true)
    const box: { result: CreateFamilyResult | null } = { result: null }
    const ok = await runAction(async () => {
      box.result = await actions.createFamily({ name: name.trim() })
    })
    setPending(false)
    // Another Family already holds this account: nothing was created locally.
    if (ok && box.result?.kind === 'already-in-space') onError(t('family.errors.alreadyInSpace'))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('family.create.title')}</CardTitle>
        <CardDescription>{t('family.create.hint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          data-testid="family-create-form"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="family-create-name">{t('family.create.nameLabel')}</Label>
            <Input
              id="family-create-name"
              data-testid="family-create-name"
              value={name}
              maxLength={MAX_NAME_LENGTH}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
            />
          </div>
          <Button
            type="button"
            data-testid="family-create-submit"
            disabled={pending}
            onClick={() => void submit()}
            className="self-start"
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('family.create.submit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function PendingView({ family }: { family: FamilySyncState }) {
  const { t } = useT()
  const [code, setCode] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const actions = getFamilyActions()
    if (!actions) return
    actions.mySafetyCode().then(
      (value) => {
        if (!cancelled) setCode(value)
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Card data-testid="family-pending">
      <CardHeader>
        <CardTitle>{t('family.title')}</CardTitle>
        <CardDescription>
          {family.pendingOwnerEmail
            ? t('family.pending.waiting', { email: family.pendingOwnerEmail })
            : t('family.pending.waitingOwner')}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {code && (
          <p data-testid="family-my-safety-code" className="font-mono text-sm">
            {t('family.safetyCode.mine', { code })}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t('family.safetyCode.hint')}</p>
      </CardContent>
    </Card>
  )
}

function ReadOnlyView({
  family,
  spaceId,
  runAction,
}: {
  family: FamilySyncState
  spaceId: string
  runAction: RunAction
}) {
  const { t, plural } = useT()
  const overview = useFamilyOverview(spaceId)
  const [pending, setPending] = useState(false)
  const name = overview.data?.info?.name ?? family.name ?? ''

  const forget = async () => {
    const actions = getFamilyActions()
    if (!actions || pending) return
    setPending(true)
    await runAction(() => actions.forgetFamily(spaceId))
    setPending(false)
  }

  return (
    <Card data-testid="family-read-only">
      <CardHeader>
        <CardTitle>{name || t('family.title')}</CardTitle>
        <CardDescription>{t('family.readOnly.body', { name })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        {overview.data && (
          <p data-testid="family-entry-count" className="text-sm text-muted-foreground">
            {plural('family.entries', overview.data.entryCount)}
          </p>
        )}
        <Button
          type="button"
          variant="destructive"
          data-testid="family-forget-btn"
          disabled={pending}
          onClick={() => void forget()}
        >
          {t('family.readOnly.forget')}
        </Button>
      </CardContent>
    </Card>
  )
}

function progressText(
  progress: NonNullable<FamilySyncState['progress']>,
  t: ReturnType<typeof useT>['t'],
): string {
  if (progress.phase === 'pull') return t('family.progress.pull', { done: progress.done })
  const total = progress.total ?? progress.done
  if (progress.phase === 'push') return t('family.progress.push', { done: progress.done, total })
  return t('family.progress.reencrypt', { done: progress.done, total })
}

function OverviewView({
  family,
  space,
  spaceId,
  myUserId,
  runAction,
  onError,
}: {
  family: FamilySyncState
  space: NonNullable<FamilySyncState['space']>
  spaceId: string
  myUserId: string
  runAction: RunAction
  onError: (message: string | null) => void
}) {
  const { t, plural } = useT()
  const overview = useFamilyOverview(spaceId)
  const isOwner = space.role === 'owner'
  const activeMembers = space.members.filter((m) => m.status === 'active')
  const requests = space.members.filter((m) => m.status === 'pending')
  const rawMax = space.limits?.max_members
  const maxMembers = typeof rawMax === 'number' ? rawMax : null
  // Pending requests count toward the plan's member limit on the server.
  const atLimit = maxMembers !== null && space.members.length >= maxMembers

  const [spaceName, setSpaceName] = useState<string | null>(null)
  const [myName, setMyName] = useState<string | null>(null)
  const [invite, setInvite] = useState<CreatedFamilyInvite | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const storedName = overview.data?.info?.name ?? family.name ?? ''
  const myProfile = overview.data?.profiles.find((p) => p.id === myUserId && !p.deletedAt)
  const spaceNameValue = spaceName ?? storedName
  const myNameValue = myName ?? myProfile?.displayName ?? ''

  const act = async (fn: (actions: FamilyActions) => Promise<unknown>): Promise<boolean> => {
    const actions = getFamilyActions()
    if (!actions) return false
    setBusy(true)
    const ok = await runAction(() => fn(actions))
    setBusy(false)
    return ok
  }

  const saveSpaceName = async () => {
    if (!validName(spaceNameValue)) {
      onError(t('family.errors.invalidName'))
      return
    }
    if (await act((a) => a.renameFamily(spaceNameValue.trim()))) setSpaceName(null)
  }

  const saveMyName = async () => {
    if (!validName(myNameValue)) {
      onError(t('family.errors.invalidName'))
      return
    }
    if (await act((a) => a.setMyDisplayName(myNameValue.trim()))) setMyName(null)
  }

  const createInvite = async () => {
    const box: { invite: CreatedFamilyInvite | null } = { invite: null }
    const ok = await act(async (a) => {
      box.invite = await a.createInvite()
    })
    if (ok && box.invite) {
      setInvite(box.invite)
      setInviteOpen(true)
    }
  }

  const stateKey = STATE_KEYS[family.status]
  const stateLine =
    family.status === 'error'
      ? t('family.state.error', { code: family.errorCode ?? 'unknown' })
      : stateKey
        ? t(stateKey)
        : ''

  return (
    <div data-testid="family-overview" className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Users size={18} className="text-muted-foreground" />
            <CardTitle>{storedName || t('family.title')}</CardTitle>
          </div>
          <CardDescription data-testid="family-sync-state">{stateLine}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p data-testid="family-last-sync" className="text-muted-foreground">
            {family.lastSyncAt ? t('family.lastSync', { when: formatWhen(family.lastSyncAt) }) : t('family.neverSynced')}
          </p>
          {overview.data && (
            <p data-testid="family-entry-count" className="text-muted-foreground">
              {plural('family.entries', overview.data.entryCount)}
            </p>
          )}
          {maxMembers !== null && (
            <p data-testid="family-plan-line" className="text-muted-foreground">
              {t('family.planLine', { count: activeMembers.length, max: maxMembers })}
            </p>
          )}
          {family.progress && (
            <p data-testid="family-progress">{progressText(family.progress, t)}</p>
          )}
          {family.status === 'paused' && (
            <p data-testid="family-paused" role="status" className="rounded-md bg-muted p-3">
              {t('family.state.paused')}
            </p>
          )}
          {family.status === 'rotation-pending' && (
            <p data-testid="family-rotation-pending" role="status" className="rounded-md bg-muted p-3">
              {t('family.state.rotationPending')}
            </p>
          )}
          {family.status === 'error' && (
            <p data-testid="family-error" role="status" className="rounded-md bg-destructive/10 p-3 text-destructive">
              {t('family.state.error', { code: family.errorCode ?? 'unknown' })}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              void saveSpaceName()
            }}
          >
            <Label htmlFor="family-space-name">{t('family.spaceName.label')}</Label>
            <div className="flex gap-2">
              <Input
                id="family-space-name"
                data-testid="family-space-name-input"
                value={spaceNameValue}
                maxLength={MAX_NAME_LENGTH}
                onChange={(e) => setSpaceName(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                data-testid="family-space-name-save"
                onClick={() => void saveSpaceName()}
              >
                {t('family.save')}
              </Button>
            </div>
          </form>
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              void saveMyName()
            }}
          >
            <Label htmlFor="family-my-name">{t('family.myName.label')}</Label>
            <div className="flex gap-2">
              <Input
                id="family-my-name"
                data-testid="family-my-name-input"
                value={myNameValue}
                maxLength={MAX_NAME_LENGTH}
                onChange={(e) => setMyName(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                data-testid="family-my-name-save"
                onClick={() => void saveMyName()}
              >
                {t('family.save')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <FamilyMembersList
        members={activeMembers}
        profiles={overview.data?.profiles ?? []}
        myUserId={myUserId}
        isOwner={isOwner}
        onRemove={(userId) => act((a) => a.removeMember(userId)).then(() => undefined)}
        onTransfer={(userId) => act((a) => a.transferOwnership(userId)).then(() => undefined)}
      />

      {isOwner && requests.length > 0 && (
        <FamilyRequestsList
          requests={requests}
          onApprove={(userId) => act((a) => a.approveMember(userId)).then(() => undefined)}
          onReject={(userId) => act((a) => a.rejectMember(userId)).then(() => undefined)}
        />
      )}

      {isOwner && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col items-start gap-1">
            <Button
              type="button"
              data-testid="family-invite-btn"
              disabled={atLimit || busy}
              onClick={() => void createInvite()}
            >
              {t('family.invites.invite')}
            </Button>
            {atLimit && <p className="text-xs text-muted-foreground">{t('family.invites.full')}</p>}
          </div>
          {space.open_invites.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-foreground">{t('family.invites.title')}</h3>
              <ul data-testid="family-invites" className="flex flex-col divide-y rounded-md border">
                {space.open_invites.map((inv) => (
                  <li
                    key={inv.id}
                    data-testid="family-invite-row"
                    className="flex items-center justify-between gap-2 p-3"
                  >
                    <span data-testid="family-invite-expiry" className="text-sm text-muted-foreground">
                      {t('family.invites.expires', { when: formatWhen(inv.expires_at) })}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid="family-invite-revoke-btn"
                      onClick={() => void act((a) => a.revokeInvite(inv.id))}
                    >
                      {t('family.invites.revoke')}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Button
            type="button"
            variant="destructive"
            data-testid="family-delete-btn"
            className="self-start"
            onClick={() => setDeleteOpen(true)}
          >
            {t('family.delete.button')}
          </Button>
        </div>
      )}

      {!isOwner && (
        <Button
          type="button"
          variant="destructive"
          data-testid="family-leave-btn"
          className="self-start"
          onClick={() => setLeaveOpen(true)}
        >
          {t('family.leave.button')}
        </Button>
      )}

      <FamilyInviteDialog
        open={inviteOpen}
        onOpenChange={(open) => {
          setInviteOpen(open)
          if (!open) setInvite(null)
        }}
        invite={invite}
      />

      {isOwner && (
        <FamilyDeleteDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          spaceName={storedName}
          onConfirm={async (typed) => {
            if (await act((a) => a.deleteFamily(typed))) setDeleteOpen(false)
          }}
          onDownloadBackup={async () => {
            await runAction(() => downloadBackup())
          }}
        />
      )}

      <AlertDialog open={leaveOpen} onOpenChange={(open) => {
          if (!busy) setLeaveOpen(open)
        }}>
        <AlertDialogContent data-testid="family-leave-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('family.leave.title', { name: storedName })}</AlertDialogTitle>
            <AlertDialogDescription>{t('family.leave.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('family.cancel')}</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              data-testid="family-leave-confirm"
              disabled={busy}
              onClick={() => {
                void act((a) => a.leaveFamily()).then(() => setLeaveOpen(false))
              }}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('family.leave.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
