import { Link } from '@tanstack/react-router'
import {
  BarChart3,
  Home,
  List,
  Menu,
  Repeat,
  Settings,
  TrendingUp,
  User2,
} from 'lucide-react'
import { BrandIcon } from './BrandIcon'
import { LanguageToggle } from './LanguageToggle'
import { LockButton } from './LockButton'
import { SyncIndicator } from './SyncIndicator'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { useAccountsVisible } from '@/lib/accountSession'
import { useSpaceSwitch } from '@/lib/spaces/switcher'
import { requestCreateVault, useVaultSession } from '@/lib/vaultSession'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { SpaceChip, SpaceSwitcher } from '@/components/space/SpaceSwitcher'

interface NavLink {
  to: '/' | '/analytics' | '/transactions' | '/income' | '/recurring' | '/settings'
  icon: typeof Home
  label: MessageKey
  testId?: string
}

const NAV_LINKS: ReadonlyArray<NavLink> = [
  { to: '/', icon: Home, label: 'nav.home' },
  { to: '/analytics', icon: BarChart3, label: 'nav.analytics' },
  { to: '/transactions', icon: List, label: 'nav.transactions' },
  { to: '/income', icon: TrendingUp, label: 'nav.income' },
  {
    to: '/recurring',
    icon: Repeat,
    label: 'nav.recurring',
    testId: 'nav-link-recurring',
  },
  { to: '/settings', icon: Settings, label: 'nav.settings' },
]

const HEADER_CLASS =
  'sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 shadow-sm'
// The Family accent comes from a theme token, never a literal colour.
const HEADER_FAMILY_CLASS = 'border-b-2 border-b-primary/60'

const NAV_LINK_CLASS =
  'flex items-center gap-3 p-3 rounded-md hover:bg-accent transition-colors text-foreground'
const NAV_LINK_ACTIVE_CLASS =
  'flex items-center gap-3 p-3 rounded-md bg-primary text-primary-foreground font-medium'

const MARKETING_LINKS: ReadonlyArray<{ hash: string; label: MessageKey }> = [
  { hash: 'features', label: 'nav.features' },
  { hash: 'privacy', label: 'nav.privacy' },
  { hash: 'pricing', label: 'nav.pricing' },
]

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
  const { phase } = useVaultSession()
  const accountsVisible = useAccountsVisible()
  const { t } = useT()
  const { family, isFamily } = useSpaceSwitch()

  if (phase !== 'unlocked') {
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
                {t(label)}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-3">
          <LanguageToggle testId="landing-language" />
          <div className="hidden md:flex items-center gap-3">
            {accountsVisible && (
              <Button asChild variant="outline" size="sm">
                <Link to="/login" data-testid="header-sign-in">
                  {t('nav.signIn')}
                </Link>
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              className="bg-[#6366f1] hover:bg-[#4f46e5] text-white border-0"
              data-testid="header-start-tracking"
              onClick={requestCreateVault}
            >
              {t('landing.startTracking')}
            </Button>
          </div>

          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden text-muted-foreground hover:bg-accent"
                aria-label={t('nav.openMenu')}
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
                      {t(label)}
                    </a>
                  </SheetClose>
                ))}
              </nav>

              <div className="mt-auto p-4 border-t flex flex-col gap-2">
                <SheetClose asChild>
                  <Button
                    type="button"
                    className="w-full bg-[#6366f1] hover:bg-[#4f46e5] text-white border-0"
                    onClick={requestCreateVault}
                  >
                    {t('landing.startTracking')}
                  </Button>
                </SheetClose>
                {accountsVisible && (
                  <SheetClose asChild>
                    <Button asChild variant="outline" className="w-full">
                      <Link to="/login">{t('nav.signIn')}</Link>
                    </Button>
                  </SheetClose>
                )}
              </div>
            </SheetContent>
          </Sheet>
          </div>
        </div>
      </header>
    )
  }

  // With no Family held the header is exactly today's (no attribute, no element).
  const spaceAttrs =
    family === null ? {} : { 'data-active-space': isFamily ? 'family' : 'personal' }

  return (
    <header
      className={isFamily ? `${HEADER_CLASS} ${HEADER_FAMILY_CLASS}` : HEADER_CLASS}
      {...spaceAttrs}
    >
      <div className="flex h-16 items-center px-4 md:px-8 max-w-6xl mx-auto">
        <Sheet>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="mr-2 h-9 w-9 text-muted-foreground hover:bg-accent"
              aria-label={t('nav.openMenu')}
              data-testid="header-menu-btn"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-80 flex flex-col p-0">
            <SheetHeader className="p-6 border-b">
              <SheetTitle className="text-xl font-bold">{t('nav.navigation')}</SheetTitle>
            </SheetHeader>

            <nav className="flex-1 p-4 overflow-y-auto flex flex-col gap-1">
              <SpaceSwitcher variant="nav" />
              {NAV_LINKS.map(({ to, icon: Icon, label, testId }) => (
                <SheetClose key={to} asChild>
                  <Link
                    to={to}
                    data-testid={testId}
                    className={NAV_LINK_CLASS}
                    activeProps={{ className: NAV_LINK_ACTIVE_CLASS }}
                  >
                    <Icon className="h-5 w-5" />
                    <span>{t(label)}</span>
                  </Link>
                </SheetClose>
              ))}
              {accountsVisible && (
                <SheetClose asChild>
                  <Link
                    to="/profile"
                    data-testid="nav-link-profile"
                    className={NAV_LINK_CLASS}
                    activeProps={{ className: NAV_LINK_ACTIVE_CLASS }}
                  >
                    <User2 className="h-5 w-5" />
                    <span>{t('nav.profile')}</span>
                  </Link>
                </SheetClose>
              )}
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
        <div className="ml-auto flex items-center gap-1">
          <SpaceChip />
          <SpaceSwitcher variant="header" />
          <SyncIndicator />
          <LockButton />
        </div>
      </div>
    </header>
  )
}
