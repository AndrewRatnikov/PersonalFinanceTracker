import React from 'react'
import type { Category } from '@/lib/domain'

interface CategoryFilterProps {
  categories: Category[]
  value: string | null
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
}

export function CategoryFilter({
  categories,
  value,
  onChange,
}: CategoryFilterProps) {
  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor="category-filter"
        className="text-sm font-medium text-gray-600 dark:text-gray-300"
      >
        Category:
      </label>
      <select
        id="category-filter"
        value={value || 'all'}
        onChange={onChange}
        className="p-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 outline-none transition-shadow text-gray-900 dark:text-gray-100"
      >
        <option value="all">All Categories</option>
        {categories.map((cat) => (
          <option key={cat.id} value={cat.id}>
            {cat.icon} {cat.name}
          </option>
        ))}
      </select>
    </div>
  )
}
