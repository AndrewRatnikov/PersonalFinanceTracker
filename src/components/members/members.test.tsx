// CONTRACT_GAP: the chip colour (inline background from the member colour
//   token) is not asserted; jsdom does not reliably keep var() values.
// CONTRACT_GAP: MemberBreakdown with no rows is not specified; not tested.
// CONTRACT_GAP: the pending state of MoveConfirmDialog is asserted as "the
//   confirm button is disabled"; the plan only names the prop.
//
// Small components of the Family UX: MemberChip, MemberFilter, PaidBySelect,
// MemberSummaryCard, MemberBreakdown, MoveConfirmDialog.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'

import type { Expense } from '@/lib/domain'
import { formatMoney } from '@/i18n/format'
import { plural, setLang, translate } from '@/i18n/core'
import { buildMemberDirectory } from '@/lib/memberStats'
import { MemberBreakdown } from '@/components/analytics/MemberBreakdown'
import { MemberSummaryCard } from '@/components/index/MemberSummaryCard'
import { MemberChip } from '@/components/members/MemberChip'
import { MemberFilter } from '@/components/members/MemberFilter'
import { PaidBySelect } from '@/components/members/PaidBySelect'
import { MoveConfirmDialog } from '@/components/space/MoveConfirmDialog'

const PROFILES = [
  { id: 'u-me', displayName: 'Andrii', color: 'var(--chart-1)' },
  { id: 'u-olena', displayName: 'Olena Koval', color: 'var(--chart-2)' },
  { id: 'u-taras', displayName: 'Taras', color: 'var(--chart-3)' },
  { id: 'u-ivan', displayName: 'Ivan', color: 'var(--chart-4)' },
  { id: 'u-left', displayName: 'Maksym', color: 'var(--chart-5)' },
]
const ACTIVE = ['u-me', 'u-olena', 'u-taras', 'u-ivan']
const DIR = buildMemberDirectory(PROFILES, ACTIVE, 'u-me')

beforeEach(() => setLang('en', { persist: false }))
afterEach(() => {
  cleanup()
  setLang('en', { persist: false })
})

describe('MemberChip', () => {
  it('shows the initials with the name as tooltip and accessible label', () => {
    render(<MemberChip memberId="u-olena" directory={DIR} />)

    const chip = screen.getByTestId('member-chip')
    expect(chip.textContent.trim()).toBe('OK')
    expect(chip.getAttribute('title')).toBe('Olena Koval')
    expect(chip.getAttribute('aria-label')).toBe('Olena Koval')
    expect(chip.getAttribute('data-member-id')).toBe('u-olena')
  })

  it('works for a former member that still has a profile', () => {
    render(<MemberChip memberId="u-left" directory={DIR} />)

    expect(screen.getByTestId('member-chip').getAttribute('aria-label')).toBe('Maksym')
    expect(screen.getByTestId('member-chip').textContent.trim()).toBe('M')
  })

  it('an id without a profile reads as Former member', () => {
    render(<MemberChip memberId="u-ghost" directory={DIR} />)

    const chip = screen.getByTestId('member-chip')
    expect(chip.getAttribute('aria-label')).toBe(translate('en', 'members.formerMember'))
    expect(chip.getAttribute('title')).toBe(translate('en', 'members.formerMember'))
    expect(chip.getAttribute('data-member-id')).toBe('u-ghost')
  })

  it('two members give two different chips', () => {
    render(
      <>
        <MemberChip memberId="u-me" directory={DIR} />
        <MemberChip memberId="u-taras" directory={DIR} />
      </>,
    )

    const chips = screen.getAllByTestId('member-chip')
    expect(chips[0].textContent).not.toBe(chips[1].textContent)
    expect(chips[0].getAttribute('data-member-id')).not.toBe(chips[1].getAttribute('data-member-id'))
  })
})

describe('MemberFilter', () => {
  const options = [
    { value: 'all', label: 'All members' },
    { value: 'u-me', label: 'Andrii' },
    { value: 'u-left', label: 'Maksym (left)' },
  ]

  it('is a native select labelled Member with the given options', () => {
    render(<MemberFilter value="all" onChange={() => undefined} options={options} />)

    const select = screen.getByTestId<HTMLSelectElement>('member-filter')
    expect(select.tagName).toBe('SELECT')
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual(
      options.map((o) => [o.value, o.label]),
    )
    expect(screen.getByLabelText(translate('en', 'members.member'))).toBe(select)
  })

  it('shows the value and reports changes', () => {
    const onChange = vi.fn()
    render(<MemberFilter value="u-left" onChange={onChange} options={options} />)

    const select = screen.getByTestId<HTMLSelectElement>('member-filter')
    expect(select.value).toBe('u-left')
    fireEvent.change(select, { target: { value: 'u-me' } })
    expect(onChange).toHaveBeenCalledWith('u-me')
  })
})

