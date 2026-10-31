// The empty Family dashboard (spec §23): invite members (owner only), move
// entries from Personal, or add the first expense.

import { useNavigate } from '@tanstack/react-router'
import { ArrowRightLeft, Plus, UserPlus, Users } from 'lucide-react'

import { useT } from '@/i18n'
import { useSpaceSwitch } from '@/lib/spaces/switcher'
import { PERSONAL_SPACE_ID } from '@/lib/spaces/types'
import { Button } from '@/components/ui/button'

export function FamilyEmptyState({ onAddFirst }: { onAddFirst: () => void }) {
  const { t } = useT()
  const navigate = useNavigate()
  const { family, readOnly, switchTo } = useSpaceSwitch()
  if (family === null) return null

  return (
    <div
      data-testid="family-empty-state"
      className="rounded-xl border border-dashed bg-card px-4 py-6 flex flex-col items-center gap-4 text-center"
    >
      <Users className="h-8 w-8 text-primary" aria-hidden="true" />
      <p className="font-medium">{t('space.emptyTitle', { name: family.name })}</p>
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
        {family.role === 'owner' && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            data-testid="family-empty-invite"
            onClick={() => void navigate({ to: '/settings', search: { tab: 'family' } })}
          >
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            {t('space.emptyInvite')}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          className="min-h-11 sm:min-h-9"
          data-testid="family-empty-move"
          onClick={() => {
            switchTo(PERSONAL_SPACE_ID)
            void navigate({ to: '/transactions' })
          }}
        >
          <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
          {t('space.emptyMove')}
        </Button>
        <Button
          type="button"
          className="min-h-11 sm:min-h-9"
          data-testid="family-empty-add"
          disabled={readOnly}
          onClick={onAddFirst}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('space.emptyAdd')}
        </Button>
      </div>
    </div>
  )
}
