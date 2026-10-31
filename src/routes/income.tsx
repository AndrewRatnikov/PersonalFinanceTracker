import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft } from 'lucide-react'
import { toast } from 'sonner'

import type { IncomeEntry } from '@/lib/domain'
import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import { filterByMember, memberFilterOptions } from '@/lib/memberStats'
import { spaceQueryKey, useActiveSpace, useSpaceDb } from '@/lib/spaces/react'
import { useSpaceSwitch } from '@/lib/spaces/switcher'
import { useMoveRecords } from '@/lib/spaces/useMoveRecords'
import { useCurrencySettings } from '@/lib/useCurrencySettings'
import { MemberFilter } from '@/components/members/MemberFilter'
import PageShell from '@/components/PageShell'
import { QueryErrorState } from '@/components/QueryErrorState'
import { MoveConfirmDialog } from '@/components/space/MoveConfirmDialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { AddIncomeForm } from '@/components/income/AddIncomeForm'
import { IncomeTable } from '@/components/income/IncomeTable'
import { TransactionsPagination } from '@/components/transactions/TransactionsPagination'

export const Route = createFileRoute('/income')({
  component: IncomePage,
})

function IncomePage() {
  const [pageIndex, setPageIndex] = useState(0)
  const pageSize = 15
  const queryClient = useQueryClient()
  const { t, plural } = useT()
  // No loading gate: amounts fall back to the default main currency.
  const mainCurrency =
    useCurrencySettings().data?.mainCurrency ?? DEFAULT_MAIN_CURRENCY

  const spaceId = useActiveSpace()
  const db = useSpaceDb()
  const { isFamily, family, directory, readOnly } = useSpaceSwitch()
  const mover = useMoveRecords()
  const [memberFilter, setMemberFilter] = useState('all')
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  // Ids waiting for the move confirm (bulk or one row).
  const [moveIds, setMoveIds] = useState<Array<string> | null>(null)

  // Member filter, selection and page reset when the space changes.
  const [shownSpaceId, setShownSpaceId] = useState(spaceId)
  if (shownSpaceId !== spaceId) {
    setShownSpaceId(spaceId)
    setMemberFilter('all')
    setSelected(new Set())
    setMoveIds(null)
    setPageIndex(0)
  }

  const incomeQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'income'),
    queryFn: () => db.getAllIncome(),
  })
  const { data: allIncome, isLoading, isError } = incomeQuery

  const incomeCategoriesQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'incomeCategories'),
    queryFn: () => db.getAllIncomeCategories(),
  })

  const sorted = useMemo(
    () =>
      [...(allIncome ?? [])].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    [allIncome],
  )
  const showMembers = isFamily && directory !== null
  const memberOptions = useMemo(
    () => (showMembers ? memberFilterOptions(directory, sorted) : []),
    [showMembers, directory, sorted],
  )
  const filtered = useMemo(
    () => (showMembers ? filterByMember(sorted, memberFilter) : sorted),
    [showMembers, sorted, memberFilter],
  )
  const totalCount = filtered.length
  const totalPages = Math.ceil(totalCount / pageSize)
  const currentPageIndex = Math.min(pageIndex, Math.max(totalPages - 1, 0))
  const income = useMemo(
    () =>
      filtered.slice(
        currentPageIndex * pageSize,
        (currentPageIndex + 1) * pageSize,
      ),
    [filtered, currentPageIndex, pageSize],
  )

  const deleteMutation = useMutation({
    mutationFn: (id: string) => db.deleteIncome(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['income'] })
      toast.success(t('toasts.incomeDeleted'))
    },
    onError: (error: unknown) => {
      toast.error(t('toasts.deleteFailedWith', { error: errorMessage(error) }))
    },
  })

  const handleAdded = () => {
    queryClient.invalidateQueries({ queryKey: ['income'] })
  }

  const handleMemberFilterChange = (value: string) => {
    setMemberFilter(value)
    setPageIndex(0)
    setSelected(new Set())
  }

  const handlePageChange = (next: number) => {
    setPageIndex(next)
    setSelected(new Set())
  }

  // ── Move between spaces (a Family is held) ────────────────────────────────
  const canMove = mover.direction !== null
  const moveLabel =
    mover.direction === 'to-personal' ? t('move.toPersonal') : t('move.toFamily')

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Select all on this page, or clear the page when it's all selected.
  const toggleAllOnPage = () => {
    setSelected((prev) => {
      const pageIds = income.map((entry) => entry.id)
      const next = new Set(prev)
      if (pageIds.every((id) => next.has(id))) pageIds.forEach((id) => next.delete(id))
      else pageIds.forEach((id) => next.add(id))
      return next
    })
  }

  const confirmMove = async () => {
    if (moveIds === null) return
    const moved = await mover.move('income', moveIds)
    if (moved) {
      setMoveIds(null)
      setSelected(new Set())
    }
  }

  return (
    <PageShell>
      <div
        data-testid="income-page"
        className="p-4 md:p-8 max-w-6xl mx-auto min-h-screen animate-in fade-in duration-500"
      >
        <div className="space-y-1 mb-8">
          <h2 className="text-3xl font-bold tracking-tight text-foreground">
            {t('income.title')}
          </h2>
          <p className="text-muted-foreground">{t('income.subtitle')}</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1">
            {incomeCategoriesQuery.isError ? (
              <QueryErrorState
                onRetry={() => void incomeCategoriesQuery.refetch()}
              />
            ) : incomeCategoriesQuery.isSuccess ? (
              <AddIncomeForm
                categories={incomeCategoriesQuery.data}
                onSuccess={handleAdded}
                defaultCurrency={mainCurrency}
                entries={sorted}
              />
            ) : null}
          </div>

          <div className="lg:col-span-2">
            {isError ? (
              // Never show an empty table for data that failed to load.
              <QueryErrorState onRetry={() => void incomeQuery.refetch()} />
            ) : (
              <Card className="overflow-hidden border shadow-sm">
                {showMembers && (
                  <div className="flex justify-end border-b px-4 py-2">
                    <MemberFilter
                      value={memberFilter}
                      onChange={handleMemberFilterChange}
                      options={memberOptions}
                    />
                  </div>
                )}
                {canMove && selected.size > 0 && (
                  <div
                    data-testid="income-bulk-bar"
                    className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/40 px-4 py-2"
                  >
                    <span className="text-sm font-medium">
                      {plural('move.selected', selected.size)}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      data-testid="income-bulk-move"
                      disabled={mover.disabled || mover.isPending}
                      onClick={() => setMoveIds(Array.from(selected))}
                      className="min-h-11 sm:min-h-8"
                    >
                      <ArrowRightLeft />
                      {moveLabel}
                    </Button>
                  </div>
                )}
                <IncomeTable
                  income={income}
                  isLoading={isLoading}
                  isError={isError}
                  isDeleting={deleteMutation.isPending}
                  mainCurrency={mainCurrency}
                  onDelete={(id) => deleteMutation.mutate(id)}
                  readOnly={readOnly}
                  {...(showMembers ? { members: directory } : {})}
                  {...(canMove
                    ? {
                        selection: {
                          selected,
                          onToggle: toggleSelected,
                          onToggleAll: toggleAllOnPage,
                        },
                        onMove: (entry: IncomeEntry) => setMoveIds([entry.id]),
                        moveLabel,
                        moveDisabled: mover.disabled || mover.isPending,
                      }
                    : {})}
                />

                {!isLoading && income.length > 0 && (
                  <TransactionsPagination
                    pageIndex={currentPageIndex}
                    pageSize={pageSize}
                    totalCount={totalCount}
                    totalPages={totalPages}
                    onPageChange={handlePageChange}
                  />
                )}
              </Card>
            )}
          </div>
        </div>
      </div>

      {mover.direction !== null && family !== null && (
        <MoveConfirmDialog
          open={moveIds !== null}
          onOpenChange={(open) => {
            if (!open && !mover.isPending) setMoveIds(null)
          }}
          count={moveIds?.length ?? 0}
          direction={mover.direction}
          familyName={family.name}
          pending={mover.isPending}
          onConfirm={() => void confirmMove()}
        />
      )}
    </PageShell>
  )
}
