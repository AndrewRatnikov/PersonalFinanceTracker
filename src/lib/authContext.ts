import type { User } from '@supabase/supabase-js'

export interface AuthContext {
  auth: {
    user: User | null
    isLoading: boolean
  }
}

