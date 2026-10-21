import { WifiOff } from 'lucide-react'

import { useT } from '@/i18n'
import { useOnlineStatus } from '@/lib/useOnlineStatus'

export function OfflineBanner() {
  const online = useOnlineStatus()
  const { t } = useT()
  if (online) return null
  return (
    <div className="sticky top-16 z-40 w-full flex items-center justify-center gap-2 bg-muted px-4 py-2 text-xs text-muted-foreground">
      <WifiOff className="h-3.5 w-3.5" />
      {t('common.offlineBanner')}
    </div>
  )
}
