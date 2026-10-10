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

// The key has six full 5-character groups and a 2-character tail.
const FULL_GROUPS = 6

// Picks which full group (1-6) the user must type back. Never the tail.
export function pickConfirmationGroup(
  random: () => number = Math.random,
): number {
  return Math.min(FULL_GROUPS, Math.floor(random() * FULL_GROUPS) + 1)
}

// Shows a recovery key and only lets the user continue once they have ticked
// "I've saved my recovery key" and typed one full group of it, picked at
// random from groups 1-6 when the step mounts (spec §2.1 step 3). Case and
// surrounding spaces are ignored. Rendered inside the caller's card; it has
// no overlay of its own.
export function RecoveryKeySaveStep({
  recoveryKey,
  onConfirmed,
  confirmLabel,
}: RecoveryKeySaveStepProps) {
  const [saved, setSaved] = useState(false)
  const [group] = useState(() => pickConfirmationGroup())
  const [typedGroup, setTypedGroup] = useState('')
  const [copied, setCopied] = useState(false)

  const expected = recoveryKey.split('-')[group - 1].toUpperCase()
  const canContinue = saved && typedGroup.trim().toUpperCase() === expected

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
        <Label
          data-testid="recovery-key-group-prompt"
          htmlFor="recovery-key-group-input"
        >
          Type group {group} of your key
        </Label>
        <Input
          id="recovery-key-group-input"
          data-testid="recovery-key-group-input"
          type="text"
          value={typedGroup}
          onChange={(e) => setTypedGroup(e.target.value)}
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
