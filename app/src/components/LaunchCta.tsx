import { Link } from 'react-router-dom'
import { PROTOCOL_FEE_MODEL } from '../lib/spectrum/fee-model'

// The launch funnel, planted inside the Explore flow: the page sells buying
// everywhere — this is the one card that sells CREATING. The fee share is
// computed from the protocol constant (never hand-typed — anti-drift rule).
export function LaunchCta() {
  const maxSharePct = PROTOCOL_FEE_MODEL.MAX_CREATOR_SHARE_BPS / 100
  return (
    <Link
      to="/launch"
      className="group relative block overflow-hidden rounded-xl border border-white/12 bg-white/[0.02] transition-colors hover:border-white/25"
    >
      <div aria-hidden className="absolute inset-x-0 top-0 h-px" style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
      {/* quiet aurora, no WebGL — this card repeats in a list */}
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-violet/15 blur-3xl transition-opacity duration-300 group-hover:opacity-80" />
      <div aria-hidden className="pointer-events-none absolute -left-10 -bottom-16 h-36 w-36 rounded-full bg-cyan/10 blur-3xl" />

      <div className="relative flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <div className="font-display text-base font-bold text-ink">
            Have a thesis? <span className="text-ink-dim">Bundle it into a basket in about a minute.</span>
          </div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            creators keep up to {maxSharePct}% of basket fees · on every trade · forever onchain
          </div>
        </div>
        <span
          className="press shrink-0 rounded-xl px-4 py-2 font-display text-xs font-bold uppercase tracking-[0.12em] text-black transition-transform group-hover:scale-[1.02]"
          style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
        >
          Launch a basket →
        </span>
      </div>
    </Link>
  )
}
