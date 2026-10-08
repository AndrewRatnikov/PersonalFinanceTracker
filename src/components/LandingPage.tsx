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
import { formatRestoreSummary } from '@/lib/backup'
import { requestCreateVault, setVaultPhase } from '@/lib/vaultSession'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { RestoreBackupDialog } from '@/components/RestoreBackupDialog'

const PROBLEMS = [
  {
    title: 'Bank credentials handed over',
    body: 'To sync automatically, most apps need your login — then store a copy.',
  },
  {
    title: 'Data on third-party servers',
    body: "Your spending history lives where you can't audit it, delete it, or fully control it.",
  },
  {
    title: 'Business model misalignment',
    body: 'Free apps monetize through data partnerships, credit card upsells, or targeted offers.',
  },
]

const ENCRYPTION_STEPS = [
  {
    n: '01',
    title: 'You enter a password',
    body: 'Stays in-browser, never transmitted',
  },
  {
    n: '02',
    title: 'PBKDF2 derives an encryption key',
    body: '200k iterations, device-scoped salt',
  },
  {
    n: '03',
    title: 'AES-GCM encrypts your data',
    body: 'Before writing to IndexedDB',
  },
  {
    n: '04',
    title: 'Encrypted blobs stored locally',
    body: 'Unreadable without your password',
  },
]

const PRIVACY_BULLETS = [
  'Password never stored, never transmitted',
  'Zero financial data on MinimaSpend servers',
  'No account needed — nothing to sign up for',
  'Remove all data from this device in one step',
]

const FEATURES = [
  {
    icon: Zap,
    title: 'Quick Add',
    body: 'Log an expense in under five seconds. Amount, currency, category — done. Designed for the moment of spending, not after the fact.',
  },
  {
    icon: PieChart,
    title: 'Analytics',
    body: 'Category breakdown donut, 12-month spending bars, and budget-vs-actual variance — all filterable by date range.',
  },
  {
    icon: PieChart,
    title: 'Budgets',
    body: "Set a monthly limit per category. See at a glance whether you're on track, over, or with headroom to spare.",
  },
  {
    icon: Globe,
    title: 'Multi-currency',
    body: 'UAH, USD, EUR on every entry. Freelancers and travelers log in the currency they actually spent.',
  },
  {
    icon: Download,
    title: 'CSV export & import',
    body: 'All your expenses, income, budgets, and categories export to CSV. Import anytime. No lock-in, ever.',
  },
  {
    icon: Wifi,
    title: 'PWA · works offline',
    body: 'Install it on your home screen. Log expenses on the subway or in a dead-zone — it syncs nothing, needs nothing.',
  },
  {
    icon: PieChart,
    title: 'Default categories',
    body: 'Food, Transport, Rent, Coffee, Entertainment, Server Costs — pre-seeded so the first log takes zero setup.',
  },
  {
    icon: Globe,
    title: 'Income tracking',
    body: 'Log freelance payments, salary, or any inbound money alongside expenses for a complete picture.',
  },
]

const PRICING_ITEMS = [
  'Unlimited expenses & income entries',
  'All analytics & charts',
  'Budget tracking per category',
  'CSV export & import',
  'PWA — install on any device',
  'Encrypted local storage',
]