describe('PaidBySelect', () => {
  it('lists the active members by name and not former ones', () => {
    render(
      <PaidBySelect value="u-me" onChange={() => undefined} label="Paid by" directory={DIR} memberId="u-me" />,
    )

    const select = screen.getByTestId<HTMLSelectElement>('paid-by-select')
    expect(Array.from(select.options).map((o) => o.value).sort()).toEqual(['u-ivan', 'u-me', 'u-olena', 'u-taras'])
    expect(Array.from(select.options).find((o) => o.value === 'u-olena')?.textContent).toBe('Olena Koval')
    expect(select.value).toBe('u-me')
    expect(screen.getByLabelText('Paid by')).toBe(select)
  })

  it('reports the chosen member', () => {
    const onChange = vi.fn()
    render(<PaidBySelect value="u-me" onChange={onChange} label="Paid by" directory={DIR} memberId="u-me" />)

    fireEvent.change(screen.getByTestId('paid-by-select'), { target: { value: 'u-olena' } })

    expect(onChange).toHaveBeenCalledWith('u-olena')
  })

  it('keeps the current payer when that member has left, so an edit never changes it silently', () => {
    render(
      <PaidBySelect value="u-left" onChange={() => undefined} label="Paid by" directory={DIR} memberId="u-me" />,
    )

    const select = screen.getByTestId<HTMLSelectElement>('paid-by-select')
    expect(select.value).toBe('u-left')
    expect(Array.from(select.options).map((o) => o.value)).toContain('u-left')
  })

  it('adds "You" for me when I have no active profile', () => {
    const dir = buildMemberDirectory(PROFILES, ACTIVE, 'u-new')
    render(<PaidBySelect value="u-new" onChange={() => undefined} label="Paid by" directory={dir} memberId="u-new" />)

    const select = screen.getByTestId<HTMLSelectElement>('paid-by-select')
    const mine = Array.from(select.options).find((o) => o.value === 'u-new')
    expect(mine?.textContent).toBe(translate('en', 'members.you'))
  })

  it('can be disabled', () => {
    render(
      <PaidBySelect value="u-me" onChange={() => undefined} label="Paid by" directory={DIR} memberId="u-me" disabled />,
    )

    expect(screen.getByTestId<HTMLSelectElement>('paid-by-select').disabled).toBe(true)
  })

  it('uses the label it is given (Received by)', () => {
    render(
      <PaidBySelect
        value="u-me"
        onChange={() => undefined}
        label={translate('en', 'members.receivedBy')}
        directory={DIR}
        memberId="u-me"
      />,
    )

    expect(screen.getByLabelText('Received by')).toBe(screen.getByTestId('paid-by-select'))
  })
})

describe('MemberSummaryCard', () => {
  const now = new Date(2026, 9, 20, 12, 0, 0)

  function e(id: string, amount: number, paidBy: string | undefined, date: Date): Expense {
    return {
      id,
      amount,
      currency: 'UAH',
      categoryId: 'cat-food',
      createdAt: date.toISOString(),
      ...(paidBy === undefined ? {} : { paidBy }),
    }
  }

  const thisMonth = new Date(2026, 9, 5, 12, 0, 0)
  const lastMonth = new Date(2026, 8, 5, 12, 0, 0)

  it('shows this month per member, top 3, then +N for the rest', () => {
    render(
      <MemberSummaryCard
        expenses={[
          e('1', 12400, 'u-me', thisMonth),
          e('2', 9800, 'u-olena', thisMonth),
          e('3', 500, 'u-taras', thisMonth),
          e('4', 300, 'u-ivan', thisMonth),
          e('5', 100, 'u-left', thisMonth),
        ]}
        directory={DIR}
        mainCurrency="UAH"
        now={now}
      />,
    )

    const card = screen.getByTestId('family-month-card')
    expect(card.textContent).toContain(translate('en', 'members.thisMonth'))
    expect(screen.getByTestId('family-month-member-u-me').textContent).toBe(`Andrii ${formatMoney(12400, 'UAH')}`)
    expect(screen.getByTestId('family-month-member-u-olena').textContent).toBe(
      `Olena Koval ${formatMoney(9800, 'UAH')}`,
    )
    expect(screen.getByTestId('family-month-member-u-taras')).toBeTruthy()
    expect(screen.queryByTestId('family-month-member-u-ivan')).toBeNull()
    expect(screen.queryByTestId('family-month-member-u-left')).toBeNull()
    expect(screen.getByTestId('family-month-more').textContent).toBe(translate('en', 'members.more', { count: 2 }))
  })

  it('has no +N with three members or fewer', () => {
    render(
      <MemberSummaryCard
        expenses={[e('1', 100, 'u-me', thisMonth), e('2', 50, 'u-olena', thisMonth)]}
        directory={DIR}
        mainCurrency="UAH"
        now={now}
      />,
    )

    expect(screen.getAllByTestId(/^family-month-member-/)).toHaveLength(2)
    expect(screen.queryByTestId('family-month-more')).toBeNull()
  })

  it('counts only the current local month', () => {
    render(
      <MemberSummaryCard
        expenses={[e('1', 100, 'u-me', thisMonth), e('2', 5000, 'u-olena', lastMonth)]}
        directory={DIR}
        mainCurrency="UAH"
        now={now}
      />,
    )

    expect(screen.getByTestId('family-month-member-u-me')).toBeTruthy()
    expect(screen.queryByTestId('family-month-member-u-olena')).toBeNull()
  })

  it('renders nothing when nothing was spent this month', () => {
    const { container } = render(
      <MemberSummaryCard expenses={[e('1', 5000, 'u-olena', lastMonth)]} directory={DIR} mainCurrency="UAH" now={now} />,
    )

    expect(screen.queryByTestId('family-month-card')).toBeNull()
    expect(container.innerHTML).toBe('')
  })
})

