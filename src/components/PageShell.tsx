import type { ReactNode } from 'react'

interface PageShellProps {
  children: ReactNode
}

export default function PageShell({ children }: PageShellProps) {
  return (
    <div className="min-h-screen bg-background text-foreground pb-20 selection:bg-primary/20">
      {children}
    </div>
  )
}
