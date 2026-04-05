import { Link } from '@tanstack/react-router'
import PageShell from './PageShell'
import { Button } from '@/components/ui/button'

export default function NotFoundPage() {
  return (
    <PageShell>
      <div className="flex flex-col items-center justify-center py-20 text-center gap-6">
        <h1 className="text-4xl font-bold">404 — Page Not Found</h1>
        <p className="text-muted-foreground">
          The page you're looking for doesn't exist.
        </p>
        <Button asChild size="lg" className="mt-4">
          <Link to="/">
            Go Home
          </Link>
        </Button>
      </div>
    </PageShell>
  )
}
