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
