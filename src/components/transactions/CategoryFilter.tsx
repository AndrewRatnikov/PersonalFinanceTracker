import type { Category } from '@/lib/domain'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface CategoryFilterProps {
  categories: Category[]
  value: string | null
  onChange: (value: string) => void
}

export function CategoryFilter({
  categories,
  value,
  onChange,
}: CategoryFilterProps) {
  return (
    <div className="flex items-center gap-2">
      <Label
        htmlFor="category-filter"
        className="text-sm font-medium text-gray-600 dark:text-gray-300"
      >
        Category:
      </Label>
      <Select value={value || 'all'} onValueChange={onChange}>
        <SelectTrigger
          id="category-filter"
          className="bg-slate-900 dark:bg-gray-800 border-slate-700 dark:border-gray-700 text-white dark:text-gray-100 focus:ring-cyan-500 w-44"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="bg-slate-900 text-white">
          <SelectItem value="all">All Categories</SelectItem>
          {categories.map((cat) => (
            <SelectItem key={cat.id} value={cat.id}>
              {cat.icon} {cat.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
