import { Link } from '@tanstack/react-router'
import PageShell from './PageShell'
import { useT } from '@/i18n'
import { Button } from '@/components/ui/button'

export default function NotFoundPage() {
  const { t } = useT()
  return (
    <PageShell>
      <div className="flex flex-col items-center justify-center py-20 text-center gap-6">
        <h1 className="text-4xl font-bold">{t('common.notFound.title')}</h1>
        <p className="text-muted-foreground">{t('common.notFound.body')}</p>
        <Button asChild size="lg" className="mt-4">
          <Link to="/">{t('common.notFound.goHome')}</Link>
        </Button>
      </div>
    </PageShell>
  )
}
