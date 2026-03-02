import { createServerFn } from '@tanstack/react-start'
import { getRequest, setCookie } from '@tanstack/react-start/server'
import { createServerSupabaseClient } from './supabase'
import type { User } from '@supabase/supabase-js'

export interface UserProfile {
  full_name: string
  email: string
  avatar_url: string | null
}

// ---------------------------------------------------------------------------
// Private helpers (not server functions — no network hop)
// ---------------------------------------------------------------------------

function getAuthenticatedClient() {
  const req = getRequest()
  return createServerSupabaseClient(
    req.headers.get('cookie') ?? '',
    (name, value, options) => setCookie(name, value, options),
  )
}

async function getAuthenticatedUser(): Promise<User | null> {
  const {
    data: { user },
  } = await getAuthenticatedClient().auth.getUser()
  return user
}

// ---------------------------------------------------------------------------
// Server Functions
// ---------------------------------------------------------------------------

export const getServerUser = createServerFn({ method: 'GET' }).handler(
  (): Promise<User | null> => getAuthenticatedUser(),
)

export const getServerUserProfile = createServerFn({ method: 'GET' }).handler(
  async (): Promise<UserProfile | null> => {
    const user = await getAuthenticatedUser()
    if (!user) return null
    return {
      full_name: user.user_metadata?.full_name ?? '',
      email: user.email ?? '',
      avatar_url: user.user_metadata?.avatar_url ?? null,
    }
  },
)

interface ExchangeAuthCodeInput {
  code: string
}

export const exchangeAuthCode = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown): ExchangeAuthCodeInput => {
    if (typeof input !== 'object' || input === null) {
      throw new Error('Invalid auth payload')
    }

    const { code } = input as { code?: unknown }

    if (typeof code !== 'string' || !code) {
      throw new Error('Missing authorization code')
    }

    return { code }
  })
  .handler(async ({ data }): Promise<void> => {
    await getAuthenticatedClient().auth.exchangeCodeForSession(data.code)
  })
