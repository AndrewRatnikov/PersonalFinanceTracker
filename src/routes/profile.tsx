import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Mail, User2 } from 'lucide-react'
import { toast } from 'sonner'

import type { UserProfile } from '@/lib/auth'
import { ACCOUNT_SESSION_QUERY_KEY, signOutAccount } from '@/lib/accountSession'
import { getServerUserProfile } from '@/lib/auth'
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
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [signingOut, setSigningOut] = useState(false)

  if (!user) return null

  // Ends the account session only; data on this device stays.
  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOutAccount()
      await queryClient.invalidateQueries({
        queryKey: ACCOUNT_SESSION_QUERY_KEY,
      })
      void navigate({ to: '/' })
    } catch (err) {
      console.error('Sign out failed:', err)
      toast.error('Could not sign out. Please try again.')
      setSigningOut(false)
    }
  }

  const fullName: string = user.full_name
  const email: string = user.email
  const avatarUrl: string | null = user.avatar_url

  return (
    <PageShell>
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          Profile
        </h1>

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
              data-testid="profile-sign-out-btn"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
              size="lg"
              className="w-full sm:w-auto px-8"
            >
              {signingOut && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Sign Out
            </Button>
          </CardContent>
        </Card>
      </div>
    </PageShell>
  )
}
