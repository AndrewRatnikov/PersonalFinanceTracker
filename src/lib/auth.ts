import { createServerFn } from '@tanstack/react-start'
import { getRequest, setCookie } from '@tanstack/react-start/server'
import { createServerSupabaseClient } from './supabase'

export const getServerUser = createServerFn({ method: 'GET' }).handler(
  async () => {
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

export const exchangeAuthCode = createServerFn({ method: 'POST' }).handler(
  async (ctx: any) => {
    const code = ctx.data as string
    const req = getRequest()
    if (!req) return null

    const supabase = createServerSupabaseClient(
      req.headers.get('cookie') ?? '',
      (name, value, options) => {
        setCookie(name, value, options as any)
      },
    )

    await supabase.auth.exchangeCodeForSession(code)
  },
)
