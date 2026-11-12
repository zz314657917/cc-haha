import { cx } from '@/lib/cx'
import luoyeAiMark from '@/assets/luoyeai-mark.png'

/**
 * The 落叶AI mark — the app icon, rendered as a raster. The pixel-art robot
 * keeps its own colors under every theme on purpose: it is the same mark the
 * taskbar, installer and favicon show.
 */
export type BrandSealSize = 'sm' | 'md' | 'lg' | 'xl'

/** The sizes the layout calls for — collapsed rail 24, empty state 38–80. */
const SIZES: Record<BrandSealSize, string> = {
  sm: 'h-6 w-6',
  md: 'h-8 w-8',
  lg: 'h-[38px] w-[38px]',
  xl: 'h-20 w-20',
}

export type BrandSealProps = {
  size?: BrandSealSize
  className?: string
}

export function BrandSeal({ size = 'md', className }: BrandSealProps) {
  return (
    <img
      // Decorative: the product name sits next to the mark in the sidebar and
      // above it on the empty state, so announcing the brand twice is noise.
      src={luoyeAiMark}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cx('flex-shrink-0 select-none object-contain', SIZES[size], className)}
    />
  )
}
