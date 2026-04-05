import { createFileRoute, useRouter } from '@tanstack/react-router'
import { LogOut, Mail, User2 } from 'lucide-react'

import { getServerUserProfile } from '@/lib/auth'
import type { UserProfile } from '@/lib/auth'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import PageShell from '@/components/PageShell'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export const Route = createFileRoute('/profile')({
  loader: async (): Promise<UserProfile | null> => {
    return getServerUserProfile()
  },
  component: ProfilePage,
})

function ProfilePage() {
  const user = Route.useLoaderData()
  const router = useRouter()

  const handleSignOut = async () => {
    const supabase = createBrowserSupabaseClient()
    await supabase.auth.signOut()
    router.navigate({ to: '/login' })
  }

  if (!user) return null

  const fullName: string = user.full_name
  const email: string = user.email
  const avatarUrl: string | null = user.avatar_url

  return (
    <PageShell>
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Profile</h1>

        <Card className="overflow-hidden">
          <CardContent className="flex flex-col items-center gap-8 py-12">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={`${fullName}'s avatar`}
                className="w-24 h-24 rounded-full border-4 border-muted shadow-sm object-cover"
              />
            ) : (
              <div className="flex h-24 w-24 items-center justify-center rounded-full bg-muted">
                <User2 className="h-12 w-12 text-muted-foreground" />
              </div>
            )}

            <div className="text-center space-y-1.5">
              <p className="text-2xl font-bold">{fullName}</p>
              <div className="flex items-center justify-center gap-2 text-muted-foreground">
                <Mail className="h-4 w-4" />
                <span className="text-sm font-medium">{email}</span>
              </div>
            </div>

            <Button
              variant="destructive"
              onClick={handleSignOut}
              size="lg"
              className="w-full sm:w-auto px-8"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Sign Out
            </Button>
          </CardContent>
        </Card>
      </div>
    </PageShell>
  )
}
