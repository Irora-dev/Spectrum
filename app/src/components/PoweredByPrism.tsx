// "Powered by Prism" — a small ecosystem banner linking out to PrismBeat
// (owner ask 2026-07-30). Placed on a few pages where the protocol's PRISM
// leg is visible (Home, basket page, fees/burn, swap). Same posture as the
// PrismMark glyph in Nav: optional chrome — operators may keep or drop it
// when rebranding.

import brand from '../brand.config'
import { prismCreditEnabled } from '../theme/brand'

const PRISMBEAT_URL = 'https://www.prismbeat.xyz'

// PrismBeat's pixel-art rainbow brand mark (ported from the PrismBeat site,
// static form — no entry animation, no glow — exactly how its own nav uses it).
// Concentric pixel rings, one per spectrum band.
const BANDS = ['#ff5a5a', '#ff9f45', '#ffe14d', '#5cff8f', '#3bd9ff', '#7c8bff', '#c06aff']

export function PixelRainbow({ className = '', cell = 6 }: { className?: string; cell?: number }) {
  const gap = cell * 0.2
  const R = 9 // outer radius (red)
  const INNER = 3 // inner radius (violet)
  const cols = R * 2 + 1
  const rows = R + 1
  const cells: { x: number; y: number; c: string }[] = []
  for (let x = -R; x <= R; x++) {
    for (let y = 0; y <= R; y++) {
      const d = Math.round(Math.hypot(x, y))
      if (d < INNER || d > R) continue
      cells.push({ x, y, c: BANDS[R - d] })
    }
  }
  return (
    <svg viewBox={`0 0 ${cols * cell} ${rows * cell}`} className={className} aria-hidden>
      {cells.map((p, i) => (
        <rect
          key={i}
          x={(p.x + R) * cell + gap / 2}
          y={(rows - 1 - p.y) * cell + gap / 2}
          width={cell - gap}
          height={cell - gap}
          rx={cell * 0.18}
          fill={p.c}
        />
      ))}
    </svg>
  )
}

export function PoweredByPrism({ className = '' }: { className?: string }) {
  // Operator-droppable (kit config): this is an outbound third-party link on
  // THEIR site. Self-hiding so hosts don't each need the gate.
  if (!prismCreditEnabled(brand)) return null
  return (
    <a
      href={PRISMBEAT_URL}
      target="_blank"
      rel="noreferrer"
      className={`press group inline-flex items-center gap-2.5 rounded-full border border-white/10 bg-white/[0.03] py-2 pl-4 pr-3.5 transition-colors hover:border-white/25 hover:bg-white/[0.05] ${className}`}
    >
      <PixelRainbow className="h-4 w-auto" />
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-dim transition-colors group-hover:text-ink">
        Powered by Prism
      </span>
      <svg
        viewBox="0 0 24 24"
        className="h-3 w-3 text-ink-faint transition-all group-hover:translate-x-px group-hover:-translate-y-px group-hover:text-ink-dim"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M7 17L17 7M7 7h10v10" />
      </svg>
    </a>
  )
}
