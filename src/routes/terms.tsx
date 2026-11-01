import { createFileRoute } from '@tanstack/react-router'

import PageShell from '@/components/PageShell'
import PageContainer from '@/components/PageContainer'
import { LegalDocument } from '@/components/legal/LegalDocument'

// Public and server-rendered, in the language of the root loader. The unlock
// gate never covers it (PUBLIC_ROUTES in src/lib/vaultSession.ts).
export const Route = createFileRoute('/terms')({
  component: TermsPage,
})

function TermsPage() {
  return (
    <PageShell>
      <PageContainer width="reading" data-testid="terms-page">
        <LegalDocument kind="terms" />
      </PageContainer>
    </PageShell>
  )
}
