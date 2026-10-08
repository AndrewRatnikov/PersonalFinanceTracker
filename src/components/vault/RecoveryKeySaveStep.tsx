import { useState } from 'react'
import { Check, Copy, Download, Printer } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface RecoveryKeySaveStepProps {
  recoveryKey: string
  onConfirmed: () => void
  confirmLabel?: string
}

const DOWNLOAD_FILENAME = 'minima-recovery-key.txt'

function lastGroupOf(recoveryKey: string): string {
  const parts = recoveryKey.split('-')
  return parts[parts.length - 1].toUpperCase()
}

// Shows a recovery key and only lets the user continue once they have ticked
// "I've saved my recovery key" and typed its last group. Rendered inside the
// caller's card; it has no overlay of its own.
export function RecoveryKeySaveStep({
  recoveryKey,
  onConfirmed,
  confirmLabel,
}: RecoveryKeySaveStepProps) {
  const [saved, setSaved] = useState(false)
  const [lastGroup, setLastGroup] = useState('')
  const [copied, setCopied] = useState(false)

  const expected = lastGroupOf(recoveryKey)
  const canContinue = saved && lastGroup.trim().toUpperCase() === expected

  const handleCopy = () => {
    const clipboard = (navigator as { clipboard?: Clipboard | undefined })
      .clipboard
    if (!clipboard || typeof clipboard.writeText !== 'function') return
    clipboard.writeText(recoveryKey).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }

  const handleDownload = () => {
    const text =
      'MinimaSpend recovery key\n\n' +
      recoveryKey +
      '\n\nKeep this key somewhere safe. It opens your data if you forget your password.\n'
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = DOWNLOAD_FILENAME
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const handlePrint = () => {
    window.print()
  }

  return (
    <div data-testid="recovery-key-step" className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        This recovery key opens your data if you forget your password. Save it
        somewhere safe, outside this device. It is shown only now.
      </p>

      <div
        data-testid="recovery-key-value"
        className="rounded-md border bg-muted px-3 py-3 text-center font-mono text-base font-semibold tracking-wider break-all select-all"
      >
        {recoveryKey}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="recovery-key-copy"
          onClick={handleCopy}
        >
          {copied ? (
            <Check className="mr-1 h-4 w-4" />
          ) : (
            <Copy className="mr-1 h-4 w-4" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="recovery-key-download"
          onClick={handleDownload}
        >
          <Download className="mr-1 h-4 w-4" />
          .txt
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="recovery-key-print"
          onClick={handlePrint}
        >
          <Printer className="mr-1 h-4 w-4" />
          Print
        </Button>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="recovery-key-saved-checkbox"
          className="h-4 w-4"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
        I&apos;ve saved my recovery key
      </label>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="recovery-key-last-group">
          Type the last group of your key
        </Label>
        <Input
          id="recovery-key-last-group"
          data-testid="recovery-key-last-group-input"
          type="text"
          value={lastGroup}
          onChange={(e) => setLastGroup(e.target.value)}
          autoComplete="off"
          className="font-mono uppercase"
        />
      </div>

      <Button
        type="button"
        className="w-full"
        data-testid="recovery-key-continue"
        disabled={!canContinue}
        onClick={() => {
          if (canContinue) onConfirmed()
        }}
      >
        {confirmLabel ?? 'Continue'}
      </Button>
    </div>
  )
}