const CSV_PREVIEW = [
  'date,amount,currency,category,description',
  '2024-01-15,4.80,USD,Food,Coffee',
  '2024-01-15,12.00,USD,Dev,Server Costs',
  '2024-01-14,420.00,USD,Income,Freelance Jan',
  '2024-01-14,2.50,USD,Transport,Metro',
  '2024-01-13,67.40,UAH,Food,Groceries',
  '2024-01-13,850.00,UAH,Rent,Jan rent',
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
            <p className="text-[11px] text-muted-foreground">Income</p>
            <p className="text-lg font-bold tabular-nums">$3,240</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-[11px] text-muted-foreground">Expenses</p>
            <p className="text-lg font-bold tabular-nums">$1,847</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-[11px] text-muted-foreground">Balance</p>
            <p className="text-lg font-bold tabular-nums">$1,393</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-border p-3">
            <p className="text-[11px] text-muted-foreground mb-2">
              12-month spending
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
              By category
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
          <p className="text-[11px] text-muted-foreground mb-2">Quick Add</p>
          <div className="flex items-center gap-2">
            <div className="flex-1 rounded-md border border-input px-3 py-2 text-sm font-semibold">
              $ 24.50
            </div>
            <div className="rounded-md border border-input px-3 py-2 text-xs text-muted-foreground">
              Coffee
            </div>
            <Button
              size="sm"
              className="bg-[#6366f1] hover:bg-[#4f46e5] text-white border-0"
            >
              Add
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-border p-3">
          <p className="text-[11px] text-muted-foreground mb-2">Recent</p>
          <div className="flex flex-col gap-2.5 text-sm">
            {[
              { label: 'Coffee', time: '2m ago', amount: '-$4.80' },
              { label: 'Server Costs', time: '1h ago', amount: '-$12.00' },
              {
                label: 'Freelance',
                time: '3h ago',
                amount: '+$420.00',
                positive: true,
              },
              { label: 'Transport', time: '5h ago', amount: '-$2.50' },
            ].map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between"
              >
                <div>
                  <p className="font-medium">{row.label}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {row.time}
                  </p>
                </div>
                <span
                  className={
                    row.positive
                      ? 'text-emerald-500 font-medium'
                      : 'font-medium'
                  }
                >
                  {row.amount}
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

  // A fresh-device restore adopted the backup's vault and unlocked it.
  const handleRestored = (summary: RestoreSummary) => {
    setVaultPhase('unlocked')
    toast.success(formatRestoreSummary(summary))
  }

  return (
    <div className="bg-background text-foreground">
      {/* Hero */}
      <section className="max-w-6xl mx-auto px-4 md:px-8 pt-16 pb-20 grid md:grid-cols-2 gap-12 items-center">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground mb-6">
            <Lock className="h-3 w-3" />
            Local-first · Encrypted at rest · No bank linking
          </div>

          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-[1.1] mb-6">
            Track your money.
            <br />
            <span className="text-[#6366f1]">Own your data.</span>
          </h1>

          <p className="text-lg text-muted-foreground mb-8 max-w-md">
            A minimal personal finance tracker that keeps every expense, budget,
            and income entry encrypted on your device — not on someone else's
            server.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <StartTrackingButton testId="landing-start-tracking">
              Start tracking
            </StartTrackingButton>
            <Button
              type="button"
              variant="outline"
              size="lg"
              data-testid="landing-restore-backup"
              onClick={() => setRestoreOpen(true)}
            >
              Restore from backup
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
                See how it works
              </a>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Free to use · No account needed · Your data stays on your device
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
            The problem
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6 max-w-2xl">
            Most budgeting apps ask for your bank login. We think that's
            backwards.
          </h2>
          <p className="text-muted-foreground max-w-2xl mb-10">
            Mint, YNAB, Copilot — they all want read access to your bank
            accounts and store your complete spending history on their servers.
            One breach, one acquisition, one pivot to ads, and your financial
            life is exposed.
          </p>

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
                    <h3 className="font-semibold">{p.title}</h3>
                    <p className="text-sm text-muted-foreground">{p.body}</p>
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
              <h3 className="text-lg font-semibold">AES-GCM encryption</h3>
              <p className="text-sm text-muted-foreground">
                Your password never leaves your device. It's used to derive a
                key via PBKDF2 (200,000 iterations) with a device-scoped salt —
                industry-standard key stretching that makes brute-force attacks
                impractical.
              </p>

              <div className="flex flex-col gap-4 mt-2">
                {ENCRYPTION_STEPS.map((step) => (
                  <div key={step.n} className="flex gap-3">
                    <span className="text-xs font-mono text-muted-foreground pt-0.5">
                      {step.n}
                    </span>
                    <div>
                      <p className="text-sm font-medium">{step.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {step.body}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <div>
            <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase mb-3">
              Privacy
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
              Your data, encrypted, on your device
            </h2>
            <p className="text-muted-foreground mb-8">
              There is no account to create. Your financial data never touches
              any server: it lives in your browser's IndexedDB, encrypted before
              it's written.
            </p>

            <div className="flex flex-col gap-3">
              {PRIVACY_BULLETS.map((b) => (
                <div key={b} className="flex items-center gap-3">
                  <span className="flex items-center justify-center h-5 w-5 rounded-full bg-[#6366f1]/10 shrink-0">
                    <Check className="h-3 w-3 text-[#6366f1]" />
                  </span>
                  <span className="text-sm">{b}</span>
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
                Features
              </p>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
                Everything you need.
                <br />
                Nothing you don't.
              </h2>
            </div>
            <p className="text-muted-foreground max-w-sm">
              No bank linking, no ads, no algorithmic nudges. Just a fast, clear
              view of where money goes.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-px bg-border rounded-xl overflow-hidden">
            {FEATURES.map((f) => (
              <div key={f.title} className="bg-card p-6 flex flex-col gap-3">
                <f.icon className="h-5 w-5 text-[#6366f1]" />
                <h3 className="font-semibold">{f.title}</h3>
                <p className="text-sm text-muted-foreground">{f.body}</p>
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
              Portability
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
              Leave anytime. Take everything with you.
            </h2>
            <p className="text-muted-foreground mb-8">
              Every record you've created exports to clean, standard CSV files.
              Import them into Excel, Google Sheets, or a future app. No
              proprietary format, no export fee, no friction.
            </p>

            <div className="grid grid-cols-2 gap-3">
              {[
                'Expenses CSV',
                'Income CSV',
                'Budgets CSV',
                'Categories CSV',
              ].map((label) => (
                <div
                  key={label}
                  className="flex items-center gap-2 rounded-md border border-border px-4 py-2.5 text-sm"
                >
                  <Download className="h-4 w-4 text-muted-foreground" />
                  {label}
                </div>
              ))}
            </div>
          </div>

          <Card className="bg-card/60 backdrop-blur-sm font-mono text-xs">
            <div className="px-6 flex items-center gap-2 text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-[#6366f1]" />
              expenses_export.csv
            </div>
            <div className="px-6 flex flex-col gap-1 overflow-x-auto">
              {CSV_PREVIEW.map((line, i) => (
                <p key={i} className={i === 0 ? 'text-muted-foreground' : ''}>
                  {line}
                </p>
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
            Pricing
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Free. No asterisk.
          </h2>
          <p className="text-muted-foreground max-w-md mb-10">
            MinimaSpend is free to use. There's no premium tier, no feature
            gating, and no ads — because the model doesn't depend on your data.
          </p>

          <Card className="w-full max-w-sm bg-card/60 backdrop-blur-sm">
            <div className="px-6 flex flex-col items-center">
              <p className="text-4xl font-bold">$0</p>
              <p className="text-sm text-muted-foreground mb-6">forever</p>

              <div className="flex flex-col gap-3 w-full mb-6 text-left">
                {PRICING_ITEMS.map((item) => (
                  <div key={item} className="flex items-center gap-3">
                    <span className="flex items-center justify-center h-5 w-5 rounded-full bg-[#6366f1]/10 shrink-0">
                      <Check className="h-3 w-3 text-[#6366f1]" />
                    </span>
                    <span className="text-sm">{item}</span>
                  </div>
                ))}
              </div>

              <StartTrackingButton className="w-full">
                Start tracking
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
              Start tracking in 30 seconds.
            </h2>
            <p className="text-muted-foreground max-w-md">
              No sign-up, zero bank credentials, and your first expense logged
              before you forget it.
            </p>
            <StartTrackingButton className="mt-4">
              Start tracking
            </StartTrackingButton>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <p>No account needed. No financial data is stored on any server.</p>
          <p>&copy; {new Date().getFullYear()} MinimaSpend</p>
        </div>
      </footer>
    </div>
  )
}
