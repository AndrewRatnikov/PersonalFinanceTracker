import type { ReactNode } from 'react'

interface PageShellProps {
  children: ReactNode
}

export default function PageShell({ children }: PageShellProps) {
  return <div className="min-h-screen bg-slate-900 pb-20">{children}</div>
}
