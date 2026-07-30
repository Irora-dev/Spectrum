// The champion's crown (owner 2026-07-30) — the league is a race with ONE
// winner, so the leader wears a crown. Pixel-art on purpose: it matches the
// kit's dither/pixel language (the dither charts, the pixel rainbow) rather
// than importing a smooth vector emoji look.
//
// Drawn on a 9×7 pixel grid as flat rects, so it stays crisp at any size and
// carries no font/emoji dependency. Gold by default, with an optional idle
// shimmer that runs only where motion is welcome.

const GOLD = '#FFC53D'
const GOLD_DEEP = '#E8952B'
const GOLD_LIGHT = '#FFE08A'
const JEWEL = '#FF4DB8'

// One entry per lit pixel: [x, y, colour]. A 9-wide, 7-tall crown — three
// points with jewels, a banded base.
const PIXELS: [number, number, string][] = [
  // points (row 0) and their shoulders (row 1)
  [0, 0, GOLD], [4, 0, GOLD], [8, 0, GOLD],
  [0, 1, GOLD], [1, 1, GOLD_DEEP], [3, 1, GOLD_DEEP], [4, 1, GOLD], [5, 1, GOLD_DEEP], [7, 1, GOLD_DEEP], [8, 1, GOLD],
  // jewels sit in the valleys
  [2, 1, JEWEL], [6, 1, JEWEL],
  // body
  [0, 2, GOLD], [1, 2, GOLD], [2, 2, GOLD_LIGHT], [3, 2, GOLD], [4, 2, GOLD_LIGHT], [5, 2, GOLD], [6, 2, GOLD_LIGHT], [7, 2, GOLD], [8, 2, GOLD],
  [0, 3, GOLD], [1, 3, GOLD], [2, 3, GOLD], [3, 3, GOLD], [4, 3, GOLD], [5, 3, GOLD], [6, 3, GOLD], [7, 3, GOLD], [8, 3, GOLD],
  // jewelled band
  [0, 4, GOLD_DEEP], [1, 4, GOLD_DEEP], [2, 4, JEWEL], [3, 4, GOLD_DEEP], [4, 4, JEWEL], [5, 4, GOLD_DEEP], [6, 4, JEWEL], [7, 4, GOLD_DEEP], [8, 4, GOLD_DEEP],
  // base
  [0, 5, GOLD], [1, 5, GOLD_LIGHT], [2, 5, GOLD], [3, 5, GOLD], [4, 5, GOLD], [5, 5, GOLD], [6, 5, GOLD], [7, 5, GOLD_LIGHT], [8, 5, GOLD],
  [0, 6, GOLD_DEEP], [1, 6, GOLD_DEEP], [2, 6, GOLD_DEEP], [3, 6, GOLD_DEEP], [4, 6, GOLD_DEEP], [5, 6, GOLD_DEEP], [6, 6, GOLD_DEEP], [7, 6, GOLD_DEEP], [8, 6, GOLD_DEEP],
]

const COLS = 9
const ROWS = 7

export function PixelCrown({
  size = 18,
  className = '',
  title = 'Season leader',
  glow = true,
}: {
  /** Rendered height in px; width follows the 9:7 grid. */
  size?: number
  className?: string
  /** Tooltip + accessible label. Pass '' for a purely decorative instance. */
  title?: string
  glow?: boolean
}) {
  const cell = size / ROWS
  return (
    <svg
      viewBox={`0 0 ${COLS} ${ROWS}`}
      height={size}
      width={(size * COLS) / ROWS}
      className={`shrink-0 ${className}`}
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      style={glow ? { filter: `drop-shadow(0 0 ${Math.max(2, cell)}px rgba(255,197,61,0.45))` } : undefined}
    >
      {title && <title>{title}</title>}
      {PIXELS.map(([x, y, fill], i) => (
        // +0.02 overlap kills hairline seams between neighbouring pixels at
        // fractional scales without softening the pixel edges.
        <rect key={i} x={x} y={y} width={1.02} height={1.02} fill={fill} />
      ))}
    </svg>
  )
}
