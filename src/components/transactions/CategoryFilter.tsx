import type { Category } from '@/lib/domain'
import { useT } from '@/i18n'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface CategoryFilterProps {
  categories: Array<Category>
  value: string | null
  onChange: (value: string) => void
}

export function CategoryFilter({
  categories,
  value,
  onChange,
}: CategoryFilterProps) {
  const { t } = useT()
  return (
    <div className="flex items-center gap-3">
      <Label
        htmlFor="category-filter"
        className="text-sm font-medium text-muted-foreground whitespace-nowrap"
      >
        {t('transactions.filterBy')}
      </Label>
      <Select value={value || 'all'} onValueChange={onChange}>
        <SelectTrigger id="category-filter" className="w-[180px] h-9">
          <SelectValue placeholder={t('transactions.allCategories')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('transactions.allCategories')}</SelectItem>
          {categories.map((cat) => (
            <SelectItem key={cat.id} value={cat.id}>
              <div className="flex items-center gap-2">
                {cat.icon && (
                  <span className="w-4 text-center">{cat.icon}</span>
                )}
                <span>{cat.name}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
