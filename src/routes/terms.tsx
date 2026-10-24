import { createFileRoute } from '@tanstack/react-router'

import PageShell from '@/components/PageShell'
import { LegalDocument } from '@/components/legal/LegalDocument'

// Public and server-rendered, in the language of the root loader. The unlock
// gate never covers it (PUBLIC_ROUTES in src/lib/vaultSession.ts).
export const Route = createFileRoute('/terms')({
  component: TermsPage,
})

function TermsPage() {
  return (
    <PageShell>
      <div
        data-testid="terms-page"
        className="max-w-2xl mx-auto px-4 sm:px-6 pt-6"
      >
        <LegalDocument kind="terms" />
      </div>
    </PageShell>
  )
}
