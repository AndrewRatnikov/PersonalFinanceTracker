'use server'

import { getRequest, setCookie } from '@tanstack/react-start/server'
import type { SupabaseClient, User } from '@supabase/supabase-js'

import { createServerSupabaseClient } from './supabase'

export interface AuthenticatedClient {
  supabase: SupabaseClient
  user: User
}

/**
 * Helper to get the authenticated Supabase client in a Server Function.
 */
export const getAuthenticatedClient =
  async (): Promise<AuthenticatedClient> => {
    const req = getRequest()
    if (!req) {
      throw new Error('No request context found')
    }

    const supabase = createServerSupabaseClient(
      req.headers.get('cookie') ?? '',
      (name, value, options) => {
        setCookie(name, value, options as any)
      },
    )

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      throw new Error('Unauthorized')
    }

    return { supabase, user }
  }
