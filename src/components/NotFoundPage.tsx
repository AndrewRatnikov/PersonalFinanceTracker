import { Link } from '@tanstack/react-router'
import PageShell from './PageShell'

export default function NotFoundPage() {
  return (
    <PageShell>
      <div className="flex flex-col items-center justify-center py-20 text-center gap-6">
        <h1 className="text-4xl font-bold text-white">404 — Page Not Found</h1>
        <p className="text-slate-400">
          The page you're looking for doesn't exist.
        </p>
        <Link
          to="/"
          className="mt-4 px-6 py-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-medium transition-colors"
        >
          Go Home
        </Link>
      </div>
    </PageShell>
  )
}
