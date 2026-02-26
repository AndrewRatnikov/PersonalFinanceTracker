import { createServerFn } from '@tanstack/react-start'

import type {
  Category,
  CreateCategoryInput,
  UpdateCategoryInput,
} from './domain'
import { getAuthenticatedClient } from './serverClient'

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export const getUserCategories = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Category[]> => {
    const { supabase, user } = await getAuthenticatedClient()

    const { data, error } = await supabase
      .from('categories')
      .select('id, name, icon')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })

    if (error) throw error

    return (data ?? []).map((row: any) => ({
      id: row.id,
      name: row.name,
      icon: row.icon ?? null,
    }))
  },
)

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export const createCategory = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown): CreateCategoryInput => {
    if (typeof input !== 'object' || input === null)
      throw new Error('Invalid payload')

    const { name, icon } = input as { name?: unknown; icon?: unknown }

    if (typeof name !== 'string' || !name.trim())
      throw new Error('Category name is required')
    if (name.trim().length > 40)
      throw new Error('Category name must be 40 characters or fewer')

    return {
      name: name.trim(),
      icon: typeof icon === 'string' && icon.trim() ? icon.trim() : null,
    }
  })
  .handler(async ({ data }): Promise<Category> => {
    const { supabase, user } = await getAuthenticatedClient()

    const { data: inserted, error } = await supabase
      .from('categories')
      .insert({ user_id: user.id, name: data.name, icon: data.icon })
      .select('id, name, icon')
      .single()

    if (error) throw error

    return { id: inserted.id, name: inserted.name, icon: inserted.icon ?? null }
  })

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export const updateCategory = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown): UpdateCategoryInput => {
    if (typeof input !== 'object' || input === null)
      throw new Error('Invalid payload')

    const { id, name, icon } = input as {
      id?: unknown
      name?: unknown
      icon?: unknown
    }

    if (typeof id !== 'string' || !id) throw new Error('id is required')
    if (typeof name !== 'string' || !name.trim())
      throw new Error('Category name is required')
    if (name.trim().length > 40)
      throw new Error('Category name must be 40 characters or fewer')

    return {
      id,
      name: name.trim(),
      icon: typeof icon === 'string' && icon.trim() ? icon.trim() : null,
    }
  })
  .handler(async ({ data }): Promise<Category> => {
    const { supabase, user } = await getAuthenticatedClient()

    const { data: updated, error } = await supabase
      .from('categories')
      .update({ name: data.name, icon: data.icon })
      .eq('id', data.id)
      .eq('user_id', user.id)
      .select('id, name, icon')
      .single()

    if (error) throw error

    return { id: updated.id, name: updated.name, icon: updated.icon ?? null }
  })

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export const deleteCategory = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown): string => {
    if (typeof input !== 'string' || !input) throw new Error('id is required')
    return input
  })
  .handler(async ({ data: id }): Promise<void> => {
    const { supabase, user } = await getAuthenticatedClient()

    // Guard: check for linked expenses before deleting
    const { count, error: countError } = await supabase
      .from('expenses')
      .select('id', { count: 'exact', head: true })
      .eq('category_id', id)
      .eq('user_id', user.id)

    if (countError) throw countError

    if ((count ?? 0) > 0) {
      throw new Error(
        `Cannot delete: ${count} expense${count === 1 ? '' : 's'} use this category. Reassign them first.`,
      )
    }

    const { error } = await supabase
      .from('categories')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)

    if (error) throw error
  })
