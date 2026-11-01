// No CONTRACT_GAPs: PageContainer's props, constants, DOM marker and class
// merge are fully specified in the Interface Contract (component: PageContainer).
// jsdom has no layout, so everything is asserted on class tokens.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import PageContainer, {
  PAGE_FRAME_CLASS,
  PAGE_GUTTER_CLASS,
  PAGE_TOP_CLASS,
  PAGE_WIDTH_CLASS,
} from '@/components/PageContainer'

const tokens = (value: string) => value.split(/\s+/).filter(Boolean)

function classesOf(testId: string): Array<string> {
  return tokens(screen.getByTestId(testId).className)
}

afterEach(() => {
  cleanup()
})

describe('PageContainer constants', () => {
  it('has the exact values from the contract', () => {
    expect(PAGE_WIDTH_CLASS).toEqual({ full: 'max-w-6xl', reading: 'max-w-2xl' })
    expect(PAGE_GUTTER_CLASS).toBe('mx-auto px-4 md:px-8')
    expect(PAGE_TOP_CLASS).toBe('pt-6')
    expect(PAGE_FRAME_CLASS).toBe('max-w-6xl mx-auto px-4 md:px-8')
  })

  it('PAGE_FRAME_CLASS is the full width plus the gutter, token for token', () => {
    expect(tokens(PAGE_FRAME_CLASS)).toEqual([
      ...tokens(PAGE_WIDTH_CLASS.full),
      ...tokens(PAGE_GUTTER_CLASS),
    ])
  })

  it('the reading width differs from the full width', () => {
    expect(PAGE_WIDTH_CLASS.reading).not.toBe(PAGE_WIDTH_CLASS.full)
  })
})

describe('PageContainer', () => {
  it('defaults to the full width, the gutter and the top spacing', () => {
    render(<PageContainer data-testid="page-container-sample">content</PageContainer>)

    const classes = classesOf('page-container-sample')
    for (const token of ['max-w-6xl', 'mx-auto', 'px-4', 'md:px-8', 'pt-6']) {
      expect(classes, token).toContain(token)
    }
    expect(classes).not.toContain('max-w-2xl')
    expect(screen.getByTestId('page-container-sample').getAttribute('data-page-container')).toBe(
      'full',
    )
  })

  it('width="reading" swaps max-w-6xl for max-w-2xl and keeps the same gutter and top spacing', () => {
    render(
      <PageContainer width="reading" data-testid="page-container-sample">
        content
      </PageContainer>,
    )

    const classes = classesOf('page-container-sample')
    expect(classes).toContain('max-w-2xl')
    expect(classes).not.toContain('max-w-6xl')
    for (const token of ['mx-auto', 'px-4', 'md:px-8', 'pt-6']) {
      expect(classes, token).toContain(token)
    }
    expect(screen.getByTestId('page-container-sample').getAttribute('data-page-container')).toBe(
      'reading',
    )
  })

  it('the two widths render different max-w classes', () => {
    const { unmount } = render(<PageContainer data-testid="page-container-sample" />)
    const full = classesOf('page-container-sample').filter((c) => c.startsWith('max-w-'))
    unmount()
    render(<PageContainer width="reading" data-testid="page-container-sample" />)
    const reading = classesOf('page-container-sample').filter((c) => c.startsWith('max-w-'))

    expect(full).toEqual(['max-w-6xl'])
    expect(reading).toEqual(['max-w-2xl'])
  })

  it('a vertical className replaces pt-6 (twMerge) and keeps width and gutter', () => {
    render(
      <PageContainer
        data-testid="page-container-sample"
        className="py-4 md:py-8 min-h-screen"
      />,
    )

    const classes = classesOf('page-container-sample')
    expect(classes).toContain('py-4')
    expect(classes).toContain('md:py-8')
    expect(classes).toContain('min-h-screen')
    expect(classes).not.toContain('pt-6')
    for (const token of tokens(PAGE_FRAME_CLASS)) expect(classes, token).toContain(token)
  })

  it('without a className override pt-6 stays', () => {
    render(<PageContainer data-testid="page-container-sample" className="flex flex-col gap-8" />)

    const classes = classesOf('page-container-sample')
    expect(classes).toContain('pt-6')
    expect(classes).toContain('flex')
    expect(classes).toContain('gap-8')
  })

  it('spreads data-testid, aria-busy and children onto the one div', () => {
    const { container } = render(
      <PageContainer data-testid="page-container-sample" aria-busy="true">
        <span data-testid="page-container-sample">hello</span>
      </PageContainer>,
    )

    const root = container.firstElementChild
    expect(root?.tagName).toBe('DIV')
    expect(container.children).toHaveLength(1)
    expect(root?.getAttribute('aria-busy')).toBe('true')
    expect(root?.textContent).toBe('hello')
    expect(root?.getAttribute('data-testid')).toBe('page-container-sample')
  })

  it('does not set aria-busy unless asked', () => {
    render(<PageContainer data-testid="page-container-sample" />)

    expect(screen.getByTestId('page-container-sample').getAttribute('aria-busy')).toBeNull()
  })
})
