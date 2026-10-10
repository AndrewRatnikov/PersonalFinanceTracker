// No CONTRACT_GAPs: props, testids and pickConfirmationGroup are fully
// specified in the Interface Contract (component: RecoveryKeySaveStep).

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RecoveryKeySaveStep,
  pickConfirmationGroup,
} from '@/components/vault/RecoveryKeySaveStep'

const KEY = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-XY'
const OTHER_KEY = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-3K'
const GROUPS = KEY.split('-')

function continueButton() {
  return screen.getByTestId<HTMLButtonElement>('recovery-key-continue')
}

function tick(checked = true) {
  const box = screen.getByTestId<HTMLInputElement>('recovery-key-saved-checkbox')
  if (box.checked !== checked) fireEvent.click(box)
}

function typeGroup(value: string) {
  fireEvent.change(screen.getByTestId('recovery-key-group-input'), {
    target: { value },
  })
}

function promptedGroup(): number {
  const text = screen.getByTestId('recovery-key-group-prompt').textContent
  const match = /^Type group (\d+) of your key$/.exec(text)
  if (!match) throw new Error(`Unexpected prompt: ${text}`)
  return Number(match[1])
}

// Math.random() = 0 asks for group 1 (ABCDE).
function renderGroupOne(recoveryKey = KEY, onConfirmed = vi.fn()) {
  vi.spyOn(Math, 'random').mockReturnValue(0)
  return render(
    <RecoveryKeySaveStep recoveryKey={recoveryKey} onConfirmed={onConfirmed} />,
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('pickConfirmationGroup', () => {
  it('maps random() = 0 to group 1', () => {
    expect(pickConfirmationGroup(() => 0)).toBe(1)
  })

  it('maps random() just below 1 to group 6', () => {
    expect(pickConfirmationGroup(() => 0.999999)).toBe(6)
  })

  it('maps random() = 0.5 to group 4', () => {
    expect(pickConfirmationGroup(() => 0.5)).toBe(4)
  })

  it('never returns more than 6, even for random() = 1', () => {
    expect(pickConfirmationGroup(() => 1)).toBe(6)
  })

  it('always returns an integer from 1 to 6 and reaches both ends', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 1000; i++) {
      const group = pickConfirmationGroup(() => i / 1000)
      expect(Number.isInteger(group)).toBe(true)
      expect(group).toBeGreaterThanOrEqual(1)
      expect(group).toBeLessThanOrEqual(6)
      seen.add(group)
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('uses Math.random by default', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(pickConfirmationGroup()).toBe(1)
    vi.spyOn(Math, 'random').mockReturnValue(0.999999)
    expect(pickConfirmationGroup()).toBe(6)
  })
})

describe('RecoveryKeySaveStep display', () => {
  it('shows the exact formatted key', () => {
    render(<RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />)

    expect(screen.getByTestId('recovery-key-step')).toBeTruthy()
    expect(screen.getByTestId('recovery-key-value').textContent).toBe(KEY)
  })

  it('shows a different key when given a different one', () => {
    render(<RecoveryKeySaveStep recoveryKey={OTHER_KEY} onConfirmed={vi.fn()} />)
    expect(screen.getByTestId('recovery-key-value').textContent).toBe(OTHER_KEY)
  })

  it("labels the continue button 'Continue' by default and honours confirmLabel", () => {
    const { unmount } = render(
      <RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />,
    )
    expect(continueButton().textContent).toBe('Continue')
    unmount()

    render(
      <RecoveryKeySaveStep
        recoveryKey={KEY}
        onConfirmed={vi.fn()}
        confirmLabel="Done"
      />,
    )
    expect(continueButton().textContent).toBe('Done')
  })
})

describe('RecoveryKeySaveStep group prompt', () => {
  it.each([
    [0, 1],
    [0.2, 2],
    [0.5, 4],
    [0.999999, 6],
  ])('with random() = %s it asks for "Type group %s of your key"', (random, group) => {
    vi.spyOn(Math, 'random').mockReturnValue(random)
    render(<RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />)

    expect(screen.getByTestId('recovery-key-group-prompt').textContent).toBe(
      `Type group ${group} of your key`,
    )
  })

  it('accepts the group that was asked for (different groups, different answers)', () => {
    for (const [random, group] of [
      [0, 1],
      [0.5, 4],
      [0.999999, 6],
    ] as const) {
      vi.spyOn(Math, 'random').mockReturnValue(random)
      const { unmount } = render(
        <RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />,
      )
      tick()
      typeGroup(GROUPS[group - 1])
      expect(continueButton().disabled).toBe(false)
      // A group that was not asked for does not work.
      const other = GROUPS[group % 6]
      typeGroup(other)
      expect(continueButton().disabled).toBe(true)
      unmount()
    }
  })

  it('always asks for a 5-character group, never the 2-character tail', () => {
    for (let i = 0; i < 12; i++) {
      vi.spyOn(Math, 'random').mockReturnValue(i / 12)
      const { unmount } = render(
        <RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />,
      )
      const group = promptedGroup()
      expect(group).toBeGreaterThanOrEqual(1)
      expect(group).toBeLessThanOrEqual(6)
      expect(GROUPS[group - 1]).toHaveLength(5)
      unmount()
    }
  })

  it('picks the group once per mount and keeps it across re-renders', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    render(<RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />)
    expect(promptedGroup()).toBe(1)

    vi.spyOn(Math, 'random').mockReturnValue(0.999999)
    tick()
    typeGroup('x')
    typeGroup('xy')

    expect(promptedGroup()).toBe(1)
  })

  it('no longer renders the old last-group input', () => {
    renderGroupOne()
    expect(screen.queryByTestId('recovery-key-last-group-input')).toBeNull()
    expect(screen.getByTestId('recovery-key-group-input')).toBeTruthy()
  })
})

describe('RecoveryKeySaveStep continue gating', () => {
  it('is disabled initially', () => {
    renderGroupOne()
    expect(continueButton().disabled).toBe(true)
  })

  it('stays disabled with only the checkbox ticked', () => {
    renderGroupOne()
    tick()
    expect(continueButton().disabled).toBe(true)
  })

  it('stays disabled with only the correct group typed', () => {
    renderGroupOne()
    typeGroup('ABCDE')
    expect(continueButton().disabled).toBe(true)
  })

  it('stays disabled when the typed group is wrong', () => {
    renderGroupOne()
    tick()
    for (const wrong of ['', 'A', 'ABCD', 'ABCDEF', 'FGHJK', 'XY']) {
      typeGroup(wrong)
      expect(continueButton().disabled).toBe(true)
    }
  })

  it('enables once ticked and the group matches', () => {
    renderGroupOne()
    tick()
    typeGroup('ABCDE')
    expect(continueButton().disabled).toBe(false)
  })

  it('matches the group in lower case and ignores surrounding spaces', () => {
    renderGroupOne()
    tick()
    typeGroup('  abcde ')
    expect(continueButton().disabled).toBe(false)
  })

  it('typing the 2-character tail never enables Continue', () => {
    for (const random of [0, 0.2, 0.5, 0.8, 0.999999]) {
      vi.spyOn(Math, 'random').mockReturnValue(random)
      const { unmount } = render(
        <RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />,
      )
      tick()
      typeGroup('XY')
      expect(continueButton().disabled).toBe(true)
      typeGroup('xy')
      expect(continueButton().disabled).toBe(true)
      unmount()
    }
  })

  it('compares against the key it was given', () => {
    // Group 7 differs between the two keys but is never asked; use a key whose
    // asked group differs instead.
    const alt = 'QQQQQ-FGHJK-MNPQR-STVWX-YZ012-34567-3K'
    renderGroupOne(alt)
    tick()
    typeGroup('ABCDE')
    expect(continueButton().disabled).toBe(true)
    typeGroup('qqqqq')
    expect(continueButton().disabled).toBe(false)
  })

  it('disables again when the checkbox is unticked', () => {
    renderGroupOne()
    tick()
    typeGroup('ABCDE')
    expect(continueButton().disabled).toBe(false)
    tick(false)
    expect(continueButton().disabled).toBe(true)
  })

  it('calls onConfirmed once when continue is clicked, and not before', () => {
    const onConfirmed = vi.fn()
    renderGroupOne(KEY, onConfirmed)

    fireEvent.click(continueButton())
    expect(onConfirmed).not.toHaveBeenCalled()

    tick()
    typeGroup('ABCDE')
    fireEvent.click(continueButton())
    expect(onConfirmed).toHaveBeenCalledTimes(1)
  })
})

describe('RecoveryKeySaveStep actions', () => {
  it('Copy writes the key to the clipboard', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    render(<RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />)

    fireEvent.click(screen.getByTestId('recovery-key-copy'))

    expect(writeText).toHaveBeenCalledWith(KEY)
  })

  it('Copy does not throw when the clipboard API is missing', () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    })
    render(<RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />)

    expect(() => {
      fireEvent.click(screen.getByTestId('recovery-key-copy'))
    }).not.toThrow()
  })

  it('Download creates a text/plain blob and clicks an anchor named minima-recovery-key.txt', () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:fake')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    })
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    render(<RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />)

    fireEvent.click(screen.getByTestId('recovery-key-download'))

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type.startsWith('text/plain')).toBe(true)
    expect(blob.size).toBeGreaterThanOrEqual(KEY.length)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    const anchor = clickSpy.mock.contexts[0] as HTMLAnchorElement
    expect(anchor.download).toBe('minima-recovery-key.txt')
  })

  it('Print calls window.print', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined)
    render(<RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />)

    fireEvent.click(screen.getByTestId('recovery-key-print'))

    expect(print).toHaveBeenCalledTimes(1)
  })
})
