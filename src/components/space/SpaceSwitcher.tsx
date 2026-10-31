// The active-space switcher (spec §23): a segmented control in the header
// (md and up) and the menu sheet, a chip on mobile, and the Family sync state
// icon. Everything renders nothing while no Family is held.

import {
  CircleAlert,
  CirclePause,
  CloudCheck,
  CloudOff,
  KeyRound,
  RefreshCw,
  Users,
} from 'lucide-react'

import type { FamilySyncStatus } from '@/lib/sync/types'
import { useT } from '@/i18n'
import { useSpaceSwitch } from '@/lib/spaces/switcher'
import { PERSONAL_SPACE_ID } from '@/lib/spaces/types'

const ICONS: Partial<Record<FamilySyncStatus, typeof CloudCheck>> = {
  synced: CloudCheck,
  syncing: RefreshCw,
  offline: CloudOff,
  paused: CirclePause,
  'rotation-pending': KeyRound,
}

function SpaceSyncState({ status, name }: { status: FamilySyncStatus | null; name: string }) {
  const { t } = useT()
  const value: FamilySyncStatus = status ?? 'none'
  let label: string
  switch (value) {
    case 'synced':
      label = t('family.state.synced')
      break
    case 'syncing':
      label = t('family.state.syncing')
      break
    case 'offline':
      label = t('family.state.offline')
      break
    case 'paused':
      label = t('family.state.paused')
      break
    case 'rotation-pending':
      label = t('family.state.rotationPending')
      break
    case 'removed':
    case 'space-gone':
      label = t('space.readOnlyBanner', { name })
      break
    case 'error':
      label = t('family.state.error', { code: value })
      break
    default:
      label = t('family.title')
  }
  const Icon = ICONS[value] ?? (value === 'error' ? CircleAlert : Users)
  const problem = value === 'error' || value === 'removed' || value === 'space-gone'
  return (
    <span
      data-testid="space-sync-state"
      data-status={value}
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex h-9 w-9 items-center justify-center ${
        problem ? 'text-destructive' : 'text-muted-foreground'
      }`}
    >
      <Icon className={`h-5 w-5 ${value === 'syncing' ? 'animate-spin' : ''}`} />
    </span>
  )
}

const TEST_IDS = {
  header: {
    group: 'space-switcher',
    personal: 'space-switch-personal',
    family: 'space-switch-family',
  },
  nav: {
    group: 'nav-space-switcher',
    personal: 'nav-space-switch-personal',
    family: 'nav-space-switch-family',
  },
} as const

const OPTION_CLASS = 'rounded-md px-3 text-sm font-medium transition-colors'
const OPTION_ACTIVE_CLASS = 'bg-primary text-primary-foreground'
const OPTION_IDLE_CLASS = 'text-muted-foreground hover:bg-accent hover:text-foreground'

export function SpaceSwitcher({ variant }: { variant: 'header' | 'nav' }) {
  const { t } = useT()
  const { family, isFamily, familyStatus, switchTo } = useSpaceSwitch()
  if (family === null) return null

  const ids = TEST_IDS[variant]
  const personalLabel = t('space.personal')
  const options = [
    { id: PERSONAL_SPACE_ID, testId: ids.personal, label: personalLabel, pressed: !isFamily },
    { id: family.id, testId: ids.family, label: family.name, pressed: isFamily },
  ]

  const group = (
    <div
      role="group"
      aria-label={t('space.switcherLabel')}
      data-testid={ids.group}
      className={
        variant === 'header'
          ? 'hidden md:flex items-center gap-1 rounded-lg border p-1 mr-1'
          : 'flex items-center gap-1 rounded-lg border p-1 mb-3'
      }
    >
      {options.map((o) => (
        <button
          key={o.testId}
          type="button"
          data-testid={o.testId}
          aria-pressed={o.pressed}
          aria-label={o.label}
          onClick={() => switchTo(o.id)}
          className={`${OPTION_CLASS} ${variant === 'header' ? 'h-7' : 'min-h-11 flex-1'} ${
            o.pressed ? OPTION_ACTIVE_CLASS : OPTION_IDLE_CLASS
          }`}
        >
          <span className="truncate">{o.label}</span>
        </button>
      ))}
    </div>
  )

  if (variant === 'nav') return group
  return (
    <>
      {group}
      <SpaceSyncState status={familyStatus} name={family.name} />
    </>
  )
}

// Mobile: the current space name; a tap switches to the other space.
export function SpaceChip() {
  const { t } = useT()
  const { family, isFamily, switchTo } = useSpaceSwitch()
  if (family === null) return null

  const name = isFamily ? family.name : t('space.personal')
  const other = isFamily ? PERSONAL_SPACE_ID : family.id
  return (
    <button
      type="button"
      data-testid="space-chip"
      aria-label={t('space.chipLabel', { name })}
      onClick={() => switchTo(other)}
      className={`md:hidden inline-flex min-h-11 max-w-[9rem] items-center gap-1 rounded-full border px-3 text-sm font-medium ${
        isFamily ? 'border-primary/60 text-primary' : 'text-muted-foreground'
      }`}
    >
      {isFamily && <Users className="h-4 w-4 shrink-0" aria-hidden="true" />}
      <span className="truncate">{name}</span>
    </button>
  )
}
