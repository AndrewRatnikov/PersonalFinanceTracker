import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, Plus } from 'lucide-react'
import { toast } from 'sonner'

import type { Expense } from '@/lib/domain'
import type { TransactionsSearch } from '@/lib/expenseDraft'
import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import {
  drawerInitialFromSearch,
  validateTransactionsSearch,
} from '@/lib/expenseDraft'
import { filterByMember, memberFilterOptions } from '@/lib/memberStats'
import { spaceQueryKey, useActiveSpace, useSpaceDb } from '@/lib/spaces/react'
import { dbFor } from '@/lib/spaces/spaceDb'
import { useSpaceSwitch } from '@/lib/spaces/switcher'
import { PERSONAL_SPACE_ID } from '@/lib/spaces/types'
import { useMoveRecords } from '@/lib/spaces/useMoveRecords'
import { useCurrencySettings } from '@/lib/useCurrencySettings'
import { MemberFilter } from '@/components/members/MemberFilter'
import PageShell from '@/components/PageShell'
import { QueryErrorState } from '@/components/QueryErrorState'
import { MoveConfirmDialog } from '@/components/space/MoveConfirmDialog'
import { CategoryFilter } from '@/components/transactions/CategoryFilter'
import { ExpenseDrawer } from '@/components/transactions/ExpenseDrawer'
import { TransactionsTable } from '@/components/transactions/TransactionsTable'
import { TransactionsPagination } from '@/components/transactions/TransactionsPagination'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

// The expense drawer lives in the URL: `?add=expense` (optional `category`,
// `amount`, `currency`, `description` prefill it) and `?edit=<id>`. The back
// button closes it, links and the PWA shortcut open it, and because data
// routes stay unmounted while the vault is locked, it opens after unlock.
// With a Family held, `?add=expense&space=personal|family` first switches to
// that space (then the param is dropped), and an `?edit=<id>` of the other
// space switches to it.
export const Route = createFileRoute('/transactions')({
  validateSearch: validateTransactionsSearch,
  component: Transactions,
})

