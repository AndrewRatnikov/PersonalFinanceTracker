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
    <div className="flex items-center gap-3">
      <Label
        htmlFor="category-filter"
        className="text-sm font-medium text-muted-foreground whitespace-nowrap"
      >
        Filter by:
      </Label>
      <Select value={value || 'all'} onValueChange={onChange}>
        <SelectTrigger
          id="category-filter"
          className="w-[180px] h-9"
        >
          <SelectValue placeholder="All Categories" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Categories</SelectItem>
          {categories.map((cat) => (
            <SelectItem key={cat.id} value={cat.id}>
              <div className="flex items-center gap-2">
                {cat.icon && <span className="w-4 text-center">{cat.icon}</span>}
                <span>{cat.name}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
