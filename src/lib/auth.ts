import { createServerFn } from '@tanstack/react-start'
import { getRequest, setCookie } from '@tanstack/react-start/server'
import { createServerSupabaseClient } from './supabase'
import type { User } from '@supabase/supabase-js'

export const getServerUser = createServerFn({ method: 'GET' }).handler(
  async (): Promise<User | null> => {
    const req = getRequest()

    const supabase = createServerSupabaseClient(
      req.headers.get('cookie') ?? '',
      (name, value, options) => {
        setCookie(name, value, options)
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

    const supabase = createServerSupabaseClient(
      req.headers.get('cookie') ?? '',
      (name, value, options) => {
        setCookie(name, value, options)
      },
    )

    await supabase.auth.exchangeCodeForSession(data.code)
  })
