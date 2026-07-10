import { useId } from 'react'

// spectral stops (amber → magenta → violet → cyan → teal)
const SPEC: [number, number, number][] = [
  [255, 146, 72], [255, 77, 184], [123, 92, 255], [53, 224, 255], [52, 214, 196],
]
function specAt(t: number) {
  const x = Math.max(0, Math.min(1, t)) * (SPEC.length - 1)
  const i = Math.min(SPEC.length - 2, Math.floor(x))
  const f = x - i
  const a = SPEC[i]
  const b = SPEC[i + 1]
  const m = (k: number) => Math.round(a[k] + (b[k] - a[k]) * f)
  return `rgb(${m(0)},${m(1)},${m(2)})`
}

// prism triangle + rainbow light-rays converging at its centre
const TRI = 'M24 8 L41 38 L7 38 Z'
const CX = 24
const CY = 24
const BEAMS = [
  [11, 38], [18, 38], [24, 38], [30, 38], [37, 38], [33, 25], [38, 33], [15, 25], [10, 33],
].map(([x, y]) => ({ x, y, c: specAt((x - 7) / 34) }))

/** Spectrum prism: rays of refracted light converging inside, white outline. */
export function PrismMark({
  className = '',
  size = 32,
}: {
  className?: string
  size?: number
}) {
  const id = useId()
  const clip = `pc-${id}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      fill="none"
      aria-hidden
    >
      <defs>
        <clipPath id={clip}>
          <path d={TRI} />
        </clipPath>
      </defs>
      {/* dark prism interior so the light-rays glow */}
      <path d={TRI} fill="#0b0b12" />
      {/* rainbow rays of light, clipped inside the prism */}
      <g clipPath={`url(#${clip})`} strokeLinecap="round">
        {BEAMS.map((b, i) => (
          <line key={i} x1={CX} y1={CY} x2={b.x} y2={b.y} stroke={b.c} strokeWidth={1.9} />
        ))}
      </g>
      {/* white prism outline (thin) */}
      <path d={TRI} fill="none" stroke="#ffffff" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}
