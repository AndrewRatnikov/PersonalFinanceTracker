import { useState } from 'react'
import { Check, Pencil, Trash2, X } from 'lucide-react'
import { deleteCategory, updateCategory } from '../../lib/categories'
import type { Category } from '../../lib/domain'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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
  const [deleteConfirm, setDeleteConfirm] = useState(false)

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
      setDeleteConfirm(false)
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
          className="p-1 h-auto w-auto text-cyan-400 hover:text-cyan-300 hover:bg-transparent disabled:opacity-50"
          aria-label="Save"
        >
          <Check size={18} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setIsEditing(false)}
          className="p-1 h-auto w-auto text-slate-500 hover:text-slate-300 hover:bg-transparent"
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

      {deleteConfirm ? (
        <div className="flex items-center gap-1 text-xs text-red-400">
          <span>Delete?</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={remove}
            disabled={isPending}
            className="px-2 py-0.5 h-auto bg-red-900/60 hover:bg-red-800 rounded text-red-300 disabled:opacity-50"
          >
            Yes
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDeleteConfirm(false)}
            className="px-2 py-0.5 h-auto bg-slate-700 hover:bg-slate-600 rounded text-slate-300"
          >
            No
          </Button>
        </div>
      ) : (
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsEditing(true)}
            className="p-1 h-auto w-auto text-slate-500 hover:text-cyan-400 hover:bg-transparent transition-colors"
            aria-label="Rename category"
          >
            <Pencil size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setDeleteConfirm(true)}
            className="p-1 h-auto w-auto text-slate-500 hover:text-red-400 hover:bg-transparent transition-colors"
            aria-label="Delete category"
          >
            <Trash2 size={16} />
          </Button>
        </div>
      )}
    </div>
  )
}
