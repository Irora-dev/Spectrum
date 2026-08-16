import type { CSSProperties } from 'react'
import { Link, useSearchParams } from 'react-router'
import { BasketBuilder } from '../components/launch/BasketBuilder'
import { ResumeLaunchCard } from '../components/launch/ResumeLaunchCard'
import { Composer, parseChainParam } from './Composer'

// ─────────────────────────────────────────────────────────────────────────────
// /create — THE creation route (owner 2026-08-12: "/launch needs to be replaced
// with /create for the basket migration system and creating a basket/bundle").
//
// One route, two faces, zero new machinery:
//   · bare /create → the Composer wearing its CREATE face (owner 2026-08-12:
//     "it should show the nice create system we had before where you selected
//     any asset and then you saw the bento grid and could click on an asset
//     and reshape it by dragging the slider" — picker → bento mix → publish;
//     no backtest/forecast/templates chrome, that bench lives on at /compose).
//     Picks that span one network launch a basket (the real BasketBuilder in
//     its dialog); picks that span several derive a BUNDLE and publish through
//     the ceremony. This is the owner's 2026-08-11 condensation ruling —
//     /create is the default for creating both.
//   · /create?from=<basket>&chain=<id> → the full-page studio in VERSION mode:
//     the migration system's door (VersionButton, the reshape modal's studio
//     link, the portfolio's remix door) — BasketBuilder seeded from the
//     predecessor, deploying a new immutable version.
//   · /create?studio=1 → the same full-page studio, fresh mode (the composer
//     dialog's "Open full page" escape + the seeded-draft handoffs; the
//     builder restores the draft keyed to the active chain).
//
// /launch is a query-preserving redirect here — old links keep working, but
// nothing advertises it (one name, one tab).
// ─────────────────────────────────────────────────────────────────────────────

export function Create() {
  const [params] = useSearchParams()
  const from = params.get('from') ?? undefined
  // parseChainParam (the Composer's table-driven parser, ONE implementation),
  // not Number(): an alias ("rh") or unsupported value silently fell back to
  // the ACTIVE chain and mis-resolved the predecessor's legs there — the exact
  // wrong-chain probe the builder's version-mode pin exists to prevent
  // (pre-existing, fixed 2026-08-10).
  const fromChain = parseChainParam(params.get('chain')) ?? undefined
  const isVersion = !!from
  const studio = isVersion || params.get('studio') != null

  // THE SECOND RESUME SURFACE the 2026-08-13 ruling names — "you should always
  // be able to resume from your creator page or /create". Above the composer,
  // because an unfinished launch outranks starting another one.
  //
  // `composerDraftRestoredHere`: the create face restores its OWN composer
  // draft on mount, so offering to "continue" it here would be a card pointing
  // at the screen it is sitting on. What it still surfaces is everything the
  // Composer cannot — a studio draft left on another chain, and any basket
  // already deployed that is not yet seeded or written. Self-hiding: with
  // nothing outstanding it renders nothing at all.
  if (!studio)
    return (
      <>
        <ResumeLaunchCard composerDraftRestoredHere className="mb-6" />
        <Composer face="create" />
      </>
    )

  return (
    <div className="space-y-8">
      <header className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl border border-white/10 bg-white/[0.02] px-6 py-8 backdrop-blur-md sm:px-8 sm:py-9">
        {/* aurora */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute -left-20 -top-24 h-64 w-64 rounded-full bg-cyan/15 blur-[110px]" />
          <div className="absolute right-0 -top-16 h-56 w-56 rounded-full bg-violet/15 blur-[120px]" />
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
        </div>

        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-10">
          <div className="enter" style={{ '--enter-i': 0 } as CSSProperties}>
            {/* bespoke layout, canonical type (see PageHeader — lg tier) */}
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
              {isVersion ? 'New version' : 'Create a basket'}
            </div>
            <h1 className="mt-3 font-display text-5xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-6xl">
              {isVersion ? (
                <>New<br />Version</>
              ) : (
                <>Create<br />a Basket</>
              )}
            </h1>
          </div>
          <div className="enter flex flex-col items-start gap-3 sm:items-end" style={{ '--enter-i': 1 } as CSSProperties}>
            <p className="text-sm leading-relaxed text-ink-dim sm:text-right">
              {isVersion ? (
                'Edit the prefilled basket below and deploy it as a new, separate immutable version. The original stays live and unchanged; holders move only if they choose to.'
              ) : (
                <>
                  <span className="block sm:whitespace-nowrap">Pick tokens, weight them, set your fee, deploy.</span>
                  <span className="block sm:whitespace-nowrap">No management fee, ever.</span>
                </>
              )}
            </p>
            {/* the Composer face is one door back — the same route, bare */}
            {!isVersion && (
              <Link
                to="/create"
                title="The Composer is the research bench: build a candidate mix, see how it would have performed as one basket, and hand it to this studio prefilled."
                className="rounded-lg border border-white/12 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-dim press hover:border-cyan/50 hover:text-cyan"
              >
                Not sure about the mix? Open the Composer ⓘ
              </Link>
            )}
          </div>
        </div>
      </header>
      <BasketBuilder predecessor={from} predecessorChainId={fromChain} />
    </div>
  )
}
