import { createServerFn } from '@tanstack/react-start'
import { getRequest, setCookie } from '@tanstack/react-start/server'
import type { User } from '@supabase/supabase-js'

import { createServerSupabaseClient } from './supabase'

export const getServerUser = createServerFn({ method: 'GET' }).handler(
  async (): Promise<User | null> => {
    const req = getRequest()
    if (!req) return null

    const supabase = createServerSupabaseClient(
      req.headers.get('cookie') ?? '',
      (name, value, options) => {
        setCookie(name, value, options as any)
      },
    )
    const {
      data: { user },
    } = await supabase.auth.getUser()
    return user
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
    const req = getRequest()
    if (!req) return

    const supabase = createServerSupabaseClient(
      req.headers.get('cookie') ?? '',
      (name, value, options) => {
        setCookie(name, value, options as any)
      },
    )

    await supabase.auth.exchangeCodeForSession(data.code)
  })
