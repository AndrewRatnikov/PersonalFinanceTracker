// "Where am I" cues at the top of every page (spec §23): the Family title cue,
// and the read-only / paused banners. Nothing while Personal is shown.

import { Link } from '@tanstack/react-router'
import { CirclePause, Users } from 'lucide-react'

import { useT } from '@/i18n'
import { useSpaceSwitch } from '@/lib/spaces/switcher'

export function SpaceBanner() {
  const { t } = useT()
  const { family, isFamily, readOnly, paused } = useSpaceSwitch()
  if (!isFamily || family === null) return null

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-8 pt-3 flex flex-col gap-2">
      <div
        data-testid="space-title-cue"
        className="flex items-center gap-2 text-sm font-medium text-primary"
      >
        <Users className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{family.name}</span>
      </div>
      {readOnly ? (
        <div
          data-testid="space-readonly-banner"
          role="status"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm flex flex-wrap items-center gap-x-3 gap-y-1"
        >
          <span>{t('space.readOnlyBanner', { name: family.name })}</span>
          <Link
            to="/settings"
            search={{ tab: 'family' }}
            data-testid="space-readonly-settings-link"
            className="font-medium underline underline-offset-4"
          >
            {t('space.readOnlyLink')}
          </Link>
        </div>
      ) : (
        paused && (
          <div
            data-testid="space-paused-banner"
            role="status"
            className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground"
          >
            <CirclePause className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t('space.pausedBanner', { name: family.name })}</span>
          </div>
        )
      )}
    </div>
  )
}
