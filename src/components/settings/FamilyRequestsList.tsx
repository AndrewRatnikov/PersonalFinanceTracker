import { useEffect, useState } from 'react'

import type { FamilyMember } from '@/components/settings/FamilyMembersList'
import { useT } from '@/i18n'
import { formatFullDate, formatTime } from '@/i18n/format'
import { safetyCode } from '@/lib/spaces/spaceCrypto'
import { Button } from '@/components/ui/button'

interface FamilyRequestsListProps {
  requests: Array<FamilyMember>
  onApprove: (userId: string) => void | Promise<void>
  onReject: (userId: string) => void | Promise<void>
  busy?: boolean
}

// The safety code of the requester's public key, computed on this device so
// the owner can compare it with what the requester sees.
function useSafetyCode(publicKey: JsonWebKey): string | null {
  const [code, setCode] = useState<string | null>(null)
  const keyId = JSON.stringify(publicKey)
  useEffect(() => {
    let cancelled = false
    setCode(null)
    safetyCode(publicKey).then(
      (value) => {
        if (!cancelled) setCode(value)
      },
      () => {
        if (!cancelled) setCode(null)
      },
    )
    return () => {
      cancelled = true
    }
    // keyId stands for the key's content.
  }, [keyId])
  return code
}

function RequestRow({
  request,
  onApprove,
  onReject,
  busy,
}: {
  request: FamilyMember
  onApprove: (userId: string) => void | Promise<void>
  onReject: (userId: string) => void | Promise<void>
  busy: boolean
}) {
  const { t } = useT()
  const code = useSafetyCode(request.public_key)
  const email = request.email ?? request.user_id.slice(0, 8)
  const when = `${formatFullDate(request.requested_at)} ${formatTime(request.requested_at)}`

  return (
    <li data-testid="family-request-row" className="flex flex-col gap-2 p-3">
      <div className="flex flex-col gap-0.5">
        <span data-testid="family-request-email" className="font-medium">
          {email}
        </span>
        <span data-testid="family-request-time" className="text-xs text-muted-foreground">
          {t('family.requests.asked', { when })}
        </span>
        <span data-testid="family-request-safety-code" className="font-mono text-sm">
          {t('family.requests.safetyCode', { code: code ?? '…' })}
        </span>
        <span data-testid="family-request-hint" className="text-xs text-muted-foreground">
          {t('family.requests.hint', { email })}
        </span>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          data-testid="family-request-approve-btn"
          disabled={busy}
          onClick={() => void onApprove(request.user_id)}
        >
          {t('family.requests.approve')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="family-request-reject-btn"
          disabled={busy}
          onClick={() => void onReject(request.user_id)}
        >
          {t('family.requests.reject')}
        </Button>
      </div>
    </li>
  )
}

// Pending join requests (owner only): email, request time, safety code, and
// Approve / Reject.
export function FamilyRequestsList({ requests, onApprove, onReject, busy = false }: FamilyRequestsListProps) {
  const { t } = useT()
  return (
    <div data-testid="family-requests" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-foreground">{t('family.requests.title')}</h3>
      <ul className="flex flex-col divide-y rounded-md border">
        {requests.map((request) => (
          <RequestRow
            key={request.user_id}
            request={request}
            onApprove={onApprove}
            onReject={onReject}
            busy={busy}
          />
        ))}
      </ul>
    </div>
  )
}
