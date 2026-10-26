// Build-time feature flags. This is the only place the env flags are read.

// Account UI (sign in, Profile, Settings → Account) is hidden by default. An
// existing Supabase session still shows it (see accountSession.ts).
export const ENABLE_ACCOUNTS: boolean =
  import.meta.env.VITE_ENABLE_ACCOUNTS === 'true'

// Encrypted sync across devices (spec §19). Off by default; the sync UI and the
// engine run only when this is on AND accounts are visible.
export const ENABLE_SYNC: boolean = import.meta.env.VITE_ENABLE_SYNC === 'true'
