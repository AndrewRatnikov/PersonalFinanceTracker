// The current member id: the Supabase user id of the signed-in account, or
// null while no account is linked. Read from the local session; never throws.
// accountSession is imported dynamically so localDb does not pull in the
// Supabase client at import time.

export async function getCurrentMemberId(): Promise<string | null> {
  try {
    const { getAccountSession } = await import('../accountSession')
    const session = await getAccountSession()
    const userId = session?.userId
    return typeof userId === 'string' && userId !== '' ? userId : null
  } catch {
    return null
  }
}

// The six colour tokens a member can get (theme variables, never raw hex).
export const MEMBER_COLORS: ReadonlyArray<string> = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--primary)',
]

const DISPLAY_NAME_MAX = 40

// The default display name of a member: the part of the email before the
// `@`, trimmed and cut to 40 characters; '' without an email.
export function defaultDisplayName(email: string | null | undefined): string {
  if (typeof email !== 'string' || email === '') return ''
  const at = email.indexOf('@')
  const local = at >= 0 ? email.slice(0, at) : email
  return local.trim().slice(0, DISPLAY_NAME_MAX)
}

// A stable colour for a member id: a string hash picks one of MEMBER_COLORS.
export function memberColor(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = (Math.imul(hash, 31) + userId.charCodeAt(i)) | 0
  }
  return MEMBER_COLORS[Math.abs(hash) % MEMBER_COLORS.length]
}
