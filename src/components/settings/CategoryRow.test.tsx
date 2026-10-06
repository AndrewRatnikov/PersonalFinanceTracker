// No CONTRACT_GAPs: CategoryRow props and testids (#9) are fully specified in
// the Interface Contract.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Category } from '@/lib/domain'
import { CategoryRow } from '@/components/settings/CategoryRow'

vi.mock('@/lib/localDb', () => ({
  deleteCategory: vi.fn(),
  updateCategory: vi.fn(),
}))

function openDeleteDialog(category: Category): string {
  render(
    <CategoryRow category={category} onMutate={vi.fn()} onError={vi.fn()} />,
  )
  fireEvent.click(screen.getByTestId('category-delete-btn'))
  return screen.getByTestId('category-delete-description').textContent ?? ''
}

describe('CategoryRow delete dialog copy (#9)', () => {
  it('says a category in use cannot be deleted and no longer promises uncategorized', () => {
    const text = openDeleteDialog({ id: 'c1', name: 'Food', icon: null })

    expect(text).toContain('cannot be deleted')
    expect(text.toLowerCase()).not.toContain('uncategorized')
  })

  it('names the category being deleted', () => {
    const text = openDeleteDialog({ id: 'c1', name: 'Groceries', icon: null })

    expect(text).toContain('Groceries')
    expect(text).not.toContain('Food')
  })
})
