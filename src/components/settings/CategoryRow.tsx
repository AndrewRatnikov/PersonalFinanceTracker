import { useState } from 'react'
import { Check, Pencil, Trash2, X } from 'lucide-react'
import type { Category, Currency, UpdateCategoryInput } from '../../lib/domain'
import { useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { CURRENCIES, isCurrency } from '@/lib/domain'
import { useSpaceDb } from '@/lib/spaces/react'
import { useSpaceAccess } from '@/lib/spaces/switcher'
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
  const { t } = useT()
  // A read-only Family copy can be browsed but not changed.
  const { readOnly } = useSpaceAccess()

  const db = useSpaceDb()
  // The handle's members are read at call time only.
  const update = (input: UpdateCategoryInput) =>
    kind === 'income' ? db.updateIncomeCategory(input) : db.updateCategory(input)

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
    } catch (e: unknown) {
      onError(errorMessage(e))
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
    } catch (e: unknown) {
      onError(errorMessage(e))
    } finally {
      setIsPending(false)
      setPendingCurrency(null)
    }
  }

  const remove = async () => {
    setIsPending(true)
    try {
      if (kind === 'income') await db.deleteIncomeCategory(category.id)
      else await db.deleteCategory(category.id)
      onMutate()
    } catch (e: unknown) {
      onError(errorMessage(e))
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
            aria-label={t('settings.categories.name')}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            maxLength={40}
            className="flex-1 bg-transparent border-none text-foreground text-sm focus-visible:ring-0 focus-visible:ring-offset-0 h-auto p-0 font-medium"
          />
          <Input
            type="text"
            value={editIcon}
            onChange={(e) => setEditIcon(e.target.value)}
            placeholder={t('settings.categories.iconShort')}
            aria-label={t('settings.categories.icon')}
            className="w-16 bg-transparent border-none text-muted-foreground text-sm focus-visible:ring-0 focus-visible:ring-offset-0 h-auto p-0 text-center"
          />
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              data-testid="category-edit-save"
              aria-label={t('settings.categories.save')}
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
              aria-label={t('settings.categories.cancelRename')}
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
          aria-label={t('settings.categories.currencyFor', { name: category.name })}
          title={t('settings.categories.defaultCurrency')}
          value={pendingCurrency ?? category.defaultCurrency ?? ''}
          onChange={(e) => void saveCurrency(e.target.value)}
          disabled={isPending || readOnly}
          className="h-11 rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:h-8"
        >
          <option value="">{t('settings.general.mainCurrency')}</option>
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
            disabled={readOnly}
            className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-transparent transition-colors"
            aria-label={t('settings.categories.rename')}
          >
            <Pencil size={14} />
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                data-testid="category-delete-btn"
                disabled={readOnly}
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-transparent transition-colors"
                aria-label={t('settings.categories.delete')}
              >
                <Trash2 size={14} />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('settings.categories.deleteTitle')}</AlertDialogTitle>
                <AlertDialogDescription data-testid="category-delete-description">
                  {kind === 'income'
                    ? t('settings.categories.deleteIncomeQuestion', { name: category.name })
                    : t('settings.categories.deleteExpenseQuestion', { name: category.name })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  data-testid="category-delete-confirm"
                  onClick={remove}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {t('common.delete')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  )
}