function Transactions() {
  const search: TransactionsSearch = Route.useSearch()
  const navigate = Route.useNavigate()
  const [pageIndex, setPageIndex] = useState(0)
  const pageSize = 15
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const { t, plural } = useT()
  // No loading gate: amounts fall back to the default main currency.
  const mainCurrency =
    useCurrencySettings().data?.mainCurrency ?? DEFAULT_MAIN_CURRENCY

  const spaceId = useActiveSpace()
  const db = useSpaceDb()
  const { family, isFamily, directory, readOnly, switchTo } = useSpaceSwitch()
  const mover = useMoveRecords()
  const [memberFilter, setMemberFilter] = useState('all')
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  // Ids waiting for the move confirm (bulk or one row).
  const [moveIds, setMoveIds] = useState<Array<string> | null>(null)

  // Filters, member filter, selection and page reset when the space changes.
  const [shownSpaceId, setShownSpaceId] = useState(spaceId)
  if (shownSpaceId !== spaceId) {
    setShownSpaceId(spaceId)
    setCategoryId(null)
    setMemberFilter('all')
    setSelected(new Set())
    setMoveIds(null)
    setPageIndex(0)
  }

  const categoriesQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'categories'),
    queryFn: () => db.getAllCategories(),
  })
  const categories = useMemo(
    () => categoriesQuery.data ?? [],
    [categoriesQuery.data],
  )

  const expensesQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'expenses'),
    queryFn: () => db.getAllExpenses(),
  })
  const { isLoading, isError } = expensesQuery
  const allExpenses = useMemo(
    () => expensesQuery.data ?? [],
    [expensesQuery.data],
  )

  // Never show an empty list for data that failed to load.
  const failedQueries = [categoriesQuery, expensesQuery].filter(
    (q) => q.isError,
  )

  const showMembers = isFamily && directory !== null
  const memberOptions = useMemo(
    () => (showMembers ? memberFilterOptions(directory, allExpenses) : []),
    [showMembers, directory, allExpenses],
  )

  const filtered = useMemo(() => {
    const byCategory = categoryId
      ? allExpenses.filter((e) => e.categoryId === categoryId)
      : allExpenses
    return showMembers ? filterByMember(byCategory, memberFilter) : byCategory
  }, [allExpenses, categoryId, showMembers, memberFilter])

  const totalCount = filtered.length
  const totalPages = Math.ceil(totalCount / pageSize)
  const currentPageIndex = Math.min(pageIndex, Math.max(totalPages - 1, 0))
  const transactions = useMemo(
    () =>
      filtered.slice(
        currentPageIndex * pageSize,
        (currentPageIndex + 1) * pageSize,
      ),
    [filtered, currentPageIndex, pageSize],
  )

  const deleteMutation = useMutation({
    mutationFn: ({ id, createdAt }: { id: string; createdAt: string }) =>
      db.deleteExpense(id, createdAt),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      toast.success(t('toasts.transactionDeleted'))
    },
    onError: (error: unknown) => {
      toast.error(t('toasts.deleteFailedWith', { error: errorMessage(error) }))
    },
  })

  const handleDelete = (id: string, createdAt: string) => {
    deleteMutation.mutate({ id, createdAt })
  }

  // ── Drawer state from the URL ─────────────────────────────────────────────
  // Every navigate call passes a plain search object (no updater function).
  // A `space` param (Family held) keeps the drawer closed until it's handled.
  const spaceParam = family !== null ? search.space : undefined
  const drawerMode: 'add' | 'edit' | null =
    search.edit !== undefined
      ? 'edit'
      : search.add === 'expense' && spaceParam === undefined
        ? 'add'
        : null
  const editExpense =
    drawerMode === 'edit'
      ? allExpenses.find((e) => e.id === search.edit)
      : undefined
  const drawerInitial = drawerInitialFromSearch(search)
  const drawerOpen = drawerMode === 'add' || editExpense !== undefined

  // An unknown ?edit id: judged only once the list has loaded (so the param
  // survives an unlock), toasted once per id, then dropped.
  const judgedEditRef = useRef<string | null>(null)
  const editId = search.edit
  const editFound = editExpense !== undefined
  const expensesLoaded = expensesQuery.isSuccess
  // With a Family held the other space is searched too: found there, the tab
  // switches to it (keeping ?edit, so the drawer opens there).
  const familyId = family?.id ?? null
  const familyName = family?.name ?? null
  useEffect(() => {
    if (editId === undefined || !expensesLoaded || editFound) return
    if (judgedEditRef.current === editId) return
    judgedEditRef.current = editId
    const notFound = () => {
      toast.error(t('toasts.transactionNotFound'))
      void navigate({ search: {}, replace: true })
    }
    if (familyId === null || familyName === null) {
      notFound()
      return
    }
    const other = spaceId === familyId ? PERSONAL_SPACE_ID : familyId
    queryClient
      .fetchQuery({
        queryKey: spaceQueryKey(other, 'expenses'),
        queryFn: () => dbFor(other).getAllExpenses(),
      })
      .then((list) => {
        if (judgedEditRef.current !== editId) return
        if (!list.some((e) => e.id === editId)) {
          notFound()
          return
        }
        switchTo(other)
        toast(
          t('space.switchedTo', {
            name: other === PERSONAL_SPACE_ID ? t('space.personal') : familyName,
          }),
        )
      })
      .catch((err: unknown) => {
        console.error('Looking up the entry in the other space failed:', err)
        notFound()
      })
  }, [
    editId,
    editFound,
    expensesLoaded,
    navigate,
    t,
    familyId,
    familyName,
    spaceId,
    queryClient,
    switchTo,
  ])

  // `?space=` (Family held): switch to that space first, then drop the param;
  // the add drawer then opens in the target space.
  const handledSearchRef = useRef<TransactionsSearch | null>(null)
  useEffect(() => {
    if (spaceParam === undefined || familyId === null) return
    if (handledSearchRef.current === search) return
    handledSearchRef.current = search
    const target = spaceParam === 'family' ? familyId : PERSONAL_SPACE_ID
    if (target !== spaceId) switchTo(target)
    const rest: TransactionsSearch = { ...search }
    delete rest.space
    void navigate({ search: rest, replace: true })
  }, [spaceParam, familyId, spaceId, search, switchTo, navigate])

  const openAdd = () => {
    void navigate({ search: { add: 'expense' } })
  }

  const openEdit = (id: string) => {
    void navigate({ search: { edit: id } })
  }

  const handleDrawerOpenChange = (open: boolean) => {
    if (open) return
    // A record deleted from its own drawer must not toast "not found".
    if (search.edit !== undefined) judgedEditRef.current = search.edit
    void navigate({ search: {}, replace: true })
  }

  const handleCategoryFilterChange = (value: string) => {
    setCategoryId(value === 'all' ? null : value)
    setPageIndex(0)
    setSelected(new Set())
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
      const pageIds = transactions.map((tx) => tx.id)
      const next = new Set(prev)
      if (pageIds.every((id) => next.has(id))) pageIds.forEach((id) => next.delete(id))
      else pageIds.forEach((id) => next.add(id))
      return next
    })
  }

  const confirmMove = async () => {
    if (moveIds === null) return
    const moved = await mover.move('expense', moveIds)
    if (moved) {
      setMoveIds(null)
      setSelected(new Set())
    }
  }

  return (
    <PageShell>
      <div
        data-testid="transactions-page"
        className="p-4 md:p-8 max-w-6xl mx-auto min-h-screen animate-in fade-in duration-500"
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8">
          <div className="space-y-1">
            <h2 className="text-3xl font-bold tracking-tight text-foreground">
              {t('transactions.title')}
            </h2>
            <p className="text-muted-foreground">{t('transactions.subtitle')}</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {failedQueries.length === 0 && (
              <CategoryFilter
                categories={categories}
                value={categoryId}
                onChange={handleCategoryFilterChange}
              />
            )}
            {failedQueries.length === 0 && showMembers && (
              <MemberFilter
                value={memberFilter}
                onChange={handleMemberFilterChange}
                options={memberOptions}
              />
            )}
            <Button
              type="button"
              data-testid="transactions-add-btn"
              onClick={openAdd}
              disabled={readOnly}
              className="min-h-11 sm:min-h-9"
            >
              <Plus />
              {t('drawer.addTitle')}
            </Button>
          </div>
        </div>

        {failedQueries.length > 0 ? (
          <QueryErrorState
            onRetry={() => failedQueries.forEach((q) => void q.refetch())}
          />
        ) : (
          <Card className="overflow-hidden border shadow-sm">
            {canMove && selected.size > 0 && (
              <div
                data-testid="transactions-bulk-bar"
                className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/40 px-4 py-2"
              >
                <span className="text-sm font-medium">
                  {plural('move.selected', selected.size)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  data-testid="transactions-bulk-move"
                  disabled={mover.disabled || mover.isPending}
                  onClick={() => setMoveIds(Array.from(selected))}
                  className="min-h-11 sm:min-h-8"
                >
                  <ArrowRightLeft />
                  {moveLabel}
                </Button>
              </div>
            )}
            <TransactionsTable
              transactions={transactions}
              categories={categories}
              isLoading={isLoading}
              isError={isError}
              isDeleting={deleteMutation.isPending}
              mainCurrency={mainCurrency}
              onEdit={(tx) => openEdit(tx.id)}
              onDelete={handleDelete}
              readOnly={readOnly}
              {...(showMembers ? { members: directory } : {})}
              {...(canMove
                ? {
                    selection: {
                      selected,
                      onToggle: toggleSelected,
                      onToggleAll: toggleAllOnPage,
                    },
                    onMove: (tx: Expense) => setMoveIds([tx.id]),
                    moveLabel,
                    moveDisabled: mover.disabled || mover.isPending,
                  }
                : {})}
            />

            {!isLoading && !isError && transactions.length > 0 && (
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

      <Button
        type="button"
        size="icon"
        data-testid="transactions-add-fab"
        aria-label={t('drawer.addTitle')}
        onClick={openAdd}
        disabled={readOnly}
        className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40 h-14 w-14 rounded-full shadow-lg sm:hidden"
      >
        <Plus className="size-6" />
      </Button>

      {drawerMode !== null && (
        <ExpenseDrawer
          key={
            drawerMode === 'edit'
              ? `edit-${search.edit ?? ''}`
              : `add-${JSON.stringify(drawerInitial)}`
          }
          mode={drawerMode}
          expense={editExpense}
          open={drawerOpen}
          onOpenChange={handleDrawerOpenChange}
          initial={drawerMode === 'add' ? drawerInitial : undefined}
          categories={categories}
          mainCurrency={mainCurrency}
          entries={allExpenses}
        />
      )}

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
