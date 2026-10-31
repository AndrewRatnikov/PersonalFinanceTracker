// "Settings for <space>" above the per-space settings (spec §23). Shown only
// while a Family is held, so Personal-only users see today's tabs.

import { useT } from '@/i18n'
import { useSpaceSwitch } from '@/lib/spaces/switcher'

export function SpaceSettingsHeader() {
  const { t } = useT()
  const { family, isFamily } = useSpaceSwitch()
  if (family === null) return null

  const name = isFamily ? family.name : t('space.personal')
  return (
    <p
      data-testid="space-settings-header"
      className={`text-sm font-medium ${isFamily ? 'text-primary' : 'text-muted-foreground'}`}
    >
      {t('space.settingsFor', { name })}
    </p>
  )
}
