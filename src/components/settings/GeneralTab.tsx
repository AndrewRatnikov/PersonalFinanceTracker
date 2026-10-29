import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import type { ChangeMainCurrencyResult, ConvertProgress } from '@/lib/conversion'
import type { Currency } from '@/lib/domain'
import { LANGS, isLang, useT } from '@/i18n'
import { errorMessage } from '@/i18n/errors'
import { formatFullDate } from '@/i18n/format'
import { updateCurrencySettings } from '@/lib/appSettings'
import {
  CONVERSION_STATUS_QUERY_KEY,
  MainCurrencyChangeError,
  changeMainCurrency,
  getConversionStatus,
  requestConversion,
} from '@/lib/conversion'
import { isDecryptError } from '@/lib/dataErrors'
import { reportDataProblem } from '@/lib/dataProblem'
import { CURRENCIES, DEFAULT_MAIN_CURRENCY, isCurrency } from '@/lib/domain'
import { pendingLabel } from '@/lib/money'
import { spaceQueryKey, useActiveSpace } from '@/lib/spaces/react'
import { spaceArgs, withSpaceOption } from '@/lib/spaces/spaceDb'
import { useCurrencySettings } from '@/lib/useCurrencySettings'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Card, CardContent } from '@/components/ui/card'

// Everything whose numbers depend on the main currency.
const QUERIES_AFTER_CHANGE: ReadonlyArray<Array<string>> = [
  ['settings'],
  [...CONVERSION_STATUS_QUERY_KEY],
  ['expenses'],
  ['income'],
  ['analytics'],
  ['budgets'],
]

type ChangeState =
  | { phase: 'confirm' }
  | { phase: 'running'; progress: ConvertProgress | null }
  | { phase: 'done'; result: ChangeMainCurrencyResult }
  | { phase: 'error'; error: unknown }

