import { createFileRoute } from '@tanstack/react-router'
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { getAllIncome, deleteIncome } from '@/lib/localDb'
import PageShell from '@/components/PageShell'
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

  const { data: allIncome = [], isLoading, isError } = useQuery({
    queryKey: ['income'],
    queryFn: getAllIncome,
  })

  const sorted = useMemo(
    () => [...allIncome].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [allIncome],
  )
  const totalCount = sorted.length
  const totalPages = Math.ceil(totalCount / pageSize)
  const income = useMemo(
    () => sorted.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
    [sorted, pageIndex, pageSize],
  )

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteIncome(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['income'] })
      toast.success('Income deleted')
    },
    onError: (error: any) => {
      toast.error(`Failed to delete: ${error.message}`)
    },
  })

  const handleAdded = () => {
    queryClient.invalidateQueries({ queryKey: ['income'] })
  }

  return (
    <PageShell>
      <div className="p-4 md:p-8 max-w-6xl mx-auto min-h-screen animate-in fade-in duration-500">
        <div className="space-y-1 mb-8">
          <h2 className="text-3xl font-bold tracking-tight text-foreground">
            Income
          </h2>
          <p className="text-muted-foreground">
            Track your income sources and history.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1">
            <AddIncomeForm onSuccess={handleAdded} />
          </div>

          <div className="lg:col-span-2">
            <Card className="overflow-hidden border shadow-sm">
              <IncomeTable
                income={income}
                isLoading={isLoading}
                isError={isError}
                isDeleting={deleteMutation.isPending}
                onDelete={(id) => deleteMutation.mutate(id)}
              />

              {!isLoading && !isError && income.length > 0 && (
                <TransactionsPagination
                  pageIndex={pageIndex}
                  pageSize={pageSize}
                  totalCount={totalCount}
                  totalPages={totalPages}
                  onPageChange={setPageIndex}
                />
              )}
            </Card>
          </div>
        </div>
      </div>
    </PageShell>
  )
}
