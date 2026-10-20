import { useState } from 'react'
import { Check, Pencil, Trash2, X } from 'lucide-react'
import type { Category, Currency } from '../../lib/domain'
import { CURRENCIES, isCurrency } from '@/lib/domain'
import {
  deleteCategory,
  deleteIncomeCategory,
  updateCategory,
  updateIncomeCategory,
} from '@/lib/localDb'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Card, CardContent } from '@/components/ui/card'

interface CategoryRowProps {
  category: Category
  onMutate: () => void
  onError: (msg: string) => void
  /** Which category list the row belongs to. Defaults to 'expense'. */
  kind?: 'expense' | 'income'
}

export function CategoryRow({
  category,
  onMutate,
  onError,
  kind = 'expense',
}: CategoryRowProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(category.name)
  const [editIcon, setEditIcon] = useState(category.icon ?? '')
  const [isPending, setIsPending] = useState(false)
  // The value just picked in the currency select, shown while it saves.
  const [pendingCurrency, setPendingCurrency] = useState<string | null>(null)

  const update = kind === 'income' ? updateIncomeCategory : updateCategory

  // Renaming never sends defaultCurrency, so the stored value is kept.
  const save = async () => {
    setIsPending(true)
    try {
      await update({
        id: category.id,
        name: editName,
        icon: editIcon || null,
      })
      onMutate()
      setIsEditing(false)
    } catch (e: any) {
      onError(e?.message ?? 'Failed to update category')
    } finally {
      setIsPending(false)
    }
  }

  // '' = "Main currency": clears the default (null).
  const saveCurrency = async (value: string) => {
    const next: Currency | null = isCurrency(value) ? value : null
    setPendingCurrency(value)
    setIsPending(true)
    try {
      await update({
        id: category.id,
        name: category.name,
        icon: category.icon ?? null,
        defaultCurrency: next,
      })
      onMutate()
    } catch (e: any) {
      onError(e?.message ?? 'Failed to update category')
    } finally {
      setIsPending(false)
      setPendingCurrency(null)
    }
  }

  const remove = async () => {
    setIsPending(true)
    try {
      const del = kind === 'income' ? deleteIncomeCategory : deleteCategory
      await del(category.id)
      onMutate()
    } catch (e: any) {
      onError(e?.message ?? 'Failed to delete category')
    } finally {
      setIsPending(false)
    }
  }

  if (isEditing) {
    return (
      <Card className="border-primary/50 bg-accent/20">
        <CardContent className="px-3 py-2 flex items-center gap-2">
          <Input
            autoFocus
            type="text"
            data-testid="category-edit-name"
            aria-label="Category name"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            maxLength={40}
            className="flex-1 bg-transparent border-none text-foreground text-sm focus-visible:ring-0 focus-visible:ring-offset-0 h-auto p-0 font-medium"
          />
          <Input
            type="text"
            value={editIcon}
            onChange={(e) => setEditIcon(e.target.value)}
            placeholder="icon"
            aria-label="Category icon"
            className="w-16 bg-transparent border-none text-muted-foreground text-sm focus-visible:ring-0 focus-visible:ring-offset-0 h-auto p-0 text-center"
          />
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              data-testid="category-edit-save"
              aria-label="Save category"
              onClick={save}
              disabled={isPending || !editName.trim()}
              className="h-8 w-8 text-primary hover:text-primary/80 hover:bg-transparent"
            >
              <Check size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsEditing(false)}
              aria-label="Cancel renaming"
              className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-transparent"
            >
              <X size={16} />
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card
      data-testid="category-row"
      className="border-border bg-card/40 transition-colors hover:bg-accent/30 group"
    >
      <CardContent className="px-3 py-2.5 flex items-center gap-3">
        {category.icon && (
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-secondary/50 text-base shadow-sm">
            {category.icon}
          </div>
        )}
        <span
          data-testid="category-row-name"
          className="flex-1 text-sm font-medium text-foreground"
        >
          {category.name}
        </span>

        <select
          data-testid={`category-default-currency-${category.id}`}
          aria-label={`Currency for ${category.name}`}
          title="Default currency"
          value={pendingCurrency ?? category.defaultCurrency ?? ''}
          onChange={(e) => void saveCurrency(e.target.value)}
          disabled={isPending}
          className="h-11 rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:h-8"
        >
          <option value="">Main currency</option>
          {CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="icon"
            data-testid="category-rename-btn"
            onClick={() => setIsEditing(true)}
            className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-transparent transition-colors"
            aria-label="Rename category"
          >
            <Pencil size={14} />
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                data-testid="category-delete-btn"
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-transparent transition-colors"
                aria-label="Delete category"
              >
                <Trash2 size={14} />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Category</AlertDialogTitle>
                <AlertDialogDescription data-testid="category-delete-description">
                  Are you sure you want to delete{' '}
                  <strong>{category.name}</strong>? A category that is still
                  used by {kind === 'income' ? 'income entries' : 'expenses'}{' '}
                  cannot be deleted.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  data-testid="category-delete-confirm"
                  onClick={remove}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  )
}
