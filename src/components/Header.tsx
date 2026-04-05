import { Link } from '@tanstack/react-router'
import { Route } from '../routes/__root'
import { BarChart3, Home, Menu, Settings, User2, List } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetClose,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'

const NAV_LINKS = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/analytics', icon: BarChart3, label: 'Analytics' },
  { to: '/transactions', icon: List, label: 'Transactions' },
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/profile', icon: User2, label: 'Profile' },
] as const

export default function Header() {
  const { auth } = Route.useRouteContext()
  const user = auth?.user

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
            <SheetContent
              side="left"
              className="w-80 flex flex-col p-0"
            >
              <SheetHeader className="p-6 border-b">
                <SheetTitle className="text-xl font-bold">
                  Navigation
                </SheetTitle>
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
            </SheetContent>
          </Sheet>
        ) : null}
        <h1 className="text-xl font-bold tracking-tight">
          <Link to="/" className="hover:text-primary transition-colors">MinimaSpend</Link>
        </h1>
      </div>
    </header>
  )
}
