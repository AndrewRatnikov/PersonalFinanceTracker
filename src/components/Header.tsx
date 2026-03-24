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
    <header className="p-4 flex items-center bg-gray-800 text-white shadow-lg">
      {user ? (
        <Sheet>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-white hover:bg-gray-700 hover:text-white"
              aria-label="Open menu"
            >
              <Menu size={24} />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-80 bg-gray-900 text-white border-gray-700 p-0 flex flex-col"
          >
            <SheetHeader className="p-4 border-b border-gray-700">
              <SheetTitle className="text-white text-xl font-bold">
                Navigation
              </SheetTitle>
            </SheetHeader>

            <nav className="flex-1 p-4 overflow-y-auto flex flex-col gap-1">
              {NAV_LINKS.map(({ to, icon: Icon, label }) => (
                <SheetClose key={to} asChild>
                  <Link
                    to={to}
                    className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-800 transition-colors text-white"
                    activeProps={{
                      className:
                        'flex items-center gap-3 p-3 rounded-lg bg-cyan-600 hover:bg-cyan-700 transition-colors text-white',
                    }}
                  >
                    <Icon size={20} />
                    <span className="font-medium">{label}</span>
                  </Link>
                </SheetClose>
              ))}
            </nav>
          </SheetContent>
        </Sheet>
      ) : null}
      <h1 className="ml-4 text-xl font-semibold">
        <Link to="/">MinimaSpend</Link>
      </h1>
    </header>
  )
}
