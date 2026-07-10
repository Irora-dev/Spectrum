import { useId } from 'react'

// Amber → magenta → cyan gradient line — the spectrum identity, in miniature.
export function SpectralSparkline({ values, className = '' }: { values: number[]; className?: string }) {
  const raw = useId()
  const id = 'spk' + raw.replace(/[^a-zA-Z0-9]/g, '')
  if (!values || values.length < 2) {
    return <div className={`h-full w-full bg-white/[0.02] ${className}`} />
  }
  const W = 100
  const H = 40
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const pts = values.map(
    (v, i) => [(i / (values.length - 1)) * W, H - ((v - min) / range) * (H - 5) - 2.5] as const,
  )
  const line = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  const area = `0,${H} ${line} ${W},${H}`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`h-full w-full ${className}`} aria-hidden>
      <defs>
        <linearGradient id={`${id}-l`} x1="0" y1="0" x2="100%" y2="0">
          <stop offset="0%" stopColor="var(--color-amber)" />
          <stop offset="50%" stopColor="var(--color-magenta)" />
          <stop offset="100%" stopColor="var(--color-cyan)" />
        </linearGradient>
        <linearGradient id={`${id}-a`} x1="0" y1="0" x2="0" y2="100%">
          <stop offset="0%" stopColor="rgba(53,224,255,0.16)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${id}-a)`} />
      <polyline
        points={line}
        fill="none"
        stroke={`url(#${id}-l)`}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
