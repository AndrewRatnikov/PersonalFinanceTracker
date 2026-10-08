// Optional Supabase account (spec §2.6). The app works without one; account
// UI shows only with ENABLE_ACCOUNTS or when a session already exists. The
// session is read locally from the browser client, never through the server.

import { useQuery } from '@tanstack/react-query'

import { ENABLE_ACCOUNTS } from './featureFlags'
import { createBrowserSupabaseClient } from './supabase'

export interface AccountSession {
  userId: string
  email: string | null
}

export const ACCOUNT_SESSION_QUERY_KEY = ['account-session'] as const

export async function getAccountSession(): Promise<AccountSession | null> {
  if (typeof window === 'undefined') return null
  try {
    const { data } = await createBrowserSupabaseClient().auth.getSession()
    const user = data.session?.user
    if (!user) return null
    return { userId: user.id, email: user.email ?? null }
  } catch {
    return null
  }
}

// Ends the Supabase session only. Local data on this device is untouched.
export async function signOutAccount(): Promise<void> {
  const { error } = await createBrowserSupabaseClient().auth.signOut()
  if (error) throw error
}

export function useAccountSession(): AccountSession | null {
  const { data } = useQuery({
    queryKey: ACCOUNT_SESSION_QUERY_KEY,
    queryFn: getAccountSession,
    staleTime: Infinity,
  })
  return data ?? null
}

export function useAccountsVisible(): boolean {
  const session = useAccountSession()
  return ENABLE_ACCOUNTS || session !== null
}
