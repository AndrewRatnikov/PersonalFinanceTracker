import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { BarChart3, Home, LogOut, Menu, Settings, TrendingUp, User2, List } from 'lucide-react'
import { toast } from 'sonner'
import { Route } from '../routes/__root'
import { BrandIcon } from './BrandIcon'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetClose,
} from '@/components/ui/sheet'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { createBrowserSupabaseClient } from '@/lib/supabase'
import { clearLocalDb, wipeLocalDbKey } from '@/lib/localDb'
import { exportAllLocalData } from '@/lib/localExport'

const NAV_LINKS = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/analytics', icon: BarChart3, label: 'Analytics' },
  { to: '/transactions', icon: List, label: 'Transactions' },
  { to: '/income', icon: TrendingUp, label: 'Income' },
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/profile', icon: User2, label: 'Profile' },
] as const

const OFFLINE_USER_KEY = 'minima_offline_user'

export default function Header() {
  const { auth } = Route.useRouteContext()
  const user = auth?.user
  const navigate = useNavigate()
  const [exporting, setExporting] = useState(false)

  const handleExport = async () => {
    setExporting(true)
    try {
      await exportAllLocalData()
    } catch {
      toast.error('Export failed')
    } finally {
      setExporting(false)
    }
  }

  const handleSignOut = async () => {
    wipeLocalDbKey()
    await clearLocalDb()

    if (user) {
      localStorage.removeItem(`minima_migrated_${user.id}`)
    }
    localStorage.removeItem(OFFLINE_USER_KEY)

    const supabase = createBrowserSupabaseClient()
    await supabase.auth.signOut()

    navigate({ to: '/login' })
  }

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 shadow-sm">
      <div className="flex h-16 items-center px-4 md:px-8 max-w-6xl mx-auto">
        {user ? (
          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="mr-2 h-9 w-9 text-muted-foreground hover:bg-accent"
                aria-label="Open menu"
              >
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-80 flex flex-col p-0">
              <SheetHeader className="p-6 border-b">
                <SheetTitle className="text-xl font-bold">Navigation</SheetTitle>
              </SheetHeader>

              <nav className="flex-1 p-4 overflow-y-auto flex flex-col gap-1">
                {NAV_LINKS.map(({ to, icon: Icon, label }) => (
                  <SheetClose key={to} asChild>
                    <Link
                      to={to}
                      className="flex items-center gap-3 p-3 rounded-md hover:bg-accent transition-colors text-foreground"
                      activeProps={{
                        className:
                          'flex items-center gap-3 p-3 rounded-md bg-primary text-primary-foreground font-medium',
                      }}
                    >
                      <Icon className="h-5 w-5" />
                      <span>{label}</span>
                    </Link>
                  </SheetClose>
                ))}
              </nav>

              <div className="p-4 border-t">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      className="w-full justify-start gap-3 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    >
                      <LogOut className="h-5 w-5" />
                      Sign out
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Sign out?</AlertDialogTitle>
                      <AlertDialogDescription>
                        All locally stored data — expenses, categories, income, and budgets — will
                        be permanently deleted from this device. Export your data first if you want
                        to keep a copy.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter className="flex-col sm:flex-row gap-2">
                      <Button
                        variant="outline"
                        className="sm:mr-auto"
                        onClick={handleExport}
                        disabled={exporting}
                      >
                        {exporting ? 'Exporting…' : 'Export my data'}
                      </Button>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={handleSignOut}
                      >
                        Sign out &amp; delete data
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </SheetContent>
          </Sheet>
        ) : null}
        <h1 className="text-xl font-bold tracking-tight">
          <Link to="/" className="flex items-center gap-2 hover:text-primary transition-colors">
            <BrandIcon size={22} />
            MinimaSpend
          </Link>
        </h1>
      </div>
    </header>
  )
}
