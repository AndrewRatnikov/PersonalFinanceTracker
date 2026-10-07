import { TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'

interface QueryErrorStateProps {
  onRetry: () => void
  message?: string
}

// Inline error block shown in place of a page's data content when one of its
// queries failed. A DecryptError never needs handling here: the global
// QueryCache onError swaps the whole app for the Data problem screen.
export function QueryErrorState({
  onRetry,
  message = "Couldn't load your data.",
}: QueryErrorStateProps) {
  return (
    <div
      data-testid="query-error"
      role="alert"
      className="flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-10 text-center"
    >
      <div className="flex items-center gap-2 text-sm text-destructive">
        <TriangleAlert className="h-4 w-4" />
        <span>{message}</span>
      </div>
      <Button
        type="button"
        variant="outline"
        data-testid="query-error-retry"
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  )
}
