import { useEffect, useMemo, useRef, useState } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { createPortal } from 'react-dom'
import { assetKey, emptyDraft, saveDraft, type AllocationDraft } from '../lib/spectrum/allocation'
import { useNavigate } from 'react-router'
import { flowHref } from '../lib/spectrum/flow-link'
import type { PositionRow } from '../lib/spectrum/position-intents'
import { buildPublishDraft, picksWithShares, publishableRows } from '../lib/spectrum/publish-picks'
import { formatUsdCompact } from '../lib/spectrum/format'
import { CreateSurface } from './allocate/CreateSurface'
import { AssetLogo } from './AssetLogo'
import { BasketBento, type BentoItem } from './BasketBento'

// ─────────────────────────────────────────────────────────────────────────────
// THE PUBLISH PICKER (owner 2026-08-02 22:00): "the publish button needs to
// work — right now it just takes you to a random page. What it should actually
// do is bring up the bento grid when you click publish, as a pop up: you see
// your bento grid and they're kind of dark, and then you actually select which
// ones you want to make public, in a public box."
//
// Two pages of ONE popup, the same shape the rebalance popup settled on:
//   page 1 — your portfolio as the bento, every tile dark; tapping a tile
//            lights it and it joins the PUBLIC BOX below (ticker · share of
//            the picked set · value). Baskets show but stay dark: bundles are
//            not greenlit, so they cannot be legs of a published basket.
//   page 2 — the create flow's OWN stations (weights → outcome → review),
//            mounted embedded+chromeless exactly like the rebalance's page
//            two, adopting the draft page 1 saved. One flow, no copy to drift.
// The engine stays SIMULATED by construction — nothing here changes that.
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

