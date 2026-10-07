import { useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'

import { storageKeyLabel } from '@/lib/dataErrors'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

interface DataProblemScreenProps {
  storageKey: string
  onRetry: () => void | Promise<void>
  onQuarantine: () => Promise<void>
}

export function DataProblemScreen({
  storageKey,
  onRetry,
  onQuarantine,
}: DataProblemScreenProps) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleQuarantine = async () => {
    setError(null)
    setPending(true)
    try {
      await onQuarantine()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      data-testid="data-problem-screen"
      className="flex min-h-[60vh] items-center justify-center px-4"
    >
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <TriangleAlert className="h-4 w-4 text-destructive" />
            <CardTitle>Data problem</CardTitle>
          </div>
          <CardDescription>
            Some of your local data could not be decrypted. It has not been
            changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm">
            Affected data:{' '}
            <span data-testid="data-problem-key" className="font-semibold">
              {storageKeyLabel(storageKey)}
            </span>
          </p>
          <p className="text-sm text-muted-foreground">
            Retry if this might be temporary. Quarantine moves the unreadable
            data aside, unchanged, so you can keep using the app.
          </p>
          {error !== null && (
            <p
              data-testid="data-problem-error"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="data-problem-retry"
            onClick={() => void onRetry()}
            disabled={pending}
          >
            Retry
          </Button>
          <Button
            type="button"
            data-testid="data-problem-quarantine"
            onClick={() => void handleQuarantine()}
            disabled={pending}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Quarantine and continue
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
