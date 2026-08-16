import { Link } from 'react-router'
import { PROTOCOL_FEE_MODEL } from '../lib/spectrum/fee-model'
import brand from '../brand.config'
import { pageEnabled } from '../theme/brand'

// The launch funnel, planted inside the Explore flow: the page sells buying
// everywhere — this is the one card that sells CREATING. The fee share is
// computed from the protocol constant (never hand-typed — anti-drift rule).
export function LaunchCta() {
  const maxSharePct = PROTOCOL_FEE_MODEL.MAX_CREATOR_SHARE_BPS / 100
  // Never a dead door (QOL 2026-08-07): App.tsx page-gates /launch and
  // redirects it to the homepage where an operator has turned it off, so this
  // card was selling a destination that bounced. Self-gated rather than gated
  // at each call site — there are three, and a fourth would forget.
  if (!pageEnabled(brand.pages, 'launch')) return null
  return (
    <Link
      to="/create"
      className="group relative block overflow-hidden rounded-xl border border-white/12 bg-white/[0.02] transition-colors hover:border-white/25"
    >
      <div aria-hidden className="absolute inset-x-0 top-0 h-px" style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
      {/* quiet aurora, no WebGL — this card repeats in a list */}
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-violet/15 blur-3xl transition-opacity duration-300 group-hover:opacity-80" />
      <div aria-hidden className="pointer-events-none absolute -left-10 -bottom-16 h-36 w-36 rounded-full bg-cyan/10 blur-3xl" />

      {/* PHONE: centred, no description, more air (owner 2026-08-06 23:13:
          "the 'have a thesis, bundle it into a basket' needs to be centred,
          remove the description on that button, add padding around it").
          The fee line is the description he means — it is a 10px three-part
          mono string that wrapped to three lines under the headline on a
          phone, which is where the card stopped reading as a button at all.
          It stays at sm+, where it fits beside the CTA and does real work.
          Desktop layout is otherwise byte-identical. */}
      <div className="relative flex flex-col items-center justify-between gap-y-4 px-4 py-6 text-center sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6 sm:gap-y-3 sm:px-5 sm:py-4 sm:text-left">
        <div className="min-w-0">
          <div className="font-display text-base font-bold text-ink [text-wrap:balance]">
            Have a thesis? <span className="text-ink-dim">Bundle it into a basket in about a minute.</span>
          </div>
          <div className="mt-1 hidden font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint sm:block">
            creators keep up to {maxSharePct}% of basket fees · on every trade · forever onchain
          </div>
        </div>
        <span
          className="press inline-flex min-h-[36px] shrink-0 items-center rounded-xl px-4 py-2 font-display text-xs font-bold uppercase tracking-[0.12em] text-black transition-transform group-hover:scale-[1.02]"
          style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
        >
          Launch a basket →
        </span>
      </div>
    </Link>
  )
}
