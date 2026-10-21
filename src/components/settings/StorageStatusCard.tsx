import { useEffect, useState } from 'react'
import { HardDrive } from 'lucide-react'

import type { StorageStatus } from '@/lib/storagePersistence'
import { useT } from '@/i18n'
import { bestEffortHint, currentInstallEnv } from '@/lib/installHint'
import { formatBytes, getStorageStatus } from '@/lib/storagePersistence'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

// Storage status (spec §6.1): whether the browser promised to keep our data.
export function StorageStatusCard() {
  const [status, setStatus] = useState<StorageStatus | null>(null)
  const { t } = useT()

  useEffect(() => {
    let cancelled = false
    getStorageStatus().then(
      (next) => {
        if (!cancelled) setStatus(next)
      },
      () => {
        if (!cancelled)
          setStatus({ persisted: false, usage: null, quota: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Card
      data-testid="storage-status"
      className="bg-card/50 border-border backdrop-blur-sm"
    >
      <CardHeader>
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-lg">{t('settings.storage.title')}</CardTitle>
        </div>
        <CardDescription>{t('settings.storage.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {status === null ? (
          <p className="text-muted-foreground">{t('settings.storage.checking')}</p>
        ) : (
          <>
            <p>
              {t('settings.storage.status')}{' '}
              <span data-testid="storage-status-label" className="font-medium">
                {status.persisted
                  ? t('settings.storage.protected')
                  : t('settings.storage.bestEffort')}
              </span>
            </p>
            {!status.persisted && (
              <p
                data-testid="storage-status-hint"
                className="text-muted-foreground"
              >
                {bestEffortHint(currentInstallEnv())}
              </p>
            )}
            {status.usage !== null && (
              <p
                data-testid="storage-status-usage"
                className="text-muted-foreground"
              >
                {status.quota !== null
                  ? t('settings.storage.usageOf', {
                      used: formatBytes(status.usage),
                      quota: formatBytes(status.quota),
                    })
                  : t('settings.storage.usage', { used: formatBytes(status.usage) })}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
