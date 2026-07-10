import type { ReactNode } from 'react'

// A congratulatory "you did it" banner for completion screens (migration upgrade,
// sweep). On-brand spectral burst — expanding rings + a check — with a gradient
// headline and the amount gained. Compact by design so completion still fits the
// viewport. Motion respects prefers-reduced-motion (rings freeze).

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'
const TEAL = 'linear-gradient(90deg,var(--color-teal),var(--color-cyan))'

export function CompleteBanner({
  title,
  amount,
  subtitle,
  tone = 'spectral',
  txHref,
  children,
}: {
  title: string
  amount: string
  subtitle?: string
  tone?: 'spectral' | 'teal'
  txHref?: string
  children?: ReactNode
}) {
  const grad = tone === 'teal' ? TEAL : SPECTRAL
  const ring = tone === 'teal' ? 'border-teal/40' : 'border-cyan/40'
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/12 bg-white/[0.03] px-5 py-5 text-center">
      {/* spectral bloom */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-16 mx-auto h-40 w-40 rounded-full opacity-30 blur-3xl" style={{ background: grad }} />

      {/* burst: expanding rings + a check */}
      <div className="relative mx-auto grid h-16 w-16 place-items-center">
        <span aria-hidden className={`absolute inset-0 animate-ping rounded-full border ${ring} opacity-60 motion-reduce:animate-none`} style={{ animationDuration: '1.8s' }} />
        <span aria-hidden className={`absolute inset-2 animate-ping rounded-full border ${ring} opacity-40 motion-reduce:animate-none`} style={{ animationDuration: '2.4s' }} />
        <span className="relative grid h-12 w-12 place-items-center rounded-full text-black" style={{ background: grad }}>
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
        </span>
      </div>

      {/* The headline IS the moment — big (owner 2026-07-07 13:57). */}
      <h3 className="mt-3 font-display text-3xl font-bold uppercase tracking-tight text-transparent sm:text-4xl" style={{ backgroundImage: grad, WebkitBackgroundClip: 'text', backgroundClip: 'text' }}>
        {title}
      </h3>
      <div className="mt-1.5 font-num text-2xl font-semibold tabular-nums text-ink sm:text-3xl">{amount}</div>
      {subtitle && <p className="mt-1.5 text-sm leading-relaxed text-ink-dim">{subtitle}</p>}
      {txHref && (
        <a href={txHref} target="_blank" rel="noreferrer" className="mt-2 inline-block font-mono text-[10px] text-cyan hover:underline">
          view tx ↗
        </a>
      )}
      {children}
    </div>
  )
}
