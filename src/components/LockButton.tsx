import { useQueryClient } from '@tanstack/react-query'
import { Lock } from 'lucide-react'

import { lockApp } from '@/lib/vaultSession'
import { Button } from '@/components/ui/button'

export function LockButton() {
  const queryClient = useQueryClient()

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-9 w-9 text-muted-foreground hover:bg-accent"
      aria-label="Lock"
      title="Lock"
      data-testid="header-lock-btn"
      onClick={() => lockApp(queryClient)}
    >
      <Lock className="h-5 w-5" />
    </Button>
  )
}
