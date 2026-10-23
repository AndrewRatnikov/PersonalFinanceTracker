import { createFileRoute } from '@tanstack/react-router'

import PageShell from '@/components/PageShell'
import { LegalDocument } from '@/components/legal/LegalDocument'

// Public and server-rendered, in the language of the root loader. The unlock
// gate never covers it (PUBLIC_ROUTES in src/lib/vaultSession.ts).
export const Route = createFileRoute('/privacy')({
  component: PrivacyPage,
})

function PrivacyPage() {
  return (
    <PageShell>
      <div
        data-testid="privacy-page"
        className="max-w-2xl mx-auto px-4 sm:px-6 pt-6"
      >
        <LegalDocument kind="privacy" />
      </div>
    </PageShell>
  )
}
