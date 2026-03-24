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
      <div className="bg-slate-800/60 border border-cyan-500/40 rounded-xl px-3 py-2 flex items-center gap-2">
        <Input
          autoFocus
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          maxLength={40}
          className="flex-1 bg-transparent border-none text-white text-sm focus-visible:ring-0 focus-visible:ring-offset-0 h-auto p-0"
        />
        <Input
          type="text"
          value={editIcon}
          onChange={(e) => setEditIcon(e.target.value)}
          placeholder="icon"
          className="w-20 bg-transparent border-none text-slate-400 text-sm focus-visible:ring-0 focus-visible:ring-offset-0 h-auto p-0"
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={save}
          disabled={isPending || !editName.trim()}
          className="h-8 w-8 text-cyan-400 hover:text-cyan-300 hover:bg-transparent disabled:opacity-50"
          aria-label="Save"
        >
          <Check size={18} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setIsEditing(false)}
          className="h-8 w-8 text-slate-500 hover:text-slate-300 hover:bg-transparent"
          aria-label="Cancel"
        >
          <X size={18} />
        </Button>
      </div>
    )
  }

  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl px-3 py-2 flex items-center gap-2 group">
      {category.icon && (
        <span className="text-xs bg-slate-700 px-2 py-0.5 rounded-md text-slate-300 font-mono">
          {category.icon}
        </span>
      )}
      <span className="flex-1 text-white text-sm">{category.name}</span>

      <div className="flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setIsEditing(true)}
          className="h-8 w-8 text-slate-500 hover:text-cyan-400 hover:bg-transparent transition-colors"
          aria-label="Rename category"
        >
          <Pencil size={16} />
        </Button>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-slate-500 hover:text-red-400 hover:bg-transparent transition-colors"
              aria-label="Delete category"
            >
              <Trash2 size={16} />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="bg-slate-900 border-slate-700 text-white">
            <AlertDialogHeader >
              <AlertDialogTitle>Are you sure?</AlertDialogTitle>
              <AlertDialogDescription className="text-slate-400">
                This will delete the category <strong>{category.name}</strong>. 
                Any expenses using this category will become uncategorized.
                This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="bg-slate-800 border-slate-700 text-white hover:bg-slate-700">Cancel</AlertDialogCancel>
              <AlertDialogAction 
                onClick={remove}
                className="bg-red-600 hover:bg-red-700 text-white border-none"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}
