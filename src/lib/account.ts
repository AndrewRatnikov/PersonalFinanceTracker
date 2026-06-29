import { createBrowserSupabaseClient } from './supabase'

export async function deleteCurrentUserAccount(): Promise<void> {
  const supabase = createBrowserSupabaseClient()

  const { error } = await supabase.rpc('delete_own_account')

  if (error) {
    throw new Error(error.message)
  }
}
