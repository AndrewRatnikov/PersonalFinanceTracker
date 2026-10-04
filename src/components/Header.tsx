import { Link } from '@tanstack/react-router'
import {
  BarChart3,
  Home,
  List,
  Menu,
  Settings,
  TrendingUp,
  User2,
} from 'lucide-react'
import { Route } from '../routes/__root'
import { BrandIcon } from './BrandIcon'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'

const NAV_LINKS = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/analytics', icon: BarChart3, label: 'Analytics' },
  { to: '/transactions', icon: List, label: 'Transactions' },
  { to: '/income', icon: TrendingUp, label: 'Income' },
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/profile', icon: User2, label: 'Profile' },
] as const

const MARKETING_LINKS = [
  { hash: 'features', label: 'Features' },
  { hash: 'privacy', label: 'Privacy' },
  { hash: 'pricing', label: 'Pricing' },
] as const

function scrollToHash(hash: string) {
  return (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (window.location.pathname !== '/') return
    const el = document.getElementById(hash)
    if (!el) return
    e.preventDefault()
    e.stopPropagation()
    el.scrollIntoView({ behavior: 'smooth' })
  }
}

export default function Header() {
  const { auth } = Route.useRouteContext()
  const user = auth.user

  if (!user) {
    return (
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 shadow-sm">
        <div className="flex h-16 items-center justify-between px-4 md:px-8 max-w-6xl mx-auto">
          <Link
            to="/"
            className="flex items-center gap-2 text-xl font-bold tracking-tight hover:text-primary transition-colors"
          >
            <BrandIcon size={22} />
            MinimaSpend
          </Link>

          <nav className="hidden md:flex items-center gap-6">
            {MARKETING_LINKS.map(({ hash, label }) => (
              <a
                key={hash}
                href={`/#${hash}`}
                onClick={scrollToHash(hash)}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {label}
              </a>
            ))}
          </nav>

          <div className="hidden md:flex items-center gap-3">
            <Button asChild variant="outline" size="sm">
              <Link to="/login">Sign in</Link>
            </Button>
            <Button
              asChild
              size="sm"
              className="bg-[#6366f1] hover:bg-[#4f46e5] text-white border-0"
            >
              <Link to="/login">Get started</Link>
            </Button>
          </div>

          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden text-muted-foreground hover:bg-accent"
                aria-label="Open menu"
              >
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-80 flex flex-col p-0">
              <SheetHeader className="p-6 border-b">
                <SheetTitle className="text-lg font-bold flex items-center gap-2">
                  <BrandIcon size={20} />
                  MinimaSpend
                </SheetTitle>
              </SheetHeader>

              <nav className="flex flex-col gap-1 p-4">
                {MARKETING_LINKS.map(({ hash, label }) => (
                  <SheetClose key={hash} asChild>
                    <a
                      href={`/#${hash}`}
                      onClick={scrollToHash(hash)}
                      className="p-3 rounded-md hover:bg-accent transition-colors text-foreground"
                    >
                      {label}
                    </a>
                  </SheetClose>
                ))}
              </nav>

              <div className="mt-auto p-4 border-t flex flex-col gap-2">
                <SheetClose asChild>
                  <Button
                    asChild
                    className="w-full bg-[#6366f1] hover:bg-[#4f46e5] text-white border-0"
                  >
                    <Link to="/login">Get started free</Link>
                  </Button>
                </SheetClose>
                <SheetClose asChild>
                  <Button asChild variant="outline" className="w-full">
                    <Link to="/login">Sign in</Link>
                  </Button>
                </SheetClose>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </header>
    )
  }

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 shadow-sm">
      <div className="flex h-16 items-center px-4 md:px-8 max-w-6xl mx-auto">
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
          </SheetContent>
        </Sheet>
        <h1 className="text-xl font-bold tracking-tight">
          <Link
            to="/"
            className="flex items-center gap-2 hover:text-primary transition-colors"
          >
            <BrandIcon size={22} />
            MinimaSpend
          </Link>
        </h1>
      </div>
    </header>
  )
}
