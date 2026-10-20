// No CONTRACT_GAPs: DescriptionSuggestInput props and testids are fully
// specified in the Interface Contract (component: DescriptionSuggestInput).

import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { DescriptionSuggestion, SuggestionEntry } from '@/lib/suggestions'
import { DescriptionSuggestInput } from '@/components/DescriptionSuggestInput'

const DAY = 86_400_000

function ago(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString()
}

function entry(
  description: string,
  daysAgo: number,
  overrides: Partial<SuggestionEntry> = {},
): SuggestionEntry {
  return {
    description,
    categoryId: 'cat-food',
    amount: 10,
    currency: 'UAH',
    createdAt: ago(daysAgo),
    ...overrides,
  }
}

// Order with an empty query and no category: Coffee (3 recent), Coffee beans,
// Lunch.
const ENTRIES: Array<SuggestionEntry> = [
  entry('Coffee', 1, { categoryId: 'cat-coffee', amount: 65 }),
  entry('Coffee', 2, { categoryId: 'cat-coffee', amount: 65 }),
  entry('Coffee', 3, { categoryId: 'cat-coffee', amount: 65 }),
  entry('Coffee beans', 4, { categoryId: 'cat-food', amount: 120 }),
  entry('Lunch', 6, { categoryId: 'cat-food', amount: 12.5, currency: 'USD' }),
]

type PickFn = (
  suggestion: DescriptionSuggestion,
  options: { withAmount: boolean },
) => void

interface HarnessProps {
  entries?: ReadonlyArray<SuggestionEntry>
  categoryId?: string
  initial?: string
  onPick?: PickFn
  onEnter?: () => void
  disabled?: boolean
  maxLength?: number
  placeholder?: string
  ariaLabel?: string
}

function Harness({
  entries = ENTRIES,
  categoryId,
  initial = '',
  onPick = () => {},
  onEnter,
  disabled,
  maxLength,
  placeholder,
  ariaLabel,
}: HarnessProps) {
  const [value, setValue] = useState(initial)
  return (
    <DescriptionSuggestInput
      id="desc"
      testIdPrefix="drawer"
      value={value}
      onChange={setValue}
      entries={entries}
      categoryId={categoryId}
      onPick={onPick}
      onEnter={onEnter}
      disabled={disabled}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
  )
}

function renderInput(props: HarnessProps = {}) {
  const onPick = vi.fn<PickFn>()
  const view = render(<Harness onPick={onPick} {...props} />)
  return { onPick, ...view }
}

const input = () => screen.getByTestId<HTMLInputElement>('drawer-description')
const options = () => screen.getAllByTestId('drawer-suggestion')
const optionTexts = () => options().map((o) => o.textContent)

function open() {
  fireEvent.focus(input())
}

describe('DescriptionSuggestInput: markup', () => {
  it('is an accessible combobox without a datalist', () => {
    const { container } = renderInput({ ariaLabel: 'Description' })

    const el = input()
    expect(el.getAttribute('role')).toBe('combobox')
    expect(el.getAttribute('aria-autocomplete')).toBe('list')
    expect(el.getAttribute('aria-expanded')).toBe('false')
    expect(el.getAttribute('aria-controls')).toBe('desc-listbox')
    expect(el.getAttribute('aria-label')).toBe('Description')
    expect(el.id).toBe('desc')
    expect(container.querySelector('datalist')).toBeNull()
    expect(el.getAttribute('list')).toBeNull()
  })

  it('passes placeholder, maxLength and disabled to the input', () => {
    renderInput({ placeholder: 'e.g. coffee', maxLength: 120, disabled: true })

    expect(input().placeholder).toBe('e.g. coffee')
    expect(input().maxLength).toBe(120)
    expect(input().disabled).toBe(true)
  })

  it('shows the controlled value', () => {
    renderInput({ initial: 'Tea' })

    expect(input().value).toBe('Tea')
  })

  it('renders no list until it is opened', () => {
    renderInput()

    expect(screen.queryByTestId('drawer-suggestions')).toBeNull()
  })
})

