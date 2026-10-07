// No CONTRACT_GAPs: props and testids are fully specified in the Interface
// Contract (component: RecoveryKeySaveStep).

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RecoveryKeySaveStep } from '@/components/vault/RecoveryKeySaveStep'

const KEY = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-XY'
const OTHER_KEY = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-3K'

function continueButton() {
  return screen.getByTestId<HTMLButtonElement>('recovery-key-continue')
}

function tick(checked = true) {
  const box = screen.getByTestId<HTMLInputElement>('recovery-key-saved-checkbox')
  if (box.checked !== checked) fireEvent.click(box)
}

function typeLastGroup(value: string) {
  fireEvent.change(screen.getByTestId('recovery-key-last-group-input'), {
    target: { value },
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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

describe('RecoveryKeySaveStep continue gating', () => {
  it('is disabled initially', () => {
    render(<RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />)
    expect(continueButton().disabled).toBe(true)
  })

  it('stays disabled with only the checkbox ticked', () => {
    render(<RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />)
    tick()
    expect(continueButton().disabled).toBe(true)
  })

  it('stays disabled with only the correct last group typed', () => {
    render(<RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />)
    typeLastGroup('XY')
    expect(continueButton().disabled).toBe(true)
  })

  it('stays disabled when the typed last group is wrong', () => {
    render(<RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />)
    tick()
    for (const wrong of ['', 'X', 'YX', 'AB', 'XYZ', '34567']) {
      typeLastGroup(wrong)
      expect(continueButton().disabled).toBe(true)
    }
  })

  it('enables once ticked and the last group matches', () => {
    render(<RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />)
    tick()
    typeLastGroup('XY')
    expect(continueButton().disabled).toBe(false)
  })

  it('matches the last group case-insensitively and trimmed', () => {
    render(<RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />)
    tick()
    typeLastGroup('  xy ')
    expect(continueButton().disabled).toBe(false)
  })

  it('compares against the last group of the key it was given', () => {
    render(<RecoveryKeySaveStep recoveryKey={OTHER_KEY} onConfirmed={vi.fn()} />)
    tick()
    typeLastGroup('XY')
    expect(continueButton().disabled).toBe(true)
    typeLastGroup('3k')
    expect(continueButton().disabled).toBe(false)
  })

  it('disables again when the checkbox is unticked', () => {
    render(<RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={vi.fn()} />)
    tick()
    typeLastGroup('XY')
    expect(continueButton().disabled).toBe(false)
    tick(false)
    expect(continueButton().disabled).toBe(true)
  })

  it('calls onConfirmed once when continue is clicked, and not before', () => {
    const onConfirmed = vi.fn()
    render(<RecoveryKeySaveStep recoveryKey={KEY} onConfirmed={onConfirmed} />)

    fireEvent.click(continueButton())
    expect(onConfirmed).not.toHaveBeenCalled()

    tick()
    typeLastGroup('XY')
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
