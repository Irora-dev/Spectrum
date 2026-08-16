import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import {
  GRADIENT,
  MAX_CREATOR_PCT,
  MAX_FEE_PCT,
  MIN_FEE_PCT,
  NarrativeConverge,
  VersionUpdateCard,
  pct,
  useFeeSinks,
} from '../pages/SlashCreators'
import { pageEnabled } from '../theme/brand'
import brand from '../brand.config'

// ─────────────────────────────────────────────────────────────────────────────
// "Learn how this works" (R 2026-07-29 11:29; site-wide per the owner same day):
// the five-slide teaching walkthrough — the /creators marketing retold one
// idea per slide, reusing that page's own animated pieces (single source,
// zero copy drift). Born on /league; also opens from the home hero's
// Learn-more and any other surface that mounts it. Click anywhere off the
// card (or Esc) closes back to the host page. CTA links respect the
// operator's page toggles.
// COUNSEL-GATED framing rides along from /creators: fee figures derive from
// PROTOCOL_FEE_MODEL via the imported constants, never hand-typed.
// ─────────────────────────────────────────────────────────────────────────────

interface Slide {
  key: string
  eyebrow: string
  title: ReactNode
  body: ReactNode
  visual: ReactNode
}

function FeeSplitSlide({ onClose }: { onClose: () => void }) {
  // League-aware: on a league chain the carve is a real sink and the bar must
  // show it, or every other share reads overstated (kit audit).
  const { sinks } = useFeeSinks()
  return (
    <div className="mt-8">
      <div className="flex h-20 w-full overflow-hidden rounded-xl ring-1 ring-white/10">
        {sinks.map((s, i) => (
          <div
            key={s.key}
            className="relative flex flex-col items-center justify-center gap-0.5 overflow-hidden"
            style={{ width: `${s.frac * 100}%`, background: s.bg, boxShadow: 'inset -1px 0 0 rgba(7,7,11,0.55)' }}
            title={`${s.legend} · ${pct(s.frac)}%`}
          >
            <div aria-hidden className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0) 38%, rgba(0,0,0,0.2))' }} />
            <div aria-hidden className="bento-sheen absolute inset-0" style={{ backgroundImage: 'linear-gradient(115deg, transparent 44%, rgba(255,255,255,0.18) 50%, transparent 56%)', animationDuration: `${6 + i}s` }} />
            {s.frac >= 0.12 && (
              <>
                <span className="relative font-display text-[11px] font-bold uppercase tracking-wide" style={{ color: s.text }}>{s.short}</span>
                <span className="relative font-num text-sm font-bold tabular-nums" style={{ color: s.text }}>{pct(s.frac)}%</span>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {sinks.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5" style={{ borderColor: `${s.dot}66`, background: `${s.dot}14` }}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.dot }} />
            <span className="font-mono text-[11px] text-ink">{s.legend}</span>
            <span className="font-num text-[11px] font-semibold tabular-nums text-ink-dim">{pct(s.frac)}%</span>
          </span>
        ))}
      </div>
      {/* the Interface slice in the bar above is exactly what a referral link
          redirects (owner 2026-07-29: mention + link refer-and-earn here) —
          a redirected protocol slice, never an extra cost */}
      {pageEnabled(brand.pages, 'refer') && (
        <Link
          to="/earn"
          onClick={onClose}
          className="press group mt-4 flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 transition-colors hover:border-cyan/40"
        >
          <span className="min-w-0">
            <span className="font-display text-sm font-bold uppercase tracking-wide text-ink">Not launching? Refer and earn</span>
            <span className="mt-0.5 block text-sm leading-snug text-ink-dim">
              Share any basket with your link and the interface slice of the trades it brings pays you, at no extra cost to the trader.
            </span>
          </span>
          <span aria-hidden className="shrink-0 font-display text-xl text-cyan transition-transform group-hover:translate-x-1">→</span>
        </Link>
      )}
    </div>
  )
}

function LeaguePoolSlide({ poolUsd, onClose }: { poolUsd?: string; onClose: () => void }) {
  const stages: { label: string; sub: string }[] = [
    { label: 'Trade', sub: 'any basket' },
    { label: 'Pool', sub: 'a fee slice lands' },
    { label: 'Withdraw', sub: 'the crown earns live' },
  ]
  const leagueOn = pageEnabled(brand.pages, 'league')
  return (
    <div className="mt-8">
      {/* opened FROM /league we know the live pool; elsewhere the card links
          to the race instead of showing a placeholder figure */}
      {poolUsd ? (
        <div className="relative overflow-hidden rounded-2xl border border-teal/25 bg-teal/[0.04] p-8 text-center">
          <div aria-hidden className="pointer-events-none absolute -top-16 left-1/2 h-40 w-72 -translate-x-1/2 rounded-full bg-teal/15 blur-3xl" />
          <div className="relative font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Score to beat</div>
          <div className="relative mt-2 font-num text-5xl font-light tabular-nums text-teal">{poolUsd}</div>
          <div className="relative mt-1 font-mono text-[10px] text-ink-faint">out-earn it and the fees stream to you</div>
        </div>
      ) : leagueOn ? (
        <Link
          to="/league"
          onClick={onClose}
          className="press group relative flex items-center justify-between gap-4 overflow-hidden rounded-2xl border border-teal/25 bg-teal/[0.04] px-6 py-5 transition-colors hover:border-teal/50"
        >
          <div aria-hidden className="pointer-events-none absolute -top-16 left-1/3 h-40 w-72 -translate-x-1/2 rounded-full bg-teal/15 blur-3xl" />
          <div className="relative">
            <div className="font-display text-lg font-bold uppercase tracking-tight text-ink">See this season&rsquo;s race</div>
            <div className="mt-1 text-sm text-ink-dim">The live standings and who the fees are flowing to.</div>
          </div>
          <span aria-hidden className="relative font-display text-2xl text-teal transition-transform group-hover:translate-x-1">→</span>
        </Link>
      ) : null}
      <div className="mt-4 grid grid-cols-3 gap-2">
        {stages.map((st, i) => (
          <div key={st.label} className="relative rounded-xl border border-white/10 bg-white/[0.02] px-3 py-4 text-center">
            {i > 0 && (
              <span aria-hidden className="absolute -left-2 top-1/2 -translate-y-1/2 font-mono text-xs text-ink-faint">→</span>
            )}
            <div className="font-display text-sm font-bold uppercase tracking-wide text-ink">{st.label}</div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-faint">{st.sub}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function LaunchSlide({ onClose }: { onClose: () => void }) {
  return (
    <div className="mt-8 space-y-3">
      {pageEnabled(brand.pages, 'launch') && (
        <Link
          to="/create"
          onClick={onClose}
          className="press group flex items-center justify-between gap-4 rounded-2xl border border-cyan/40 bg-cyan/[0.07] px-6 py-5 transition-colors hover:border-cyan/70"
        >
          <div>
            <div className="font-display text-xl font-bold uppercase tracking-tight text-ink">Launch a basket</div>
            <div className="mt-1 text-sm text-ink-dim">Pick tokens, weight them, set your fee, deploy.</div>
          </div>
          <span aria-hidden className="font-display text-2xl text-cyan transition-transform group-hover:translate-x-1">→</span>
        </Link>
      )}
      {pageEnabled(brand.pages, 'creators') && (
        <Link
          to="/creators"
          onClick={onClose}
          className="press group flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.02] px-6 py-5 transition-colors hover:border-white/25"
        >
          <div>
            <div className="font-display text-base font-bold uppercase tracking-tight text-ink-dim group-hover:text-ink">Read the full creator pitch</div>
            <div className="mt-1 text-sm text-ink-faint">Live demos, the fee calculator, real baskets.</div>
          </div>
          <span aria-hidden className="font-display text-xl text-ink-faint transition-transform group-hover:translate-x-1">→</span>
        </Link>
      )}
    </div>
  )
}

export function LearnWalkthrough({
  poolUsd,
  closeLabel = 'Done',
  onClose,
}: {
  /** Live pool figure when the host page already has it (/league). */
  poolUsd?: string
  /** Last-slide dismiss label — the host page names itself ("Back to the league"). */
  closeLabel?: string
  onClose: () => void
}) {
  const [step, setStep] = useState(0)

  const slides: Slide[] = [
    {
      key: 'basket',
      eyebrow: 'The product',
      title: 'One buy, the whole narrative.',
      body: 'A basket is one token that holds many. Your audience backs a whole thesis in a single click, one standing bid across every token inside.',
      visual: <NarrativeConverge />,
    },
    {
      key: 'earn',
      eyebrow: 'How creators earn',
      title: (
        <>
          Set the fee. <span className="spectral-text">Keep a share.</span>
        </>
      ),
      body: `Every trade pays a fee between ${MIN_FEE_PCT}% and ${MAX_FEE_PCT}%. The creator chooses it at launch and keeps up to ${MAX_CREATOR_PCT}% of what remains after the fixed protocol slices, roughly a quarter of every fee, for as long as the basket trades.`,
      visual: <FeeSplitSlide onClose={onClose} />,
    },
    {
      key: 'versions',
      eyebrow: 'Stay current',
      title: 'Update it any time.',
      body: 'Ship a new version when your thesis moves. The old one stays live and redeemable, holders upgrade only if they choose to.',
      visual: <VersionUpdateCard />,
    },
    {
      key: 'league',
      eyebrow: 'This page',
      title: 'Every trade feeds the pool.',
      body: 'A slice of every basket trade goes to whoever is winning the league — and it goes to them the moment it happens, not at the end of anything. Generate more fees than the current crown-holder and the stream switches to you on the very next trade. Scores reset every 30 days; the crown carries over. No judges, no payout day, the chain is the scoreboard.',
      visual: <LeaguePoolSlide poolUsd={poolUsd} onClose={onClose} />,
    },
    {
      key: 'launch',
      eyebrow: 'Your move',
      title: 'Launch yours in about a minute.',
      body: 'Your creator page goes live automatically with your baskets and performance, and your first trade enters this season’s race.',
      visual: <LaunchSlide onClose={onClose} />,
    },
  ]
  const last = slides.length - 1
  const s = slides[step]

  // Esc closes; arrows step — like every other modal on the site, plus the
  // walkthrough affordance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') setStep((v) => Math.min(v + 1, last))
      if (e.key === 'ArrowLeft') setStep((v) => Math.max(v - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, last])

  return createPortal(
    // m-auto centering (not items-center): flex-centering a card taller than
    // the scroll container pushes overflow above the content origin where it
    // can't be scrolled to — the card's top sliver was unreachable on every
    // phone (mobile audit L). Height budgets the my-8 margins.
    <div className="fixed inset-0 z-[90] flex overflow-y-auto p-4" onClick={onClose}>
      <div className="fixed inset-0 bg-void/85 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="How the creator league works"
        onClick={(e) => e.stopPropagation()}
        className="search-pop relative m-auto flex h-[min(42rem,calc(100svh-6rem))] w-full max-w-2xl flex-col overflow-hidden rounded-3xl card-surface backdrop-blur-md"
      >
        <div aria-hidden className="h-1 w-full shrink-0" style={{ background: GRADIENT }} />

        <div className="flex items-start justify-between gap-4 px-6 pt-6 sm:px-8">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
            {s.eyebrow} · {step + 1}/{slides.length}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="press -mr-2 -mt-2 grid h-10 w-10 shrink-0 place-items-center rounded-lg text-ink-dim hover:bg-white/8 hover:text-ink"
          >
            ✕
          </button>
        </div>

        {/* the slide — keyed so each step enters fresh (and its animation restarts) */}
        <div key={s.key} className="min-h-0 flex-1 overflow-y-auto px-6 pb-2 sm:px-8">
          <h2 className="enter mt-2 font-display text-4xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-5xl" style={{ ['--enter-i' as string]: 0 }}>
            {s.title}
          </h2>
          <p className="enter mt-4 max-w-xl text-base leading-snug text-ink-dim [text-wrap:balance]" style={{ ['--enter-i' as string]: 1 }}>
            {s.body}
          </p>
          <div className="enter" style={{ ['--enter-i' as string]: 2 }}>{s.visual}</div>
        </div>

        <div className="mt-auto flex shrink-0 items-center justify-between gap-4 border-t border-white/10 bg-white/[0.02] px-6 py-4 sm:px-8">
          <button
            type="button"
            onClick={() => setStep((v) => Math.max(v - 1, 0))}
            className={`press rounded-lg px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim hover:bg-white/8 hover:text-ink ${step === 0 ? 'invisible' : ''}`}
          >
            ← Back
          </button>
          <div className="flex items-center gap-2" role="tablist" aria-label="Walkthrough steps">
            {slides.map((sl, i) => (
              <button
                key={sl.key}
                type="button"
                role="tab"
                aria-selected={i === step}
                aria-label={`Step ${i + 1}`}
                onClick={() => setStep(i)}
                className={`press h-2 rounded-full transition-all ${i === step ? 'w-6 bg-cyan' : 'w-2 bg-white/20 hover:bg-white/40'}`}
              />
            ))}
          </div>
          {step < last ? (
            <button
              type="button"
              onClick={() => setStep((v) => Math.min(v + 1, last))}
              className="press rounded-lg bg-cyan px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-black hover:opacity-90"
            >
              Next →
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="press rounded-lg border border-white/15 px-5 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
            >
              {closeLabel}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
