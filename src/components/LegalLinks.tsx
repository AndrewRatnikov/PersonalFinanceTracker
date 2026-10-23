import { Link } from '@tanstack/react-router'

import { useT } from '@/i18n'
import { cn } from '@/lib/utils'

// "Terms of Use · Privacy Policy": shown on the landing footer, under the
// legal pages and in Settings → Account. Both pages are public.
export function LegalLinks({ className }: { className?: string }) {
  const { t } = useT()
  return (
    <nav
      data-testid="legal-links"
      className={cn(
        'flex flex-wrap items-center gap-2 text-sm text-muted-foreground',
        className,
      )}
    >
      <Link
        to="/terms"
        data-testid="legal-terms-link"
        className="underline-offset-4 hover:text-foreground hover:underline"
      >
        {t('legal.terms')}
      </Link>
      <span aria-hidden="true">·</span>
      <Link
        to="/privacy"
        data-testid="legal-privacy-link"
        className="underline-offset-4 hover:text-foreground hover:underline"
      >
        {t('legal.privacy')}
      </Link>
    </nav>
  )
}
