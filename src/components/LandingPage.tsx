import { useState } from 'react'
import {
  Check,
  Download,
  Globe,
  Lock,
  PieChart,
  Wifi,
  X,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import type { RestoreSummary } from '@/lib/backup'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { formatRestoreSummary } from '@/lib/backup'
import { ENABLE_SPACES } from '@/lib/featureFlags'
import { requestCreateVault, setVaultPhase } from '@/lib/vaultSession'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { RestoreBackupDialog } from '@/components/RestoreBackupDialog'
import { LegalLinks } from '@/components/LegalLinks'
import { SyncAvailable } from '@/components/SyncAvailable'

const PROBLEMS: ReadonlyArray<{ title: MessageKey; body: MessageKey }> = [
  { title: 'landing.problems.credentials.title', body: 'landing.problems.credentials.body' },
  { title: 'landing.problems.servers.title', body: 'landing.problems.servers.body' },
  { title: 'landing.problems.business.title', body: 'landing.problems.business.body' },
]

const ENCRYPTION_STEPS: ReadonlyArray<{ n: string; title: MessageKey; body: MessageKey }> = [
  { n: '01', title: 'landing.encryption.step1.title', body: 'landing.encryption.step1.body' },
  { n: '02', title: 'landing.encryption.step2.title', body: 'landing.encryption.step2.body' },
  { n: '03', title: 'landing.encryption.step3.title', body: 'landing.encryption.step3.body' },
  { n: '04', title: 'landing.encryption.step4.title', body: 'landing.encryption.step4.body' },
]

const PRIVACY_BULLETS: ReadonlyArray<MessageKey> = [
  'landing.privacy.bullet1',
  'landing.privacy.bullet2',
  'landing.privacy.bullet3',
  'landing.privacy.bullet4',
]

const FEATURES: ReadonlyArray<{ icon: typeof Zap; title: MessageKey; body: MessageKey }> = [
  { icon: Zap, title: 'landing.features.quickAdd.title', body: 'landing.features.quickAdd.body' },
  { icon: PieChart, title: 'landing.features.analytics.title', body: 'landing.features.analytics.body' },
  { icon: PieChart, title: 'landing.features.budgets.title', body: 'landing.features.budgets.body' },
  { icon: Globe, title: 'landing.features.currency.title', body: 'landing.features.currency.body' },
  { icon: Download, title: 'landing.features.csv.title', body: 'landing.features.csv.body' },
  { icon: Wifi, title: 'landing.features.offline.title', body: 'landing.features.offline.body' },
  { icon: PieChart, title: 'landing.features.categories.title', body: 'landing.features.categories.body' },
  { icon: Globe, title: 'landing.features.income.title', body: 'landing.features.income.body' },
]

const PRICING_ITEMS: ReadonlyArray<MessageKey> = [
  'landing.pricing.item1',
  'landing.pricing.item2',
  'landing.pricing.item3',
  'landing.pricing.item4',
  'landing.pricing.item5',
  'landing.pricing.item6',
]

const PORTABILITY_FILES: ReadonlyArray<MessageKey> = [
  'landing.portability.expensesCsv',
  'landing.portability.incomeCsv',
  'landing.portability.budgetsCsv',
  'landing.portability.categoriesCsv',
]

// A sample CSV file. The header row is the real (untranslated) format; the
// sample rows hold example user data, so they follow the UI language.
const CSV_HEADER = 'date,amount,currency,category,description'
const CSV_PREVIEW_ROWS: ReadonlyArray<MessageKey> = [
  'landing.csvPreview.row1',
  'landing.csvPreview.row2',
  'landing.csvPreview.row3',
  'landing.csvPreview.row4',
  'landing.csvPreview.row5',
  'landing.csvPreview.row6',
]

const PREVIEW_RECENT: ReadonlyArray<{
  label: MessageKey
  time: MessageKey
  amount: MessageKey
  positive?: boolean
}> = [
  { label: 'landing.preview.coffee', time: 'landing.preview.minutesAgo', amount: 'landing.preview.amountCoffee' },
  { label: 'landing.preview.serverCosts', time: 'landing.preview.hourAgo', amount: 'landing.preview.amountServer' },
  {
    label: 'landing.preview.freelance',
    time: 'landing.preview.threeHoursAgo',
    amount: 'landing.preview.amountFreelance',
    positive: true,
  },
  { label: 'landing.preview.transport', time: 'landing.preview.fiveHoursAgo', amount: 'landing.preview.amountTransport' },
]

// Opens the create-vault flow (spec §2.2); no account is needed.
function StartTrackingButton({
  className,
  children,
  testId,
}: {
  className?: string
  children: React.ReactNode
  testId?: string
}) {
  return (
    <Button
      type="button"
      size="lg"
      className={`bg-[#6366f1] hover:bg-[#4f46e5] text-white border-0 gap-2 ${className ?? ''}`}
      data-testid={testId}
      onClick={requestCreateVault}
    >
      {children}
    </Button>
  )
}

function DashboardPreview() {
  const { t } = useT()
  return (
    <Card className="ring-foreground/10 bg-card/60 backdrop-blur-sm py-0 overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
        <span className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-500/80" />
        <span className="ml-2 text-xs text-muted-foreground">MinimaSpend</span>
      </div>

      <div className="flex flex-col gap-5 px-5 py-5">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-border p-3">
            <p className="text-[11px] text-muted-foreground">{t('landing.preview.income')}</p>
            <p className="text-lg font-bold tabular-nums">{t('landing.preview.amountIncome')}</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-[11px] text-muted-foreground">{t('landing.preview.expenses')}</p>
            <p className="text-lg font-bold tabular-nums">{t('landing.preview.amountExpenses')}</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-[11px] text-muted-foreground">{t('landing.preview.balance')}</p>
            <p className="text-lg font-bold tabular-nums">{t('landing.preview.amountBalance')}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-border p-3">
            <p className="text-[11px] text-muted-foreground mb-2">
              {t('landing.preview.twelveMonths')}
            </p>
            <div className="flex items-end gap-1 h-14">
              {[40, 55, 45, 65, 50, 60, 70, 58, 48, 62, 52, 100].map((h, i) => (
                <div
                  key={i}
                  className={`flex-1 rounded-t-sm ${i === 11 ? 'bg-[#6366f1]' : 'bg-muted-foreground/30'}`}
                  style={{ height: `${h}%` }}
                />
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-[11px] text-muted-foreground mb-2">
              {t('landing.preview.byCategory')}
            </p>
            <div className="flex flex-col gap-1.5">
              {[
                { pct: 32, color: 'bg-[#6366f1]' },
                { pct: 18, color: 'bg-purple-400' },
                { pct: 28, color: 'bg-cyan-400' },
                { pct: 22, color: 'bg-emerald-400' },
              ].map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full ${row.color}`}
                      style={{ width: `${row.pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground w-7 text-right">
                    {row.pct}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border p-3">
          <p className="text-[11px] text-muted-foreground mb-2">{t('landing.preview.quickAdd')}</p>
          <div className="flex items-center gap-2">
            <div className="flex-1 rounded-md border border-input px-3 py-2 text-sm font-semibold">
              {t('landing.preview.amountQuickAdd')}
            </div>
            <div className="rounded-md border border-input px-3 py-2 text-xs text-muted-foreground">
              {t('landing.preview.coffee')}
            </div>
            <Button
              size="sm"
              className="bg-[#6366f1] hover:bg-[#4f46e5] text-white border-0"
            >
              {t('common.add')}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-border p-3">
          <p className="text-[11px] text-muted-foreground mb-2">{t('landing.preview.recent')}</p>
          <div className="flex flex-col gap-2.5 text-sm">
            {PREVIEW_RECENT.map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between"
              >
                <div>
                  <p className="font-medium">{t(row.label)}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {t(row.time)}
                  </p>
                </div>
                <span
                  className={
                    row.positive
                      ? 'text-emerald-500 font-medium'
                      : 'font-medium'
                  }
                >
                  {t(row.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  )
}

export default function LandingPage() {
  const [restoreOpen, setRestoreOpen] = useState(false)
  const { t } = useT()

  // A fresh-device restore adopted the backup's vault and unlocked it.
  const handleRestored = (summary: RestoreSummary) => {
    setVaultPhase('unlocked')
    toast.success(formatRestoreSummary(summary))
  }

  return (
    <div className="bg-background text-foreground" data-testid="landing-page">
      {/* Hero */}
      <section className="max-w-6xl mx-auto px-4 md:px-8 pt-16 pb-20 grid md:grid-cols-2 gap-12 items-center">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground mb-6">
            <Lock className="h-3 w-3" />
            {t('landing.badge')}
          </div>

          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-[1.1] mb-6">
            {t('landing.heroTitle')}
            <br />
            <span className="text-[#6366f1]">{t('landing.heroAccent')}</span>
          </h1>

          <p className="text-lg text-muted-foreground mb-8 max-w-md">
            {t('landing.heroBody')}
          </p>

          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <StartTrackingButton testId="landing-start-tracking">
              {t('landing.startTracking')}
            </StartTrackingButton>
            <Button
              type="button"
              variant="outline"
              size="lg"
              data-testid="landing-restore-backup"
              onClick={() => setRestoreOpen(true)}
            >
              {t('backup.restoreFromBackup')}
            </Button>
          </div>
          <div className="mb-4">
            <Button asChild variant="link" size="sm" className="px-0">
              <a
                href="/#features"
                onClick={(e) => {
                  const el = document.getElementById('features')
                  if (!el) return
                  e.preventDefault()
                  e.stopPropagation()
                  el.scrollIntoView({ behavior: 'smooth' })
                }}
              >
                {t('landing.seeHowItWorks')}
              </a>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('landing.heroFootnote')}
          </p>
          <RestoreBackupDialog
            open={restoreOpen}
            onOpenChange={setRestoreOpen}
            freshDevice
            onRestored={handleRestored}
          />
        </div>

        <DashboardPreview />
      </section>

      {/* Problem */}
      <section className="border-t border-border">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-20">
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase mb-3">
            {t('landing.problems.eyebrow')}
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6 max-w-2xl">
            {t('landing.problems.title')}
          </h2>
          <p className="text-muted-foreground max-w-2xl mb-10">{t('landing.problems.body')}</p>

          <div className="grid sm:grid-cols-3 gap-4">
            {PROBLEMS.map((p) => (
              <Card
                key={p.title}
                className="gap-3 bg-destructive/5 ring-destructive/20"
              >
                <div className="px-6 flex flex-col gap-3">
                  <div className="flex items-center justify-center h-7 w-7 shrink-0 rounded-full bg-destructive/10">
                    <X className="h-4 w-4 text-destructive" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <h3 className="font-semibold">{t(p.title)}</h3>
                    <p className="text-sm text-muted-foreground">{t(p.body)}</p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Privacy / Encryption */}
      <section id="privacy" className="border-t border-border scroll-mt-16">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-20 grid md:grid-cols-2 gap-12 items-center">
          <Card className="bg-card/50 backdrop-blur-sm">
            <div className="px-6 flex flex-col gap-4">
              <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-[#6366f1]/10">
                <Lock className="h-5 w-5 text-[#6366f1]" />
              </div>
              <h3 className="text-lg font-semibold">{t('landing.encryption.title')}</h3>
              <p className="text-sm text-muted-foreground">{t('landing.encryption.body')}</p>

              <div className="flex flex-col gap-4 mt-2">
                {ENCRYPTION_STEPS.map((step) => (
                  <div key={step.n} className="flex gap-3">
                    <span className="text-xs font-mono text-muted-foreground pt-0.5">
                      {step.n}
                    </span>
                    <div>
                      <p className="text-sm font-medium">{t(step.title)}</p>
                      <p className="text-xs text-muted-foreground">
                        {t(step.body)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <div>
            <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase mb-3">
              {t('landing.privacy.eyebrow')}
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
              {t('landing.privacy.title')}
            </h2>
            <p className="text-muted-foreground mb-4">{t('landing.privacy.body')}</p>
            <p
              data-testid="landing-exchange-rates-note"
              className="text-sm text-muted-foreground mb-8"
            >
              {t('landing.privacy.ratesNote')}
            </p>

            <div data-testid="landing-privacy-bullets" className="flex flex-col gap-3">
              {PRIVACY_BULLETS.map((b) => (
                <div key={b} className="flex items-center gap-3">
                  <span className="flex items-center justify-center h-5 w-5 rounded-full bg-[#6366f1]/10 shrink-0">
                    <Check className="h-3 w-3 text-[#6366f1]" />
                  </span>
                  <span className="text-sm">
                    {b === 'landing.privacy.bullet2' ? (
                      // With sync available: "Optional encrypted sync" replaces
                      // "Zero financial data on MinimaSpend servers".
                      <SyncAvailable fallback={t(b)}>
                        {t('landing.privacy.bullet2Sync')}
                      </SyncAvailable>
                    ) : (
                      t(b)
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-t border-border scroll-mt-16">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-20">
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-10">
            <div>
              <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase mb-3">
                {t('nav.features')}
              </p>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
                {t('landing.features.title')}
                <br />
                {t('landing.features.titleAccent')}
              </h2>
            </div>
            <p className="text-muted-foreground max-w-sm">{t('landing.features.body')}</p>
            <SyncAvailable>
              <p
                data-testid="landing-sync-feature"
                className="text-sm font-medium text-[#6366f1] max-w-sm"
              >
                {t('landing.features.syncLine')}
              </p>
            </SyncAvailable>
            {ENABLE_SPACES && (
              <p
                data-testid="landing-family-feature"
                className="text-sm font-medium text-[#6366f1] max-w-sm"
              >
                {t('landing.features.familyLine')}
              </p>
            )}
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-px bg-border rounded-xl overflow-hidden">
            {FEATURES.map((f) => (
              <div key={f.title} className="bg-card p-6 flex flex-col gap-3">
                <f.icon className="h-5 w-5 text-[#6366f1]" />
                <h3 className="font-semibold">{t(f.title)}</h3>
                <p className="text-sm text-muted-foreground">{t(f.body)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Portability */}
      <section className="border-t border-border">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-20 grid md:grid-cols-2 gap-12 items-center">
          <div>
            <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase mb-3">
              {t('landing.portability.eyebrow')}
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
              {t('landing.portability.title')}
            </h2>
            <p className="text-muted-foreground mb-8">{t('landing.portability.body')}</p>

            <div className="grid grid-cols-2 gap-3">
              {PORTABILITY_FILES.map((label) => (
                <div
                  key={label}
                  className="flex items-center gap-2 rounded-md border border-border px-4 py-2.5 text-sm"
                >
                  <Download className="h-4 w-4 text-muted-foreground" />
                  {t(label)}
                </div>
              ))}
            </div>
          </div>

          <Card className="bg-card/60 backdrop-blur-sm font-mono text-xs">
            <div className="px-6 flex items-center gap-2 text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-[#6366f1]" />
              {'expenses_export.csv'}
            </div>
            <div className="px-6 flex flex-col gap-1 overflow-x-auto">
              <p className="text-muted-foreground">{CSV_HEADER}</p>
              {CSV_PREVIEW_ROWS.map((row) => (
                <p key={row}>{t(row)}</p>
              ))}
              <p className="text-muted-foreground">...</p>
            </div>
          </Card>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-t border-border scroll-mt-16">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-20 flex flex-col items-center text-center">
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase mb-3">
            {t('nav.pricing')}
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            {t('landing.pricing.title')}
          </h2>
          <p className="text-muted-foreground max-w-md mb-10">{t('landing.pricing.body')}</p>

          <Card className="w-full max-w-sm bg-card/60 backdrop-blur-sm">
            <div className="px-6 flex flex-col items-center">
              <p className="text-4xl font-bold">{t('landing.pricing.price')}</p>
              <p className="text-sm text-muted-foreground mb-6">{t('landing.pricing.forever')}</p>

              <div className="flex flex-col gap-3 w-full mb-6 text-left">
                {PRICING_ITEMS.map((item) => (
                  <div key={item} className="flex items-center gap-3">
                    <span className="flex items-center justify-center h-5 w-5 rounded-full bg-[#6366f1]/10 shrink-0">
                      <Check className="h-3 w-3 text-[#6366f1]" />
                    </span>
                    <span className="text-sm">{t(item)}</span>
                  </div>
                ))}
              </div>

              <StartTrackingButton className="w-full">
                {t('landing.startTracking')}
              </StartTrackingButton>
            </div>
          </Card>
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-border">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-20">
          <div className="rounded-2xl bg-muted/50 px-6 py-16 flex flex-col items-center text-center gap-4">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
              {t('landing.cta.title')}
            </h2>
            <p className="text-muted-foreground max-w-md">{t('landing.cta.body')}</p>
            <StartTrackingButton className="mt-4">
              {t('landing.startTracking')}
            </StartTrackingButton>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer data-testid="landing-footer" className="border-t border-border">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <p>{t('landing.footer')}</p>
          <div className="flex flex-col sm:flex-row items-center gap-4">
            <LegalLinks />
            <p>&copy; {new Date().getFullYear()} MinimaSpend</p>
          </div>
        </div>
      </footer>
    </div>
  )
}
