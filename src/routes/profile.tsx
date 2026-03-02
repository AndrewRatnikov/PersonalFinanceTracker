import { createFileRoute, useRouter } from '@tanstack/react-router'
import { LogOut, Mail, User2 } from 'lucide-react'

import { getServerUser } from '../lib/auth'
import { createBrowserSupabaseClient } from '../lib/supabase'
import PageShell from '../components/PageShell'
import type { User } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/profile')({
  loader: async (): Promise<User | null> => {
    return getServerUser()
  },
  component: ProfilePage,
})

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ProfilePage() {
  const user = Route.useLoaderData()
  const router = useRouter()

  const handleSignOut = async () => {
    const supabase = createBrowserSupabaseClient()
    await supabase.auth.signOut()
    router.navigate({ to: '/login' })
  }

  if (!user) return null

  const fullName: string = user.user_metadata?.full_name ?? 'Anonymous'
  const email: string = user.email ?? ''
  const avatarUrl: string | undefined = user.user_metadata?.avatar_url

  return (
    <PageShell>
      <h1 className="text-2xl font-bold text-white">Profile</h1>

      <div className="flex flex-col items-center gap-6 py-8">
        {/* Avatar */}
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={`${fullName}'s avatar`}
            className="w-24 h-24 rounded-full border-4 border-cyan-500 shadow-lg object-cover"
          />
        ) : (
          <div className="w-24 h-24 rounded-full border-4 border-cyan-500 bg-slate-700 flex items-center justify-center">
            <User2 size={40} className="text-slate-400" />
          </div>
        )}

        {/* Info */}
        <div className="text-center">
          <p className="text-2xl font-semibold text-white">{fullName}</p>
          <p className="flex items-center gap-1.5 mt-1 text-slate-400 text-sm justify-center">
            <Mail size={14} />
            {email}
          </p>
        </div>

        {/* Sign out */}
        <button
          onClick={handleSignOut}
          className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-red-600/20 hover:bg-red-600/40 border border-red-500/40 text-red-400 font-medium transition-colors"
        >
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </PageShell>
  )
}
