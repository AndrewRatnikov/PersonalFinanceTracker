import { createFileRoute } from '@tanstack/react-router'

import PageShell from '@/components/PageShell'
import { JoinPage } from '@/components/JoinPage'

// /join#<inviteId>.<secret>: the Family invite link. Neither a data route nor
// a public route, so a locked vault shows the unlock gate over it. The
// fragment is read on the client only and never reaches the server.
export const Route = createFileRoute('/join')({
  component: JoinRoute,
})

function JoinRoute() {
  return (
    <PageShell>
      <JoinPage />
    </PageShell>
  )
}
