import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * The single source of page width, side padding and default top spacing.
 * Header and SpaceBanner use PAGE_FRAME_CLASS so their edges match the page content.
 * A className passed to PageContainer may set vertical spacing and layout, never
 * max-w-*, px-* or mx-*.
 */
export type PageWidth = 'full' | 'reading'

export const PAGE_WIDTH_CLASS: Record<PageWidth, string> = {
  full: 'max-w-6xl',
  reading: 'max-w-2xl',
}

export const PAGE_GUTTER_CLASS = 'mx-auto px-4 md:px-8'

/** Full width plus gutter, token for token. */
export const PAGE_FRAME_CLASS = 'max-w-6xl mx-auto px-4 md:px-8'

export const PAGE_TOP_CLASS = 'pt-6'

export interface PageContainerProps extends ComponentPropsWithoutRef<'div'> {
  width?: PageWidth
}

export default function PageContainer({ width = 'full', className, ...rest }: PageContainerProps) {
  return (
    <div
      data-page-container={width}
      className={cn(PAGE_WIDTH_CLASS[width], PAGE_GUTTER_CLASS, PAGE_TOP_CLASS, className)}
      {...rest}
    />
  )
}