describe('MemberBreakdown', () => {
  const rows = [
    { memberId: 'u-me', total: 6000, share: 0.6, averagePerMonth: 3000 },
    { memberId: 'u-olena', total: 3000, share: 0.3, averagePerMonth: 1500 },
    { memberId: 'u-ghost', total: 1000, share: 0.1, averagePerMonth: 500 },
  ]

  it.each(['expense', 'income'] as const)('renders a row per member for %s with total, share and average', (kind) => {
    render(<MemberBreakdown kind={kind} rows={rows} directory={DIR} mainCurrency="UAH" />)

    expect(screen.getByTestId(`analytics-members-${kind}`)).toBeTruthy()
    const me = screen.getByTestId(`analytics-member-${kind}-u-me`)
    expect(me.textContent).toContain('Andrii')
    expect(within(me).getByTestId(`analytics-member-total-${kind}-u-me`).textContent).toBe(formatMoney(6000, 'UAH'))
    expect(within(me).getByTestId(`analytics-member-share-${kind}-u-me`).textContent).toBe('60%')
    expect(within(me).getByTestId(`analytics-member-average-${kind}-u-me`).textContent).toBe(
      translate('en', 'members.perMonth', { amount: formatMoney(3000, 'UAH') }),
    )
    expect(screen.getByTestId(`analytics-member-share-${kind}-u-olena`).textContent).toBe('30%')
    expect(screen.getByTestId(`analytics-member-total-${kind}-u-olena`).textContent).toBe(formatMoney(3000, 'UAH'))
  })

  it('names a member without a profile Former member', () => {
    render(<MemberBreakdown kind="expense" rows={rows} directory={DIR} mainCurrency="UAH" />)

    expect(screen.getByTestId('analytics-member-expense-u-ghost').textContent).toContain(
      translate('en', 'members.formerMember'),
    )
  })

  it('rounds the share to a whole percent', () => {
    render(
      <MemberBreakdown
        kind="expense"
        rows={[{ memberId: 'u-me', total: 100, share: 1 / 3, averagePerMonth: 100 }]}
        directory={DIR}
        mainCurrency="UAH"
      />,
    )

    expect(screen.getByTestId('analytics-member-share-expense-u-me').textContent).toBe('33%')
  })
})

describe('MoveConfirmDialog', () => {
  function renderDialog(props: Partial<ComponentProps<typeof MoveConfirmDialog>> = {}) {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <MoveConfirmDialog
        open
        onOpenChange={onOpenChange}
        count={3}
        direction="to-family"
        familyName="Our home"
        onConfirm={onConfirm}
        {...props}
      />,
    )
    return { onConfirm, onOpenChange }
  }

  it('to Family: lists the count and says everyone in the Family will see them', () => {
    renderDialog()

    expect(screen.getByTestId('move-confirm-dialog')).toBeTruthy()
    expect(screen.getByTestId('move-confirm-title').textContent).toBe(
      plural('move.titleToFamily', 3, { name: 'Our home' }),
    )
    expect(screen.getByTestId('move-confirm-text').textContent).toBe(
      translate('en', 'move.bodyToFamily', { name: 'Our home' }),
    )
    expect(screen.getByTestId('move-confirm-text').textContent).toContain('Everyone in Our home will see these')
  })

  it('to Personal: says it removes them from the Family for everyone', () => {
    renderDialog({ direction: 'to-personal', count: 1 })

    expect(screen.getByTestId('move-confirm-title').textContent).toBe(
      plural('move.titleToPersonal', 1, { name: 'Our home' }),
    )
    expect(screen.getByTestId('move-confirm-text').textContent).toContain(
      'This removes them from Our home for everyone',
    )
  })

  it('the singular and plural titles differ', () => {
    const one = plural('move.titleToFamily', 1, { name: 'Our home' })
    const many = plural('move.titleToFamily', 5, { name: 'Our home' })

    expect(one).not.toBe(many)
  })

  it('Move confirms and Cancel closes without confirming', () => {
    const { onConfirm, onOpenChange } = renderDialog()

    fireEvent.click(screen.getByTestId('move-cancel-btn'))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)

    fireEvent.click(screen.getByTestId('move-confirm-btn'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when closed', () => {
    renderDialog({ open: false })

    expect(screen.queryByTestId('move-confirm-dialog')).toBeNull()
  })

  it('disables the confirm button while pending', () => {
    renderDialog({ pending: true })

    expect(screen.getByTestId<HTMLButtonElement>('move-confirm-btn').disabled).toBe(true)
  })
})