describe('DescriptionSuggestInput: opening and filtering', () => {
  it('opens on focus with the most frequent entries first', () => {
    renderInput()

    open()

    const list = screen.getByTestId('drawer-suggestions')
    expect(list.getAttribute('role')).toBe('listbox')
    expect(list.id).toBe('desc-listbox')
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(options().map((o) => o.getAttribute('role'))).toEqual([
      'option',
      'option',
      'option',
    ])
    expect(options()[0].textContent).toContain('Coffee')
    expect(options()[0].textContent).not.toContain('Coffee beans')
    expect(options()[1].textContent).toContain('Coffee beans')
    expect(options()[2].textContent).toContain('Lunch')
    expect(options().map((o) => o.id)).toEqual([
      'desc-option-0',
      'desc-option-1',
      'desc-option-2',
    ])
  })

  it('opens and filters when typing', () => {
    renderInput()

    fireEvent.change(input(), { target: { value: 'cof' } })

    expect(optionTexts()).toHaveLength(2)
    expect(options()[0].textContent).toContain('Coffee')
    expect(options()[1].textContent).toContain('Coffee beans')
  })

  it('narrows the list as the query gets longer', () => {
    renderInput()

    fireEvent.change(input(), { target: { value: 'coffee b' } })

    expect(optionTexts()).toHaveLength(1)
    expect(options()[0].textContent).toContain('Coffee beans')
  })

  it('renders no list when nothing matches', () => {
    renderInput()

    fireEvent.change(input(), { target: { value: 'zzz' } })

    expect(screen.queryByTestId('drawer-suggestions')).toBeNull()
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('renders no list when there are no entries', () => {
    renderInput({ entries: [] })

    open()

    expect(screen.queryByTestId('drawer-suggestions')).toBeNull()
  })

  it('shows at most 5 suggestions', () => {
    const many = Array.from({ length: 8 }, (_, i) => entry(`Item ${i}`, i + 1))
    renderInput({ entries: many })

    open()

    expect(options()).toHaveLength(5)
  })

  it('shows the amount hint of each suggestion', () => {
    renderInput()

    open()

    const hints = screen.getAllByTestId('drawer-suggestion-amount')
    expect(hints.map((h) => h.textContent)).toEqual([
      'last: 65 UAH',
      'last: 120 UAH',
      'last: 12.50 USD',
    ])
    expect(hints[0].getAttribute('aria-label')).toBe('Use amount 65 UAH')
    expect(hints[2].getAttribute('aria-label')).toBe('Use amount 12.50 USD')
  })

  it('puts the given category first', () => {
    renderInput({ categoryId: 'cat-food' })

    open()

    expect(options()[0].textContent).toContain('Coffee beans')
  })
})

describe('DescriptionSuggestInput: closing', () => {
  it('closes on blur', () => {
    renderInput()
    open()
    expect(screen.getByTestId('drawer-suggestions')).toBeTruthy()

    fireEvent.blur(input())

    expect(screen.queryByTestId('drawer-suggestions')).toBeNull()
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on Escape and prevents the default only while open', () => {
    renderInput()
    open()

    const notPrevented = fireEvent.keyDown(input(), { key: 'Escape' })

    expect(notPrevented).toBe(false)
    expect(screen.queryByTestId('drawer-suggestions')).toBeNull()

    const secondNotPrevented = fireEvent.keyDown(input(), { key: 'Escape' })
    expect(secondNotPrevented).toBe(true)
  })

  it('opens again when typing after it was closed', () => {
    renderInput()
    open()
    fireEvent.keyDown(input(), { key: 'Escape' })

    fireEvent.change(input(), { target: { value: 'lun' } })

    expect(optionTexts()).toHaveLength(1)
  })
})

describe('DescriptionSuggestInput: keyboard', () => {
  const selected = () => options().map((o) => o.getAttribute('aria-selected'))

  it('has no active option until an arrow key is pressed', () => {
    renderInput()
    open()

    expect(selected()).toEqual(['false', 'false', 'false'])
    expect(input().getAttribute('aria-activedescendant')).toBeNull()
  })

  it('ArrowDown activates the next option and exposes it as activedescendant', () => {
    renderInput()
    open()

    const notPrevented = fireEvent.keyDown(input(), { key: 'ArrowDown' })

    expect(notPrevented).toBe(false)
    expect(selected()).toEqual(['true', 'false', 'false'])
    expect(input().getAttribute('aria-activedescendant')).toBe('desc-option-0')

    fireEvent.keyDown(input(), { key: 'ArrowDown' })

    expect(selected()).toEqual(['false', 'true', 'false'])
    expect(input().getAttribute('aria-activedescendant')).toBe('desc-option-1')
  })

  it('wraps around in both directions', () => {
    renderInput()
    open()

    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(selected()).toEqual(['false', 'false', 'true'])

    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(selected()).toEqual(['true', 'false', 'false'])

    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(selected()).toEqual(['false', 'false', 'true'])
  })

  it('ArrowDown opens a closed list', () => {
    renderInput()
    open()
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByTestId('drawer-suggestions')).toBeNull()

    fireEvent.keyDown(input(), { key: 'ArrowDown' })

    expect(screen.getByTestId('drawer-suggestions')).toBeTruthy()
  })

  it('Enter picks the active option', () => {
    const { onPick } = renderInput()
    open()
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })

    const notPrevented = fireEvent.keyDown(input(), { key: 'Enter' })

    expect(notPrevented).toBe(false)
    expect(input().value).toBe('Coffee beans')
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0]).toMatchObject({
      description: 'Coffee beans',
      categoryId: 'cat-food',
      amount: 120,
      currency: 'UAH',
    })
    expect(onPick.mock.calls[0][1]).toEqual({ withAmount: false })
    expect(screen.queryByTestId('drawer-suggestions')).toBeNull()
  })

  it('Enter without an active option calls onEnter and prevents the default', () => {
    const onEnter = vi.fn()
    const { onPick } = renderInput({ onEnter })
    open()

    const notPrevented = fireEvent.keyDown(input(), { key: 'Enter' })

    expect(onEnter).toHaveBeenCalledTimes(1)
    expect(notPrevented).toBe(false)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('Enter without onEnter does not prevent the default (a form can submit)', () => {
    const { onPick } = renderInput()
    open()

    const notPrevented = fireEvent.keyDown(input(), { key: 'Enter' })

    expect(notPrevented).toBe(true)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('Enter with a closed list calls onEnter', () => {
    const onEnter = vi.fn()
    renderInput({ onEnter })

    fireEvent.keyDown(input(), { key: 'Enter' })

    expect(onEnter).toHaveBeenCalledTimes(1)
  })
})

describe('DescriptionSuggestInput: picking', () => {
  it('clicking an option sets the description and reports it without the amount', () => {
    const { onPick } = renderInput()
    open()

    fireEvent.click(options()[1])

    expect(input().value).toBe('Coffee beans')
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0]).toMatchObject({
      description: 'Coffee beans',
      amount: 120,
    })
    expect(onPick.mock.calls[0][1]).toEqual({ withAmount: false })
    expect(screen.queryByTestId('drawer-suggestions')).toBeNull()
  })

  it('clicking another option picks that one', () => {
    const { onPick } = renderInput()
    open()

    fireEvent.click(options()[2])

    expect(input().value).toBe('Lunch')
    expect(onPick.mock.calls[0][0]).toMatchObject({
      description: 'Lunch',
      currency: 'USD',
      amount: 12.5,
    })
  })

  it('clicking the hint chip picks with the amount, once', () => {
    const { onPick } = renderInput()
    open()

    fireEvent.click(screen.getAllByTestId('drawer-suggestion-amount')[0])

    expect(input().value).toBe('Coffee')
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0]).toMatchObject({
      description: 'Coffee',
      amount: 65,
      categoryId: 'cat-coffee',
    })
    expect(onPick.mock.calls[0][1]).toEqual({ withAmount: true })
    expect(screen.queryByTestId('drawer-suggestions')).toBeNull()
  })

  it('keeps the focus on the input by cancelling mousedown on options and chips', () => {
    renderInput()
    open()

    expect(fireEvent.mouseDown(options()[0])).toBe(false)
    expect(
      fireEvent.mouseDown(screen.getAllByTestId('drawer-suggestion-amount')[0]),
    ).toBe(false)
  })

  it('the hint chip is not a tab stop and does not submit a form', () => {
    renderInput()
    open()

    const chip = screen.getAllByTestId('drawer-suggestion-amount')[0]
    expect(chip.getAttribute('type')).toBe('button')
    expect(chip.getAttribute('tabindex')).toBe('-1')
  })
})
