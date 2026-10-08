import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Smartphone } from 'lucide-react'

import {
  APP_SETTINGS_QUERY_KEY,
  getAppSettings,
  updateAppSettings,
} from '@/lib/appSettings'
import { shouldShowInstallHint } from '@/lib/installHint'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

// One-time iOS Safari hint (spec §6.1): Safari may clear a website's data, an
// app on the Home Screen keeps it.
export function InstallHintCard() {
  const [show] = useState(() => shouldShowInstallHint())
  const [dismissed, setDismissed] = useState(false)
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: APP_SETTINGS_QUERY_KEY,
    queryFn: getAppSettings,
    enabled: show,
  })

  if (!show || !data || data.installHintDismissed || dismissed) return null

  const handleDismiss = async () => {
    setDismissed(true)
    try {
      await updateAppSettings({ installHintDismissed: true })
    } catch (err) {
      console.error('Could not save the install hint dismissal:', err)
    }
    void queryClient.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY })
  }

  return (
    <Card data-testid="install-hint" className="border-[#6366f1]/30">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-[#6366f1]" />
          <CardTitle>Add to Home Screen to keep your data safe</CardTitle>
        </div>
        <CardDescription>
          Safari can clear website data you haven&apos;t used for a while. Tap
          Share, then &ldquo;Add to Home Screen&rdquo;, and open MinimaSpend
          from there.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="install-hint-dismiss"
          onClick={() => void handleDismiss()}
        >
          Dismiss
        </Button>
      </CardContent>
    </Card>
  )
}