// Settings → General: the UI language, the main currency (changed through a
// confirm dialog that converts budgets and recalculates every entry) and the
// NBU exchange-rate switch.
export function GeneralTab() {
  const queryClient = useQueryClient()
  const { t, plural, lang, setLang } = useT()
  const spaceId = useActiveSpace()
  const settingsQuery = useCurrencySettings()
  const statusQuery = useQuery({
    queryKey: spaceQueryKey(spaceId, 'conversion-status'),
    queryFn: () => getConversionStatus(...spaceArgs(spaceId)),
  })

  const mainCurrency = settingsQuery.data?.mainCurrency ?? DEFAULT_MAIN_CURRENCY
  const fetchExchangeRates = settingsQuery.data?.fetchExchangeRates ?? true

  const [pendingNext, setPendingNext] = useState<Currency | null>(null)
  const [change, setChange] = useState<ChangeState>({ phase: 'confirm' })
  const [savingSwitch, setSavingSwitch] = useState(false)

  const running = change.phase === 'running'

  function invalidate(keys: ReadonlyArray<Array<string>>) {
    for (const queryKey of keys) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }

  function openDialog(value: string) {
    if (!isCurrency(value) || value === mainCurrency) return
    setChange({ phase: 'confirm' })
    setPendingNext(value)
  }

  function closeDialog() {
    if (running) return
    setPendingNext(null)
    setChange({ phase: 'confirm' })
  }

  async function confirmChange() {
    const next = pendingNext
    if (!next || running) return
    setChange({ phase: 'running', progress: null })
    try {
      const result = await changeMainCurrency(
        next,
        withSpaceOption(
          {
            onProgress: (progress: ConvertProgress) => {
              setChange({ phase: 'running', progress })
            },
          },
          spaceId,
        ),
      )
      setChange({ phase: 'done', result })
      invalidate(QUERIES_AFTER_CHANGE)
    } catch (err) {
      if (isDecryptError(err)) {
        reportDataProblem(err)
        setPendingNext(null)
        setChange({ phase: 'confirm' })
        return
      }
      if (err instanceof MainCurrencyChangeError) {
        setChange({ phase: 'error', error: err })
        return
      }
      console.error('Changing the main currency failed:', err)
      setChange({ phase: 'error', error: null })
    }
  }

  async function toggleRates(next: boolean) {
    setSavingSwitch(true)
    try {
      await updateCurrencySettings({ fetchExchangeRates: next }, ...spaceArgs(spaceId))
      invalidate([['settings'], [...CONVERSION_STATUS_QUERY_KEY]])
      if (next) void requestConversion()
    } catch (err) {
      console.error('Saving the exchange-rate setting failed:', err)
      toast.error(t('settings.general.saveSettingFailed'))
    } finally {
      setSavingSwitch(false)
    }
  }

  const status = statusQuery.data
  const statusText = status
    ? status.pendingEntries > 0
      ? pendingLabel(status.pendingEntries)
      : t('settings.general.allConverted')
    : statusQuery.isError
      ? t('settings.general.statusFailed')
      : t('settings.general.checkingEntries')

  return (
    <div data-testid="general-tab" className="flex flex-col gap-4">
      <Card className="border-border bg-card/40">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <label
            htmlFor="settings-language"
            className="text-sm font-medium text-foreground"
          >
            {t('settings.language.label')}
          </label>
          <select
            id="settings-language"
            data-testid="settings-language"
            value={lang}
            onChange={(e) => {
              if (isLang(e.target.value)) setLang(e.target.value)
            }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {LANGS.map((option) => (
              <option key={option} value={option}>
                {option === 'uk'
                  ? t('common.languageName.uk')
                  : t('common.languageName.en')}
              </option>
            ))}
          </select>
        </CardContent>
      </Card>

      <Card className="border-border bg-card/40">
        <CardContent className="flex flex-col gap-3 px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col">
              <label
                htmlFor="settings-main-currency"
                className="text-sm font-medium text-foreground"
              >
                {t('settings.general.mainCurrency')}
              </label>
              <span className="text-xs text-muted-foreground">
                {t('settings.general.mainCurrencyHint')}
              </span>
            </div>
            <select
              id="settings-main-currency"
              data-testid="settings-main-currency"
              aria-label={t('settings.general.mainCurrency')}
              value={mainCurrency}
              disabled={settingsQuery.isLoading || running}
              onChange={(e) => openDialog(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <p
            data-testid="settings-conversion-status"
            className="text-xs text-muted-foreground"
          >
            {statusText}
          </p>
        </CardContent>
      </Card>

      <Card className="border-border bg-card/40">
        <CardContent className="flex flex-col gap-2 px-4 py-4">
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-foreground">
              {t('settings.general.fetchRates')}
            </span>
            <input
              type="checkbox"
              role="switch"
              data-testid="settings-fetch-rates"
              checked={fetchExchangeRates}
              aria-checked={fetchExchangeRates}
              disabled={settingsQuery.isLoading || savingSwitch}
              onChange={(e) => void toggleRates(e.target.checked)}
              className="h-5 w-5 accent-primary"
            />
          </label>
          <p
            data-testid="settings-fetch-rates-help"
            className="text-xs text-muted-foreground"
          >
            {t('settings.general.fetchRatesHelp')}
          </p>
        </CardContent>
      </Card>

      <AlertDialog
        open={pendingNext !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog()
        }}
      >
        <AlertDialogContent data-testid="main-currency-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.general.changeTitle')}</AlertDialogTitle>
            <AlertDialogDescription data-testid="main-currency-confirm-text">
              {plural('settings.general.changeText', status?.totalEntries ?? 0, {
                currency: pendingNext ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {change.phase === 'running' && (
            <p
              data-testid="main-currency-progress"
              className="text-sm text-muted-foreground"
            >
              {t('settings.general.progress', {
                done: change.progress?.done ?? 0,
                total: change.progress?.total ?? 0,
              })}
            </p>
          )}
          {change.phase === 'error' && (
            <p
              data-testid="main-currency-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {change.error === null
                ? t('settings.general.changeFailed')
                : errorMessage(change.error)}
            </p>
          )}
          {change.phase === 'done' && (
            <p
              data-testid="main-currency-budgets-note"
              className="text-sm text-muted-foreground"
            >
              {change.result.budgetsConverted > 0
                ? plural('settings.general.budgetsConverted', change.result.budgetsConverted, {
                    currency: pendingNext ?? '',
                    // English keeps today's YYYY-MM-DD wording.
                    date:
                      change.result.rateDate && lang === 'uk'
                        ? formatFullDate(change.result.rateDate)
                        : (change.result.rateDate ?? ''),
                  })
                : t('settings.general.noBudgets')}
            </p>
          )}

          <AlertDialogFooter>
            {change.phase === 'done' ? (
              <Button data-testid="main-currency-done-btn" onClick={closeDialog}>
                {t('common.done')}
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  data-testid="main-currency-cancel-btn"
                  disabled={running}
                  onClick={closeDialog}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  data-testid="main-currency-confirm-btn"
                  disabled={running}
                  onClick={() => void confirmChange()}
                >
                  {running ? t('settings.general.converting') : t('common.confirm')}
                </Button>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
