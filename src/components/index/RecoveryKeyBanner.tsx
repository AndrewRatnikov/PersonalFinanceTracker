import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { KeyRound } from 'lucide-react'

import { APP_SETTINGS_QUERY_KEY, getAppSettings } from '@/lib/appSettings'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

// Dashboard banner for a recovery key that was never confirmed as saved (the
// tab was closed at the key step). The key itself is never stored, so it
// can't be shown again: the action goes to Settings → Security to create a
// new one. It has no dismiss control; confirming a new key clears it.
export function RecoveryKeyBanner() {
  const { data } = useQuery({
    queryKey: APP_SETTINGS_QUERY_KEY,
    queryFn: getAppSettings,
  })

  if (data?.recoveryKeyConfirmed !== false) return null

  return (
    <Card
      data-testid="recovery-key-unconfirmed-banner"
      className="border-destructive/30"
    >
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 shrink-0 text-destructive" />
          <p data-testid="recovery-key-unconfirmed-text" className="text-sm">
            You haven&apos;t saved a recovery key for this device
          </p>
        </div>
        <Link
          to="/settings"
          search={{ tab: 'security' }}
          className={buttonVariants({ size: 'sm' })}
          data-testid="recovery-key-unconfirmed-action"
        >
          Create a new recovery key
        </Link>
      </CardContent>
    </Card>
  )
}
