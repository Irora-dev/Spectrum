import { createPortal } from 'react-dom'
import type { CSSProperties, ReactNode } from 'react'

// Fixed-position portal for hover cards. Rows and cards across the site sit in
// staggered-entrance wrappers (`.enter`) whose filter values make each one its
// own stacking context — an in-flow popover paints UNDER later siblings no
// matter its z-index. Portaling to <body> escapes all of it: always on top,
// clamped to the viewport, flipping upward near the fold.
export function HoverPortal({
  anchor,
  children,
  width = 210,
  estHeight = 200,
}: {
  /** The hovered element's getBoundingClientRect(). */
  anchor: DOMRect
  children: ReactNode
  /** Approximate card width/height, for clamping + the upward flip. */
  width?: number
  estHeight?: number
}) {
  const flipUp = anchor.bottom + estHeight > window.innerHeight
  const style: CSSProperties = {
    position: 'fixed',
    left: Math.min(Math.max(anchor.left + anchor.width / 2, 8 + width / 2), window.innerWidth - 8 - width / 2),
    top: flipUp ? undefined : anchor.bottom + 8,
    bottom: flipUp ? window.innerHeight - anchor.top + 8 : undefined,
    transform: 'translateX(-50%)',
    zIndex: 80,
    pointerEvents: 'none',
  }
  return createPortal(
    <div style={style} className="w-max">
      {children}
    </div>,
    document.body,
  )
}
