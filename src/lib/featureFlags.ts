// Build-time feature flags. This is the only place the env flag is read.

// Account UI (sign in, Profile, Settings → Account) is hidden by default. An
// existing Supabase session still shows it (see accountSession.ts).
export const ENABLE_ACCOUNTS: boolean =
  import.meta.env.VITE_ENABLE_ACCOUNTS === 'true'
