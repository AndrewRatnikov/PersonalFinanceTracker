import { createServerFn } from '@tanstack/react-start'

import type { Category } from './domain'
import { getAuthenticatedClient } from './serverClient'

export const getUserCategories = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Category[]> => {
    const { supabase, user } = await getAuthenticatedClient()

    const { data, error } = await supabase
      .from('categories')
      .select('id, name, icon')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })

    if (error) {
      throw error
    }

    return (data ?? []).map((row: any) => ({
      id: row.id,
      name: row.name,
      icon: row.icon ?? null,
    }))
  },
)