export function PublishPicker({
  positions,
  scope,
  bookOwner,
  onClose,
}: {
  positions: PositionRow[]
  /** Draft scope — where page 1's draft lands so page 2's flow adopts it. */
  scope: string
  /** Whose HOLDINGS `positions` are (desk-204 provenance) — the demo book on
   *  the fixture surface. Stamped on the hand-over draft so real execution
   *  can refuse a demo-seeded plan wherever it later surfaces. */
  bookOwner?: string
  onClose: () => void
}) {
  const navigate = useNavigate()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [stage, setStage] = useState<'pick' | 'flow'>('pick')
  const stageRef = useRef(stage)
  useEffect(() => {
    stageRef.current = stage
  }, [stage])

  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const opener = document.activeElement as HTMLElement | null
    panelRef.current?.querySelector<HTMLElement>('button, input, [tabindex]')?.focus()
    const onKey = (e: KeyboardEvent) => {
      // Escape steps back a page before it may close — page 2 carries the
      // flow's stations, and one keypress must not discard them.
      if (e.key === 'Escape') {
        if (stageRef.current === 'flow') setStage('pick')
        else onClose()
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
        )
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
      opener?.focus?.()
    }
  }, [onClose])

  const pickableKeys = useMemo(
    () => new Set(publishableRows(positions).map((r) => assetKey(r.asset).toLowerCase())),
    [positions],
  )
  const hasBaskets = positions.some((r) => r.kind === 'basket' && r.valueUsd > 0)
  const picks = picksWithShares(positions, picked)
  const pickedTotal = picks.reduce((s, p) => s + p.row.valueUsd, 0)

  // Every position is a tile so the picture is the whole portfolio; only the
  // pickable ones respond. Unpicked = dim ("they're kind of dark"); picked =
  // lit + ringed; baskets = EXCLUDED, the darkest state — `muted` (0.72,
  // quiet context) left the only unpickable tiles the brightest on the
  // board, reading as already-picked against the caption's own promise.
  const items: BentoItem[] = positions
    .filter((r) => r.valueUsd > 0)
    .map((r) => {
      const key = assetKey(r.asset).toLowerCase()
      return {
        id: key,
        symbol: r.asset.symbol,
        address: r.asset.address,
        chainId: r.asset.chainId,
        weightPct: Math.max(r.pct, 1.6),
        labelPct: r.pct,
        dim: pickableKeys.has(key),
        excluded: !pickableKeys.has(key),
        footer: { amount: formatUsdCompact(r.valueUsd) },
      }
    })

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // THE OTHER DOOR (the owner 2026-08-06): this popup publishes what you ALREADY
  // HOLD, and until now that was the only way in — someone who wanted a basket
  // of assets they don't own had to know to leave and find /create themselves.
  //
  // It leaves the popup for the real route rather than reusing the embedded
  // flow, because the embedded one exists to carry a seeded draft through from
  // page 1 and there is nothing to carry here. It also CLEARS the scope's
  // draft first: "from scratch" has to mean it, and a stale draft left by an
  // earlier session would otherwise be silently adopted on arrival.
  const startFresh = () => {
    const to = flowHref('publish')
    if (!to) return
    saveDraft(scope, emptyDraft(Date.now()))
    onClose()
    navigate(to)
  }

  const handOver = () => {
    const draft: AllocationDraft | null = buildPublishDraft(positions, picked, Date.now(), bookOwner)
    if (!draft) return
    saveDraft(scope, draft)
    setStage('flow')
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-void/60 backdrop-blur-[6px]"
      role="dialog"
      aria-modal="true"
      aria-label={stage === 'flow' ? 'Publish your basket' : 'Choose what to make public'}
      onClick={(e) => {
        // the veil closes only from page 1 — a mis-click must not discard
        // the flow's stations on page 2
        if (e.target === e.currentTarget && stageRef.current === 'pick') onClose()
      }}
    >
      <div className="mx-auto my-3 w-[min(980px,calc(100vw_-_1rem))] sm:my-4 sm:w-[min(980px,calc(100vw_-_2rem))]">
        <div
          ref={panelRef}
          className="panel-in flex max-h-[calc(100svh-2rem)] flex-col overflow-hidden rounded-[2rem] border border-white/12 bg-panel/90 shadow-[0_48px_128px_-32px_rgba(0,0,0,0.9)] backdrop-blur-2xl"
        >
          <div aria-hidden className="h-1 w-full" style={{ background: SPECTRAL, backgroundSize: '300% 100%', animation: 'spectrum-refract 16s ease-in-out infinite' }} />
          {stage === 'flow' ? (
            /* PAGE TWO — the create flow's own stations, adopting the draft
               page 1 just saved. Back returns to the picks untouched. */
            <div className="min-h-0 flex-1 overflow-y-auto p-5 [scrollbar-width:thin] sm:p-8">
              <div className="flex items-center justify-between gap-4">
                <button
                  type="button"
                  onClick={() => setStage('pick')}
                  className="press inline-flex h-10 items-center gap-2 rounded-full border border-white/15 px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
                >
                  ← Back to your picks
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="press grid h-11 w-11 shrink-0 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-white/40 hover:text-ink"
                >
                  ✕
                </button>
              </div>
              {/* Landing at WEIGHT, not the picker: the picks page already
                  chose the assets, and its exit line promises "you set the
                  weights on the next page" — landing anywhere shallower makes
                  that a lie. The flow's own Back still reaches the picker to
                  add more. */}
              <CreateSurface embedded chromeless intent="publish" at="weight" onDone={onClose} />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5 [scrollbar-width:thin] sm:p-8">
              <div className="flex items-start justify-between gap-6">
                <div>
                  <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink sm:text-4xl">Make it public</h2>
                  {/* one line, reading size (owner ~08:5x: "less text and larger") */}
                  <p className="mt-2 text-[17px] leading-snug text-ink-dim">
                    Tap a tile to make it public; dark stays private.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="press grid h-11 w-11 shrink-0 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-white/40 hover:text-ink"
                >
                  ✕
                </button>
              </div>

              <div className="mt-6 h-[min(380px,44svh)] min-h-[220px]">
                <BasketBento items={items} fill animateLayout selectedIds={picked} onSelect={toggle} />
              </div>
              {hasBaskets && (
                <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                  Held baskets stay private; a published basket can&rsquo;t hold basket units yet
                </p>
              )}

              {/* THE PUBLIC BOX — what's picked, as the basket it would be:
                  ticker · share of the picked set · value. Empty = absent. */}
              {picks.length > 0 && (
                <div className="mt-6 rounded-2xl border border-teal/25 bg-teal/[0.04] p-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-teal">
                    Public · {picks.length} position{picks.length === 1 ? '' : 's'} ·{' '}
                    <span className="font-num tabular-nums">{formatUsdCompact(pickedTotal)}</span>
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {picks.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => toggle(p.key)}
                        aria-label={`Remove $${showSymbol(p.row.asset.symbol)} from the public set`}
                        className="press inline-flex h-10 items-center gap-2 rounded-full border border-white/12 py-1 pl-1 pr-3 hover:border-magenta/50"
                      >
                        <AssetLogo address={p.row.asset.address} symbol={p.row.asset.symbol} chainId={p.row.asset.chainId} size={22} />
                        <span className="font-display text-sm font-bold text-ink">${showSymbol(p.row.asset.symbol)}</span>
                        <span className="font-num text-xs font-semibold tabular-nums text-ink-dim">{Math.round(p.sharePct)}%</span>
                        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-faint">{formatUsdCompact(p.row.valueUsd)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                  {picks.length === 0
                    ? 'nothing picked yet · the grid is your portfolio'
                    : 'weights start at your real proportions; you set them on the next page'}
                </span>
                {/* secondary, and worded as the alternative it is — the
                    primary action stays the one most people came for */}
                {flowHref('publish') && (
                  <button
                    type="button"
                    onClick={startFresh}
                    className="press inline-flex h-12 items-center rounded-full border border-white/15 px-5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
                  >
                    Or build one from scratch
                  </button>
                )}
                <button
                  type="button"
                  onClick={handOver}
                  disabled={picks.length === 0}
                  className="spectral-btn press inline-flex h-12 items-center gap-2 rounded-full px-7 font-display text-[13px] font-bold uppercase tracking-[0.12em] text-void disabled:opacity-50"
                >
                  Continue to publish →
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
