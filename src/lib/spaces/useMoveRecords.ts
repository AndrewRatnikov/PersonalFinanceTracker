// The move mutation behind the "Move to Family" / "Move to Personal" actions
// (spec §23, D2). The direction follows the active space: in the Family the
// records go to Personal, in Personal (with a Family held) to the Family.
// localDb.moveRecords is reached at call time (test mocks may be partial).

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { moveRecords } from '../localDb'
import { useSpaceSwitch } from './switcher'
import { PERSONAL_SPACE_ID } from './types'
import type { MoveRecordType } from '../localDb'
import { useT } from '@/i18n'
import { errorMessage, familyErrorMessage } from '@/i18n/errors'

// Space errors (read-only copy, ...) read as Family errors; everything else
// (AppError codes such as move-too-many, plain errors) through errorMessage.
function moveErrorText(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'SpaceReadOnlyError' || name === 'CloudError' || name === 'FamilyActionError') {
    return familyErrorMessage(err)
  }
  return errorMessage(err)
}

const INVALIDATED = [
  'expenses',
  'income',
  'recurring',
  'analytics',
  'categories',
  'incomeCategories',
  'budgets',
]

export function useMoveRecords(): {
  direction: 'to-family' | 'to-personal' | null
  disabled: boolean
  isPending: boolean
  move: (type: MoveRecordType, ids: Array<string>) => Promise<boolean>
} {
  const { t, plural } = useT()
  const queryClient = useQueryClient()
  const { spaceId, family, isFamily, readOnly } = useSpaceSwitch()
  const direction = family === null ? null : isFamily ? 'to-personal' : 'to-family'
  const disabled =
    readOnly || (direction === 'to-family' && family !== null && family.readOnly)

  const mutation = useMutation({
    mutationFn: (input: { type: MoveRecordType; ids: Array<string> }) => {
      if (family === null) throw new Error('No Family space')
      const to = isFamily ? PERSONAL_SPACE_ID : family.id
      return moveRecords({ from: spaceId, to, type: input.type, ids: input.ids })
    },
  })

  const move = async (type: MoveRecordType, ids: Array<string>): Promise<boolean> => {
    if (direction === null || disabled || ids.length === 0) return false
    try {
      const result = await mutation.mutateAsync({ type, ids })
      await Promise.all(
        INVALIDATED.map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
      )
      toast.success(plural('move.done', result.moved))
      return true
    } catch (err) {
      toast.error(t('move.failed', { error: moveErrorText(err) }))
      return false
    }
  }

  return { direction, disabled, isPending: mutation.isPending, move }
}
