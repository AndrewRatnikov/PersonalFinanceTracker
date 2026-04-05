import { useState } from 'react'
import { Check, Pencil, Trash2, X } from 'lucide-react'
import { deleteCategory, updateCategory } from '../../lib/categories'
import type { Category } from '../../lib/domain'
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
}

export function CategoryRow({ category, onMutate, onError }: CategoryRowProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(category.name)
  const [editIcon, setEditIcon] = useState(category.icon ?? '')
  const [isPending, setIsPending] = useState(false)

  const save = async () => {
    setIsPending(true)
    try {
      await updateCategory({
        data: { id: category.id, name: editName, icon: editIcon || null },
      })
      onMutate()
      setIsEditing(false)
    } catch (e: any) {
      onError(e?.message ?? 'Failed to update category')
    } finally {
      setIsPending(false)
    }
  }

  const remove = async () => {
    setIsPending(true)
    try {
      await deleteCategory({ data: category.id })
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
            className="w-16 bg-transparent border-none text-muted-foreground text-sm focus-visible:ring-0 focus-visible:ring-offset-0 h-auto p-0 text-center"
          />
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
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
    <Card className="border-border bg-card/40 transition-colors hover:bg-accent/30 group">
      <CardContent className="px-3 py-2.5 flex items-center gap-3">
        {category.icon && (
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-secondary/50 text-base shadow-sm">
            {category.icon}
          </div>
        )}
        <span className="flex-1 text-sm font-medium text-foreground">{category.name}</span>

        <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsEditing(true)}
            className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-transparent transition-colors"
            aria-label="Rename category"
          >
            <Pencil size={14} />
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
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
                <AlertDialogDescription>
                  Are you sure you want to delete <strong>{category.name}</strong>? 
                  Expenses in this category will become uncategorized.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction 
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
