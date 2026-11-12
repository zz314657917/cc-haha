import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { BrandSeal } from './BrandSeal'

const SIZES = ['sm', 'md', 'lg', 'xl'] as const

describe('BrandSeal', () => {
  it('is decorative and hidden from assistive tech', () => {
    // The product name always sits beside the mark (sidebar) or under it
    // (empty state); announcing the brand again reads it twice.
    const { container } = render(<BrandSeal />)
    const img = container.querySelector('img')!
    expect(img).toHaveAttribute('aria-hidden', 'true')
    expect(img).toHaveAttribute('alt', '')
  })

  it('renders the bundled app mark as a distinct square at every size step', () => {
    const heights = new Set<string>()
    for (const size of SIZES) {
      const { container, unmount } = render(<BrandSeal size={size} />)
      const img = container.querySelector('img')!
      expect(img.getAttribute('src')).toMatch(/luoyeai-mark/)
      const height = img.className.match(/\bh-(\S+)/)?.[1]
      const width = img.className.match(/\bw-(\S+)/)?.[1]
      expect(height).toBe(width)
      heights.add(height!)
      unmount()
    }
    expect(heights.size).toBe(SIZES.length)
  })

  it('cannot be dragged out of the chrome as a stray image', () => {
    const { container } = render(<BrandSeal size="sm" />)
    expect(container.querySelector('img')).toHaveAttribute('draggable', 'false')
  })
})
