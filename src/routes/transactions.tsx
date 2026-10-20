import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'

import type { TransactionsSearch } from '@/lib/expenseDraft'
import { DEFAULT_MAIN_CURRENCY } from '@/lib/domain'
import {
  drawerInitialFromSearch,
  validateTransactionsSearch,
} from '@/lib/expenseDraft'
import { deleteExpense, getAllCategories, getAllExpenses } from '@/lib/localDb'
import { useCurrencySettings } from '@/lib/useCurrencySettings'
import PageShell from '@/components/PageShell'
import { QueryErrorState } from '@/components/QueryErrorState'
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
  // No loading gate: amounts fall back to the default main currency.
  const mainCurrency =
    useCurrencySettings().data?.mainCurrency ?? DEFAULT_MAIN_CURRENCY

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: getAllCategories,
  })
  const categories = useMemo(
    () => categoriesQuery.data ?? [],
    [categoriesQuery.data],
  )

  const expensesQuery = useQuery({
    queryKey: ['expenses'],
    queryFn: getAllExpenses,
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

  const filtered = useMemo(() => {
    if (!categoryId) return allExpenses
    return allExpenses.filter((e) => e.categoryId === categoryId)
  }, [allExpenses, categoryId])

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
      deleteExpense(id, createdAt),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      toast.success('Transaction deleted')
    },
    onError: (error: any) => {
      toast.error(`Failed to delete: ${error.message}`)
    },
  })

  const handleDelete = (id: string, createdAt: string) => {
    deleteMutation.mutate({ id, createdAt })
  }

  // ── Drawer state from the URL ─────────────────────────────────────────────
  // Every navigate call passes a plain search object (no updater function).
  const drawerMode: 'add' | 'edit' | null =
    search.edit !== undefined
      ? 'edit'
      : search.add === 'expense'
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
  useEffect(() => {
    if (editId === undefined || !expensesLoaded || editFound) return
    if (judgedEditRef.current === editId) return
    judgedEditRef.current = editId
    toast.error('Transaction not found')
    void navigate({ search: {}, replace: true })
  }, [editId, editFound, expensesLoaded, navigate])

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
              Transactions
            </h2>
            <p className="text-muted-foreground">
              Manage and review your recent spending history.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {failedQueries.length === 0 && (
              <CategoryFilter
                categories={categories}
                value={categoryId}
                onChange={handleCategoryFilterChange}
              />
            )}
            <Button
              type="button"
              data-testid="transactions-add-btn"
              onClick={openAdd}
              className="min-h-11 sm:min-h-9"
            >
              <Plus />
              Add transaction
            </Button>
          </div>
        </div>

        {failedQueries.length > 0 ? (
          <QueryErrorState
            onRetry={() => failedQueries.forEach((q) => void q.refetch())}
          />
        ) : (
          <Card className="overflow-hidden border shadow-sm">
            <TransactionsTable
              transactions={transactions}
              categories={categories}
              isLoading={isLoading}
              isError={isError}
              isDeleting={deleteMutation.isPending}
              mainCurrency={mainCurrency}
              onEdit={(tx) => openEdit(tx.id)}
              onDelete={handleDelete}
            />

            {!isLoading && !isError && transactions.length > 0 && (
              <TransactionsPagination
                pageIndex={currentPageIndex}
                pageSize={pageSize}
                totalCount={totalCount}
                totalPages={totalPages}
                onPageChange={setPageIndex}
              />
            )}
          </Card>
        )}
      </div>

      <Button
        type="button"
        size="icon"
        data-testid="transactions-add-fab"
        aria-label="Add transaction"
        onClick={openAdd}
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
    </PageShell>
  )
}
