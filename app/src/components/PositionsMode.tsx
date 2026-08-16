import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { createPortal } from 'react-dom'
import { parseUnits } from 'viem'
import { assetKey, emptyDraft, loadNamedPlans, loadWatchlist, saveDraft, saveNamedPlan, toggleWatch, type AllocAsset, type NamedPlan } from '../lib/spectrum/allocation'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { mergeCrossChainHits, searchTokens, type TokenHit } from '../lib/spectrum/token-search'
import { composeRebalance, mergeBoardCards, type PositionIntent, type PositionRow } from '../lib/spectrum/position-intents'
import { realizedOnTrim } from '../lib/spectrum/insights'
import { TrimBar } from './TrimBar'
import { writeChangeAttribution } from '../lib/spectrum/change-attribution'
import { Carousel } from './Carousel'
import { tokenVisual } from '../lib/spectrum/token-meta'
import { CASH_GREEN, CASH_SYMBOLS, classifyTier, TIER_LABELS, TIER_ORDER, type MarketTier } from '../lib/spectrum/market-tiers'
import { useMarketTiers } from '../lib/spectrum/use-market-tiers'
import { flowHref } from '../lib/spectrum/flow-link'
import { formatUsdCompact } from '../lib/spectrum/format'
import { categoryPills } from '../lib/spectrum/asset-categories'
import { CreateSurface } from './allocate/CreateSurface'
import { AssetLogo } from './AssetLogo'
import { BasketAvatar } from './BasketAvatar'
import { BasketBento, type BentoItem } from './BasketBento'
import { BasketContents } from './BasketContents'
import { CategoryPills } from './CategoryPills'
import { MoneyFacets, type MoneyFacet } from './MoneyFacets'
import { RangeOrderPanel } from './RangeOrderPanel'
import { RANGE_ORDERS_ENABLED } from '../lib/config/features'
import { ChainBadge } from './ChainBadge'
import { InfoDot } from './InfoDot'

// ─────────────────────────────────────────────────────────────────────────────
// POSITIONS MODE, round 5 — the REVAMP (owner: "buggy as hell, completely
// revamp"; every mechanic in the PM's proof audit rebuilt):
//   · CASH IS REAL: the composer emits cash legs now — adds draw from held
//     stables, unspent trim proceeds credit the pile; the money line and the
//     composed output can no longer disagree (K2, all three heads).
//   · the BAR's scale is a function of its card ALONE (owner: "dragging one
//     bar drags the rest" — budget-coupled maxes made every bar rescale
//     mid-drag; N1's deeper root). Money coverage is worded, never geometric.
//   · the dollar field is a REAL field: decimals, clearable, stray characters
//     ignored — never coerced to a silent full-trim (minors).
//   · fresh cards are removable; Reset clears everything and stays visible
//     while anything is dirty (N5); the picker greys out already-present
//     assets instead of silently dropping the pick (N4).
//   · badge threshold matches the change threshold — no phantom badges.
//   · HOW IT FILLS lives on the REVIEW, not here (owner 2026-08-02: "all at
//     once / spread over time should show up on the review page, not on
//     rebalance — it should be the next page"); this surface shapes the plan,
//     the review decides how it fills.
//   · veil click closes; focus trap held over from round 4.
// POSITIONS, NOT EXPOSURE (the owner's ruling 2026-08-02): the rows are what the
// chain lets you trade — directly-held tokens, plus each held BASKET as one
// unit (a trim sells shares, never its legs). What's inside a basket shows on
// expand as exposure, never as a bar. The looked-through picture lives on the
// page, not here.
//
// Pipeline law unchanged: deltas → composeRebalance → the flow's draft
// (amountUsd = NET new money · funding carries sells + gross buys) → review.
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'


type GroupMode = 'chain' | 'risk' | 'size'

const GROUPS: { id: GroupMode; label: string }[] = [
  { id: 'chain', label: 'Chain' },
  { id: 'risk', label: 'Risk' },
  { id: 'size', label: 'Size' },
]

const fmtUsd = (n: number) => (Math.abs(n) < 0.005 ? '$0' : formatUsdCompact(n))

/** The typed dollar field — a real input (PM minors): local text state,
 *  decimals allowed, clearable, stray characters ignored (never coerced to a
 *  silent full-trim). Blur with an empty/invalid field restores the target. */
/** THE DELTA BOX (the owner's 09:47 recording: "that number needs to be the
 *  amount that you're changing… minus 1500 if I want to sell, 1500 if I want
 *  to buy"). The value IS the signed change: it renders with its sign, a
 *  typed leading - or + sets the direction explicitly, and an unsigned
 *  number keeps the row's current lean (the old behavior, preserved for the
 *  common flow of dragging then nudging). */
function DollarField({
  delta,
  lean,
  onDelta,
  label,
}: {
  /** The SIGNED change in dollars (negative sells, positive buys). */
  delta: number
  /** The direction an UNSIGNED typed number takes: the row's current lean. */
  lean: 'sell' | 'buy'
  onDelta: (signedUsd: number) => void
  label: string
}) {
  const [text, setText] = useState<string | null>(null) // null = mirror value
  const shown =
    text ??
    (Math.abs(delta) < 0.005
      ? '0'
      : `${delta < 0 ? '-' : '+'}${String(Math.round(Math.abs(delta) * 100) / 100)}`)
  return (
    <span className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-num text-xs text-ink-faint">$</span>
      <input
        inputMode="decimal"
        value={shown}
        onChange={(e) => {
          const raw = e.target.value
          if (!/^[-+]?\d*\.?\d*$/.test(raw)) return // stray characters ignored
          setText(raw)
          const body = raw.replace(/^[-+]/, '')
          if (body !== '' && body !== '.') {
            const n = Number(body)
            if (!Number.isFinite(n) || n < 0) return
            const sign = raw.startsWith('-') ? -1 : raw.startsWith('+') ? 1 : lean === 'sell' ? -1 : 1
            onDelta(sign * n)
          }
        }}
        onBlur={() => setText(null)}
        aria-label={label}
        className="h-9 w-36 rounded-lg border border-white/15 bg-white/[0.04] pl-6 pr-2 text-right font-num text-sm font-semibold tabular-nums text-ink focus:border-cyan/60 focus:outline-none"
      />
    </span>
  )
}

/** One asset card — bar design v3 (owner 14:43 sweep). The delta %% sits at
 *  the bar's left. Scale: existing cards span 0→2×current (their own money);
 *  NEW cards span 0→the rest of the portfolio (owner: "move the bar relative
 *  to the money I have in other assets") — and both may EXCEED the budget;
 *  the shortfall is worded in the band below, never blocked here. */
/** An LP position in the reshape flow — WEARS the asset-card grammar, IS not
 *  one: no target, no bar, no intent. Tapping it answers with the one sentence
 *  (owner's exact contract) instead of an adjuster. */
function LpCard({ row }: { row: { symbol: string; chainId: number; valueUsd: number; count: number } }) {
  const [said, setSaid] = useState(false)
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
      <button
        type="button"
        onClick={() => setSaid((v) => !v)}
        aria-expanded={said}
        aria-label={`$${showSymbol(row.symbol)} — liquidity position, view only`}
        className="flex w-full items-center gap-3 text-left"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/[0.06] font-display text-[10px] font-bold text-ink">LP</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-display text-base font-bold text-ink">${showSymbol(row.symbol)}</span>
            <span className="rounded-full border border-violet-bright/40 bg-violet-bright/[0.08] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-violet-bright">lp</span>
          </span>
          <span className="mt-0.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
            <ChainBadge chainId={row.chainId} />
            {row.count} position{row.count === 1 ? '' : 's'}
          </span>
        </span>
        <span className="rounded-full bg-white/[0.05] px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">
          <span className="font-num text-xs font-semibold tabular-nums">{fmtUsd(row.valueUsd)}</span>
        </span>
      </button>
      {said && (
        <p className="mt-3 border-t border-white/8 pt-2.5 text-[12px] leading-relaxed text-ink-dim">
          Reweighting LP positions is currently unavailable — this stays in your mix as a view-only
          position for now.
        </p>
      )}
    </div>
  )
}

function AssetCard({
  p,
  isNew,
  target,
  scaleUsd,
  onTarget,
  onRemove,
  i,
  expanded,
  onToggle,
}: {
  p: PositionRow
  isNew: boolean
  target: number
  /** The bar's full-scale value (new cards: the rest of the portfolio). */
  scaleUsd: number
  onTarget: (usd: number) => void
  onRemove?: () => void
  i: number
  /** Collapsed by default (owner ~20:4x: "shrink the amount of content on the
   *  first reshape page so you can see everything in one viewport… showing the
   *  slider and number adjuster only makes sense if you actually want to
   *  adjust that position, so maybe you click the ones you want to adjust").
   *  A card with a pending change stays open regardless — losing sight of a
   *  change you already made would be worse than any amount of density. */
  expanded: boolean
  onToggle: () => void
}) {
  const isBasket = p.kind === 'basket'
  const cur = p.valueUsd
  const delta = target - cur
  const moved = Math.abs(delta) > 0.5
  const deltaPct = cur > 0.005 ? (delta / cur) * 100 : null
  return (
    <div
      className={`enter group relative overflow-hidden rounded-2xl border bg-white/[0.03] transition-all duration-300 focus-within:border-cyan/40 hover:border-white/25 ${expanded ? 'border-cyan/30 p-5' : 'border-white/10 p-3.5'}`}
      style={{ '--enter-i': i } as CSSProperties}
    >
      {moved && <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" style={{ background: SPECTRAL }} />}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Hide' : 'Adjust'} $${showSymbol(p.asset.symbol)}`}
        className="flex w-full items-center gap-3 text-left"
      >
        {isBasket ? (
          <BasketAvatar address={p.asset.address} symbol={p.asset.symbol} size={32} />
        ) : (
          <AssetLogo address={p.asset.address} symbol={p.asset.symbol} chainId={p.asset.chainId} size={32} />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-display text-base font-bold text-ink">${showSymbol(p.asset.symbol)}</span>
            {isBasket && (
              <span className="rounded-full border border-teal/40 bg-teal/[0.08] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-teal">basket</span>
            )}
            {isNew && <span className="rounded-full border border-cyan/40 bg-cyan/[0.08] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-cyan">new</span>}
          </span>
          <span className="mt-0.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
            <ChainBadge chainId={p.asset.chainId} />
            {/* the "now $X" readout is RETIRED (the owner 13:19: "you can kind of
                just remove that") — the bar's marker carries the current value */}
          </span>
        </span>
        {/* freeing up is a PLUS, never a minus (owner 16:22): the word carries
            the direction, the number is always what you gain or deploy */}
        <span
          className={`rounded-full px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.1em] ${
            moved && delta < 0 ? 'bg-cyan/[0.12] text-cyan' : moved ? 'bg-teal/[0.12] text-teal' : 'bg-white/[0.05] text-ink-faint'
          }`}
        >
          {moved ? (
            <>
              {/* the pill answers "what will I HOLD after" (13:19: "instead of
                  freeze you see total position after the changes"); the frees/
                  adds direction lives in the caption row under the bar */}
              after <span className="font-num text-xs font-semibold tabular-nums">{fmtUsd(target)}</span>
            </>
          ) : (
            'held'
          )}
        </span>
      </button>
      {isNew && onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove $${showSymbol(p.asset.symbol)}`}
          className="press absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-full text-ink-faint hover:text-magenta"
        >
          ✕
        </button>
      )}

      {/* EVERYTHING BELOW IS THE ADJUSTER, and it only exists once you ask for
          it. At rest the card is one line, so the whole portfolio fits a
          viewport; tap a card and it becomes the full control. */}
      {expanded && (
      <>
      {/* the bar row: delta %% at the LEFT, then the drawn bar (owner 14:43) */}
      {/* the bar takes the FULL row (13:19: "increase the width of the slide
          bar") — the delta %% moved down into the caption row */}
      <div className="mt-5">
        <TrimBar symbol={p.asset.symbol} cur={cur} target={target} scaleUsd={scaleUsd} isNew={isNew} onTarget={onTarget} />
      </div>
      {/* THE CHANGE-FIRST ROW (13:19: "you type in how much you want to sell
          and you slide how much you want to sell"): the number box carries the
          CHANGE; direction reads from which side of the current mark the thumb
          sits (the drag decides it; typing keeps the current direction, and an
          untouched held asset defaults to selling — his stated flow). */}
      <div className="mt-3 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
          {moved && delta < 0
            ? isBasket
              ? `freeing up · sells shares${deltaPct != null ? ` · ${Math.abs(deltaPct).toFixed(0)}%` : ''}`
              : `freeing up${deltaPct != null ? ` · ${Math.abs(deltaPct).toFixed(0)}%` : ''}`
            : moved
              ? isBasket
                ? `adding · buys shares${deltaPct != null && !isNew ? ` · ${Math.abs(deltaPct).toFixed(0)}%` : ''}`
                : `adding${deltaPct != null && !isNew ? ` · ${Math.abs(deltaPct).toFixed(0)}%` : ''}`
              : 'drag or type the change'}
        </span>
        <DollarField
          delta={Math.abs(delta) > 0.5 ? delta : 0}
          lean={moved ? (delta < 0 ? 'sell' : 'buy') : isNew ? 'buy' : 'sell'}
          onDelta={(signed) => onTarget(Math.max(0, cur + signed))}
          label={`The change for $${showSymbol(p.asset.symbol)} in dollars — minus sells, plus buys`}
        />
      </div>
      {/* WHAT IT HOLDS, always visible (owner: "each basket token should show
          the assets within it and their %s so people have a good idea of what
          that exposure means"). Exposure, never a control — the basket trades
          as one unit (the owner's ruling). */}
      {/* the "exposure you carry; trade the basket, not its legs" caption is
          RETIRED (owner 17:53: "we can just remove that text entirely") — the
          circles now read as exposure without a sentence explaining them */}
      {isBasket && (p.contents?.length ?? 0) > 0 && (
        <div className="mt-3 border-t border-white/8 pt-3">
          <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">holds</p>
          <BasketContents legs={p.contents ?? []} max={6} />
        </div>
      )}
      {/* THE WAY OUT (owner: "there's no way to exit the trim… you should be
          able to click it again to close and save changes, or a green tick
          button in bottom right"). Nothing to save — every keystroke is
          already in the plan and the board above has been counting it — so
          this only puts the card away. Tapping the header again does the same. */}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={onToggle}
          aria-label={`Done adjusting $${showSymbol(p.asset.symbol)}`}
          className="press inline-flex h-8 items-center gap-1.5 rounded-full border border-teal/40 bg-teal/[0.08] px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-teal hover:border-teal/70"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 13l4 4L19 7" />
          </svg>
          Done
        </button>
      </div>
      </>
      )}
    </div>
  )
}

/** The inline add bar: type a ticker or paste an address, pick, click Add.
 *  Same search doctrine as the flow's picker (every network at once, deepest
 *  real liquidity wins, a failed search says so). No popup — his 16:22 call. */
function InlineAdd({ takenKeys, onAdd, onWatch }: { takenKeys: Set<string>; onAdd: (a: AllocAsset) => void; onWatch: (a: AllocAsset) => void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<AllocAsset[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [picked, setPicked] = useState<AllocAsset | null>(null)

  useEffect(() => {
    const needle = q.trim()
    setPicked(null)
    if (needle.length < 2) {
      setHits([])
      setBusy(false)
      setFailed(false)
      return
    }
    let stale = false
    setBusy(true)
    setFailed(false)
    const t = window.setTimeout(() => {
      Promise.all(
        SUPPORTED_CHAIN_IDS.map((chainId) =>
          searchTokens(needle, chainId)
            .then((rows: TokenHit[]) => rows.map((h) => ({ h, chainId })))
            .catch(() => null),
        ),
      )
        .then((all) => {
          if (stale) return
          if (all.every((r) => r === null)) {
            setFailed(true)
            setHits([])
            return
          }
          // the shared cross-chain law (mergeCrossChainHits): exact match
          // pins, then highest mcap wins its symbol — Robinhood listings
          // no longer vanish behind same-ticker liquidity elsewhere
          setHits(
            mergeCrossChainHits(all.filter(Boolean).flat() as { h: TokenHit; chainId: number }[], needle, 6).map(
              ({ h, chainId }) => ({ chainId, address: h.address, symbol: h.symbol, depthUsd: h.liquidityUsd }),
            ),
          )
        })
        .finally(() => {
          if (!stale) setBusy(false)
        })
    }, 300)
    return () => {
      stale = true
      window.clearTimeout(t)
    }
  }, [q])

  const commit = (a: AllocAsset) => {
    if (takenKeys.has(assetKey(a))) return
    onAdd(a)
    setQ('')
    setHits([])
    setPicked(null)
  }

  return (
    /* THE RESULTS FLOAT (owner 2026-08-03 ~00:4x: suggestions "should not
       increase the height or width of the bg card and shouldn't push the
       bento down"): the card is one row, always — the hits render in an
       absolutely-positioned panel OVER whatever sits below, so nothing
       reflows while you type. Escape clears the search first (and stays
       inside this control) before it may work the popup's layers. */
    <div className="relative mt-4 rounded-2xl border border-white/12 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Add something new</span>
        <span className="relative min-w-0 flex-1">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && q.trim().length > 0) {
                e.stopPropagation()
                setQ('')
              }
            }}
            placeholder="Search a ticker, or paste a contract address"
            aria-label="Search a ticker or paste a contract address"
            aria-expanded={q.trim().length >= 2}
            className="h-11 w-full rounded-xl border border-white/15 bg-white/[0.04] px-4 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-cyan/60 focus:outline-none"
          />
        </span>
      </div>
      {q.trim().length >= 2 && (
        <div className="absolute inset-x-0 top-full z-30 mt-2 rounded-2xl border border-white/12 bg-panel/95 p-3 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.85)] backdrop-blur-xl">
          {failed ? (
            <p className="font-mono text-[10px] uppercase tracking-widest text-amber-300/85">search couldn’t reach the markets; try again</p>
          ) : busy && hits.length === 0 ? (
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint" role="status">searching every network…</p>
          ) : hits.length === 0 ? (
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">no routable market found</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {hits.map((a) => {
                const key = assetKey(a)
                const taken = takenKeys.has(key)
                const on = picked != null && assetKey(picked) === key
                return (
                  <span key={key} className={`inline-flex h-10 items-center gap-1 rounded-full border py-1 pl-1 pr-1.5 transition-colors ${
                      on ? 'border-cyan/60 bg-cyan/[0.1]' : 'border-white/12'
                    }`}>
                    <button
                      type="button"
                      disabled={taken}
                      onClick={() => {
                        setPicked(a)
                        commit(a)
                      }}
                      className="press inline-flex items-center gap-2 pr-1.5 disabled:opacity-45"
                    >
                      <AssetLogo address={a.address} symbol={a.symbol} chainId={a.chainId} size={22} />
                      <span className="font-display text-sm font-bold text-ink">${showSymbol(a.symbol)}</span>
                      <ChainBadge chainId={a.chainId} />
                      <span className="font-mono text-[9px] uppercase tracking-wide text-ink-faint">
                        {taken ? 'added' : a.depthUsd != null ? formatUsdCompact(a.depthUsd) : ''}
                      </span>
                    </button>
                    {/* THE WATCH STAR (feature 8): keep deciding without
                        adding — the asset stands in the grid as a ghost */}
                    <button
                      type="button"
                      onClick={() => onWatch(a)}
                      aria-label={`Watch $${showSymbol(a.symbol)}`}
                      title={`Watch $${showSymbol(a.symbol)}`}
                      className="press grid h-7 w-7 shrink-0 place-items-center rounded-full text-ink-faint hover:text-cyan"
                    >
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M12 3l2.7 5.6 6.3.9-4.5 4.3 1 6.2-5.5-3-5.5 3 1-6.2L3 9.5l6.3-.9z" />
                      </svg>
                    </button>
                  </span>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function PositionsMode({
  positions,
  lpRows = [],
  scope,
  bookOwner,
  onClose,
  initialTargets,
  initialNote,
  initialFocusKey,
}: {
  /** Readable positions incl. stables (unpriced never enter — page law). */
  positions: PositionRow[]
  /** LP positions, VIEW-ONLY (owner 2026-08-15: "you see it in the reshape but
   *  clicking on it just says reweighting LP positions is currently
   *  unavailable"). A separate prop by design: these rows must be visible in
   *  the mix and structurally OUTSIDE every calculation this mode performs —
   *  totals, targets, intents and plans never see them. */
  lpRows?: { symbol: string; chainId: number; valueUsd: number; count: number }[]
  /** Draft scope — where the composed draft lands so the flow picks it up. */
  scope: string
  /** Whose HOLDINGS `positions` are (desk-204 provenance) — the demo book on
   *  the fixture surface. Stamped on every draft composed here so real
   *  execution can refuse a demo-seeded plan wherever it later surfaces. */
  bookOwner?: string
  onClose: () => void
  /** Targets to open WITH — assetKey → dollar value. The insights strip uses
   *  it so "this drifted" and "put it back" are one tap rather than two
   *  screens: the mode opens already holding the correcting change. */
  initialTargets?: Map<string, number>
  /** The preset's NAME, when initialTargets came from one (the owner 2026-08-06:
   *  "it should show the preset thing of what you recommended" — a change
   *  staged in silence reads as nothing happening). Dismissible banner. */
  initialNote?: string
  /** Open SCROLLED TO one asset's card, with a one-shot ring (touch round 3:
   *  double-clicking a bento tile lands here standing at that row). */
  initialFocusKey?: string
}) {
  const [targets, setTargets] = useState<Map<string, number>>(() => new Map(initialTargets ?? []))
  // dismissed by its ✕; a reset wipes it too (a note over no change lies)
  const [presetNote, setPresetNote] = useState<string | null>(initialNote ?? null)
  const [fresh, setFresh] = useState<AllocAsset[]>([])
  const [guideOpen, setGuideOpen] = useState(false)
  /** Which cards are open. Collapsed is the resting state so the whole
   *  portfolio fits one viewport; a card opens when you ask to adjust it, and
   *  a card carrying a pending change is ALWAYS open — losing sight of a
   *  change you already made would be worse than any amount of density. */
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set())
  const toggleCard = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  /** LIST OR PICTURE (owner 22:00: "with the rebalancing, we could literally
   *  show it as the bento grid… you can then click on the bento to dial it
   *  back or up, so you actually see the structure of it increase or decrease
   *  for each asset"). Picture leads, the same default the portfolio page
   *  just took. The list keeps the full card machinery; the picture dials
   *  through ONE deck under the grid, one tile at a time. */
  const [view, setView] = useState<'list' | 'picture'>('picture')
  /** The category spotlight (23:09) — same pills as the portfolio page. */
  const [catFilter, setCatFilter] = useState<string | null>(null)
  /** NAMED PLANS (feature 6): kept target-sets, adopted into the dials. */
  const [plansOpen, setPlansOpen] = useState(false)
  const [plans, setPlans] = useState<NamedPlan[]>(() => loadNamedPlans(scope))
  const [planName, setPlanName] = useState('')
  /** THE WATCHLIST (feature 8): ghost tiles in the picture, one tap to fund. */
  const [watched, setWatched] = useState<AllocAsset[]>(() => loadWatchlist(scope))
  // SELL THROUGH A POSITION (the owner 2026-08-06 15:2x, "genuinely beautiful in
  // the reshape system"): the alternative to dialling a position down — instead
  // of trimming at today's price, ladder it out across a market-cap band. Keyed
  // by asset so the panel belongs to the tile you opened it from.
  const [rangeKey, setRangeKey] = useState<string | null>(null)
  const [dialKey, setDialKey] = useState<string | null>(null)
  const dialKeyRef = useRef<string | null>(null)
  useEffect(() => {
    dialKeyRef.current = dialKey
  }, [dialKey])
  /** The picture's height in CONCRETE px: the viewport minus the panel's
   *  measured fixed chrome (header, summary, pills, deck, add bar, exit).
   *  Nothing relative works here — the panel is content-height under a max-h
   *  cap, so any percentage/flex height for the picture is CIRCULAR with its
   *  own content: `h-full` resolved to 0 (tiles stacked in a 4px line) and a
   *  flex-grow region settled at the floor. Chrome, by contrast, is invariant
   *  to the picture's size, so one measured pass settles: picture renders →
   *  chrome = panel minus picture wrapper → height set → chrome unchanged.
   *  Opening the dial deck grows the chrome and the picture shrinks to keep
   *  the whole popup on one screen; under the floor the region scrolls. */
  const picWrapRef = useRef<HTMLDivElement>(null)
  const [picH, setPicH] = useState(320)
  /** One staggered pop-in when the picture first mounts (the page bento's
   *  own reveal idiom); flips once and stays — toggling views later must not
   *  re-pop a grid the user has already seen. */
  const [tilesIn, setTilesIn] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setTilesIn(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  /** True while the dial's slider is actively moving — the bento then runs
   *  its short 'live' tracking motion instead of the long glide, which
   *  rubber-bands when its target changes on every input tick (his "more
   *  graceful" note). Cleared shortly after the last tick so the final
   *  settle still glides. */
  const [dialing, setDialing] = useState(false)
  const dialingTimer = useRef<number | null>(null)
  const markDialing = () => {
    setDialing(true)
    if (dialingTimer.current != null) window.clearTimeout(dialingTimer.current)
    dialingTimer.current = window.setTimeout(() => setDialing(false), 220)
  }
  useEffect(
    () => () => {
      if (dialingTimer.current != null) window.clearTimeout(dialingTimer.current)
    },
    [],
  )

  // THE TWO STAGES OF THE POPUP (owner 2026-08-02: the review "should not open
  // as a new page, it should just be the next flow in the rebalance portfolio…
  // and you can go back to the rebalance"). Shaping the plan and reviewing it
  // are two pages of ONE popup, not two destinations: the review never unmounts
  // the shape, so Back returns to every bar exactly where it was left.
  const [stage, setStage] = useState<'shape' | 'review'>('shape')
  /** Back is only offered while the flow is still ON the review. Once the run
   *  starts, going back would UNMOUNT the flow and kill a run in flight — and
   *  after it completes there is no plan left to reshape. */
  const [onReview, setOnReview] = useState(true)
  const stageRef = useRef(stage)
  useEffect(() => {
    stageRef.current = stage
  }, [stage])
  const onReviewRef = useRef(onReview)
  useEffect(() => {
    onReviewRef.current = onReview
  }, [onReview])
  /** A run is under way (or just finished) — a stray Escape or a mis-click on
   *  the veil must not take the flow down mid-run. The ✕ still works: that is
   *  a deliberate act, and the run persists and resumes. */
  const runInFlight = () => stageRef.current === 'review' && !onReviewRef.current

  const panelRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // A new page of the popup starts at ITS top, with focus inside it — carrying
  // the shape stage's scroll offset into the review reads as a broken jump.
  // Skips the first run: the mount effect below already places focus, and
  // firing both meant a duplicate focus call on first paint (UIGuy's note).
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    scrollRef.current?.scrollTo({ top: 0 })
    // the double-click door (touch round 3): land standing at the asset's
    // card — scrolled center, one quiet pulse; element.animate so the kit's
    // shell CSS stays untouched
    if (initialFocusKey) {
      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector<HTMLElement>(`[data-poskey="${initialFocusKey}"]`)
        if (!el) return
        el.scrollIntoView({ block: 'center' })
        el.animate(
          [
            { boxShadow: '0 0 0 0 color-mix(in srgb, var(--color-cyan) 0%, transparent)' },
            { boxShadow: '0 0 0 3px color-mix(in srgb, var(--color-cyan) 55%, transparent)' },
            { boxShadow: '0 0 0 0 color-mix(in srgb, var(--color-cyan) 0%, transparent)' },
          ],
          { duration: 1100, easing: 'ease-out' },
        )
      })
    }
    panelRef.current?.querySelector<HTMLElement>('button, input, [tabindex]')?.focus()
  }, [stage])

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const opener = document.activeElement as HTMLElement | null
    panelRef.current?.querySelector<HTMLElement>('button, input, [tabindex]')?.focus()
    const onKey = (e: KeyboardEvent) => {
      // Escape steps BACK a page before it closes the popup — the review is a
      // page within, so one Escape must not discard the shaping behind it.
      if (e.key === 'Escape') {
        if (runInFlight()) return
        if (stageRef.current === 'review') setStage('shape')
        // the dial deck is a layer too: Escape puts the tile away before it
        // may take the popup down (the popup owns Escape, layer by layer)
        else if (dialKeyRef.current) setDialKey(null)
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

  const isCash = (a: AllocAsset) => CASH_SYMBOLS.has(a.symbol.toUpperCase())
  const cashUsd = positions.filter((p) => isCash(p.asset)).reduce((s, p) => s + p.valueUsd, 0)
  /** THE SPLIT OF CASH (owner ~09:5x: "recognises any usdc/usdt/usdg position
   *  across chains and puts it into one bento asset that also shows the
   *  split"): every held stable, aggregated by SYMBOL across chains, biggest
   *  first — the one cash tile's contents. */
  const cashSplit = useMemo(() => {
    const by = new Map<string, { symbol: string; usd: number; chains: Set<number> }>()
    for (const p of positions) {
      if (!isCash(p.asset)) continue
      const k = p.asset.symbol.toUpperCase()
      const row = by.get(k) ?? { symbol: p.asset.symbol.toUpperCase(), usd: 0, chains: new Set<number>() }
      row.usd += p.valueUsd
      row.chains.add(p.asset.chainId)
      by.set(k, row)
    }
    return [...by.values()].sort((a, b) => b.usd - a.usd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions])
  // ONE CARD PER ASSET, BY CONSTRUCTION (the owner's live bug 2026-08-06: dialling
  // a basket "makes a ton of bento asset tiles for the one basket asset").
  //
  // This list concatenated two sources that can legitimately contain the same
  // asset — the held book and the session's fresh picks — with nothing stopping
  // an overlap. Every downstream consumer then saw the asset TWICE: two cards,
  // two bento tiles sharing one id, and two rows in the list. The tile id is
  // `assetKey`, so a duplicate is not a second asset, it is the same asset
  // rendered again, which is why it read as tiles multiplying.
  //
  // HELD WINS over fresh: a real position carries its true valueUsd, while a
  // fresh entry is a $0 placeholder for something not yet owned. Collapsing the
  // other way would zero a held position's value on the board.
  //
  // The dedupe lives HERE rather than at each append site because this is the
  // one place every consumer reads from — guarding the sources one by one would
  // have to be repeated for every future writer of `fresh`.
  const cards = useMemo<{ p: PositionRow; isNew: boolean }[]>(
    // the merge is a PURE, TESTED helper (mergeBoardCards) because it is a
    // money guard, not a display one — see its doc comment for the two
    // opposing intents a duplicate used to compose
    () => mergeBoardCards<AllocAsset>(positions, fresh, assetKey, isCash) as { p: PositionRow; isNew: boolean }[],
    [positions, fresh],
  )
  const totalUsd = positions.reduce((s, p) => s + p.valueUsd, 0)
  // ── GROUPING (owner: "better showcase which assets are on which chain…
  //    group the cards by chain, and you can swap the group view with pills
  //    for risk / chain etc"). Chain leads because that's the ask; risk reuses
  //    the market-tier registry the positions list already speaks; size is the
  //    flat biggest-first view. The tier reads hit the SAME cached query the
  //    page already ran — free here.
  // Size leads (owner 2026-08-03 ~00:1x: "group by should default to size on
  // both bento and list") — the plain biggest-first read; Chain/Risk opt in.
  const [groupBy, setGroupBy] = useState<GroupMode>('size')
  const mcaps = useMarketTiers(cards.map(({ p }) => p.asset))
  const groups = useMemo(() => {
    if (groupBy === 'size') {
      const sorted = [...cards].sort((a, b) => b.p.valueUsd - a.p.valueUsd)
      return [{ key: 'all', label: '', badge: null as number | null, cards: sorted, usd: cards.reduce((t, c) => t + c.p.valueUsd, 0) }]
    }
    if (groupBy === 'chain') {
      const ids = [...new Set(cards.map(({ p }) => p.asset.chainId))].sort(
        (a, b) => SUPPORTED_CHAIN_IDS.indexOf(a) - SUPPORTED_CHAIN_IDS.indexOf(b),
      )
      return ids.map((id) => {
        const inChain = cards.filter(({ p }) => p.asset.chainId === id)
        let name = String(id)
        try {
          name = chainCfg(id).name
        } catch {
          /* an unknown chain still groups, under its id */
        }
        return { key: `c${id}`, label: name, badge: id as number | null, cards: inChain, usd: inChain.reduce((t, c) => t + c.p.valueUsd, 0) }
      })
    }
    const tierOf = (a: AllocAsset): MarketTier => classifyTier(a.symbol, mcaps.get(assetKey(a)) ?? null)
    return TIER_ORDER.map((tier) => {
      const inTier = cards.filter(({ p }) => tierOf(p.asset) === tier)
      return { key: tier as string, label: TIER_LABELS[tier], badge: null as number | null, cards: inTier, usd: inTier.reduce((t, c) => t + c.p.valueUsd, 0) }
    }).filter((g) => g.cards.length > 0)
  }, [cards, groupBy, mcaps])

  const heldAndFreshKeys = useMemo(
    () => new Set([...positions.map((p) => assetKey(p.asset)), ...fresh.map((a) => assetKey(a))]),
    [positions, fresh],
  )

  const targetOf = (key: string, cur: number) => targets.get(key) ?? cur
  /** Adjusting a card OPENS it and keeps it open — but as a member of the same
   *  set the toggle owns, so it can still be closed. Deriving "expanded" from
   *  the delta instead made a changed card impossible to close: the toggle
   *  flipped the set and the delta forced it straight back open. */
  const setTarget = (key: string) => (usd: number) => {
    setOpenKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
    setTargets((m) => {
      const next = new Map(m)
      next.set(key, Math.max(0, usd))
      return next
    })
  }
  const removeFresh = (key: string) => {
    setFresh((cur) => cur.filter((a) => assetKey(a) !== key))
    setTargets((m) => {
      const next = new Map(m)
      next.delete(key)
      return next
    })
    setDialKey((k) => (k === key.toLowerCase() ? null : k))
  }
  const dirty = targets.size > 0 || fresh.length > 0
  const reset = () => {
    setTargets(new Map())
    setFresh([])
    setPresetNote(null)
  }

  // the live deltas + composed truth (pure, cheap — no memo gymnastics)
  const deltas = cards.map(({ p }) => {
    const key = assetKey(p.asset)
    return { asset: p.asset, cur: p.valueUsd, delta: targetOf(key, p.valueUsd) - p.valueUsd }
  })
  const proceeds = deltas.filter((d) => d.delta < -0.5).reduce((s, d) => s + -d.delta, 0)
  const spend = deltas.filter((d) => d.delta > 0.5).reduce((s, d) => s + d.delta, 0)
  const changed = deltas.filter((d) => Math.abs(d.delta) > 0.5)
  const intents: PositionIntent[] = changed.map((d) =>
    d.delta < 0
      ? { kind: 'sell', asset: d.asset, usd: Math.round(-d.delta * 100) / 100 }
      : { kind: 'buy', asset: d.asset, usd: Math.round(d.delta * 100) / 100 },
  )
  const composed = composeRebalance(positions, intents)

  // the plan's RESULTING portfolio value — the review's dollar base on a
  // rebalance (an all-trim plan deploys $0 new money; per-leg dollars must
  // still read real, not em-dashes)
  const resultTotalUsd = Math.max(0, totalUsd + composed.newMoneyUsd)

  /** What the portfolio looks like RIGHT NOW, carried into the draft so the
   *  review can lead with what changes instead of only showing the result
   *  (owner 17:53). Every position, not only the touched ones: the review
   *  needs the whole before-picture to state the shift honestly. Display
   *  only — the money math reads the live targets, never this. */
  const beforeSnapshot = positions.map((p) => ({
    chainId: p.asset.chainId,
    address: p.asset.address,
    symbol: p.asset.symbol,
    usd: Math.round(p.valueUsd * 100) / 100,
  }))
  /** The legs the user actually moved, with their EXACT ends. Recorded here
   *  because only this surface knows them: the draft stores integer
   *  percentages, so the review re-deriving dollars from them invented changes
   *  on positions nobody touched. */
  const changeSnapshot = changed.map((d) => {
    const row = positions.find((p) => assetKey(p.asset) === assetKey(d.asset))
    // A SELL's exact raw amount, as a PROPORTION of a holding whose size and
    // value we already know — never rebuilt from dollars and a price, which
    // would round money. Adds carry none: you cannot pre-know what a buy costs.
    let sellRaw: string | undefined
    if (d.delta < 0 && row?.decimals != null && row.amount != null && row.valueUsd > 0) {
      const frac = Math.min(1, -d.delta / row.valueUsd)
      const whole = row.amount * frac
      try {
        sellRaw = parseUnits(whole.toFixed(Math.min(row.decimals, 18)), row.decimals).toString()
      } catch {
        sellRaw = undefined
      }
    }
    return {
      chainId: d.asset.chainId,
      address: d.asset.address,
      symbol: d.asset.symbol,
      fromUsd: Math.round(d.cur * 100) / 100,
      toUsd: Math.round((d.cur + d.delta) * 100) / 100,
      // the trim receipt (feature 4): only where basis is KNOWN
      realizedUsd: d.delta < 0 ? realizedOnTrim(d.cur, row?.investedUsd, -d.delta) ?? undefined : undefined,
      sellRaw,
      decimals: row?.decimals,
    }
  })
  // the attribution sidecar (recording 1205): who holds each touched asset,
  // written NOW while the reshape's live rows still know — the review reads
  // it back; the frozen draft parser never sees it (change-attribution.ts)
  writeChangeAttribution(
    changed.map((d) => {
      const row = positions.find((p2) => assetKey(p2.asset) === assetKey(d.asset))
      return { chainId: d.asset.chainId, address: d.asset.address, heldBy: row?.heldBy ?? [] }
    }),
  )
  const fundingBlock = {
    soldUsd: composed.soldUsd,
    grossBuysUsd: composed.boughtUsd,
    resultUsd: resultTotalUsd,
    before: beforeSnapshot,
    changes: changeSnapshot,
  }

  // ── THE PICTURE'S TILES (owner 22:00): sized by where you're TAKING each
  //    position (its target), labeled with its share — and the shares are
  //    PURE RE-EXPRESSION (owner 2026-08-03 ~09:1x: dialing one asset "should
  //    move the % of other assets equally since their dollar value isn't
  //    changing"). Every tile keeps its own dollars — touched at target,
  //    untouched at current, the cash pile AS HELD — and only the
  //    percentages shift against the sum. The old picture debited the pile
  //    live (cash + proceeds − spend), so dialing a large asset up drained
  //    it to zero and its tile LEFT the grid ("moving the lowest asset out
  //    of the basket" — reproduced: CASH · 6.8% vanished on a DEVBKT
  //    dial-up). How a plan is FUNDED is the summary strip's and the
  //    review's story, never the picture's.
  const shareBase = Math.max(
    cards.reduce((s, { p }) => s + targetOf(assetKey(p.asset), p.valueUsd), 0) + cashUsd,
    1,
  )
  const LAYOUT_FLOOR_PCT = 1.6
  // the category spotlight (23:09): pills from what the mode actually shows
  const catPills = categoryPills(cards.map(({ p }) => p.asset))
  const activePill = catFilter ? catPills.find((pl) => pl.id === catFilter) ?? null : null
  // WHAT EACH CATEGORY IS WORTH (the owner 2026-08-06 12:53, the spotlight half of
  // the per-chain ask: "you also see at the bottom — total value on base this
  // amount, total value in defi this amount, total in stocks this amount").
  // Priced off the same TARGETS the tiles are sized by, not today's values, so
  // the foot and the picture above it are always describing one plan. Chains
  // wear their logo, themes their word — the pills' own grammar.
  const facetTotals: MoneyFacet[] = catPills
    .map((pl) => ({
      key: pl.id,
      chainId: pl.chainId,
      label: pl.chainId == null ? pl.label : undefined,
      usd: cards.reduce((s, { p }) => (pl.matches(p.asset) ? s + targetOf(assetKey(p.asset), p.valueUsd) : s), 0),
      dim: activePill != null && activePill.id !== pl.id,
    }))
    .filter((r) => Number.isFinite(r.usd) && r.usd > 0.005)
  const litKey = (a: AllocAsset) => (activePill ? activePill.matches(a) : true)
  // ── HOW THE PICTURE ARRANGES (owner ~23:2x: the Group-by pills belong on
  //    the bento too — "pressing them just rearranges the grid by the pill
  //    metric"; and a spotlight "rearranges to be grouped together, unclick
  //    and they go back"). ONE primary arrangement at a time: an active
  //    metric grouping owns the regions and the spotlight only lights; with
  //    no metric grouping (Size), the spotlight's lit tiles cluster first.
  const tierOfAsset = (a: AllocAsset): MarketTier => classifyTier(a.symbol, mcaps.get(assetKey(a)) ?? null)
  const tileGroup = (a: AllocAsset): string | undefined => {
    if (view === 'picture' && groupBy === 'chain') return `c${a.chainId}`
    if (view === 'picture' && groupBy === 'risk') return tierOfAsset(a)
    if (activePill) return litKey(a) ? 'lit' : 'dim'
    return undefined
  }
  const tileGroupOrder = useMemo(() => {
    if (view === 'picture' && groupBy === 'chain') return SUPPORTED_CHAIN_IDS.map((id) => `c${id}`)
    if (view === 'picture' && groupBy === 'risk') return TIER_ORDER as string[]
    return ['lit', 'dim']
  }, [view, groupBy])
  const bentoItems: BentoItem[] = [
    ...cards.map(({ p }) => {
      const key = assetKey(p.asset)
      const tgt = targetOf(key, p.valueUsd)
      const share = (tgt / shareBase) * 100
      return {
        id: key,
        symbol: p.asset.symbol,
        address: p.asset.address,
        chainId: p.asset.chainId,
        weightPct: Math.max(share, LAYOUT_FLOOR_PCT),
        labelPct: share,
        dim: !litKey(p.asset),
        group: tileGroup(p.asset),
        footer: { amount: fmtUsd(tgt) },
      }
    }),
    // WATCHLIST GHOSTS (feature 8): assets you're deciding about stand in
    // the grid dark at floor size; tapping one funds it (a fresh card with
    // the dial open). Hidden once held or already added this session.
    ...watched
      .filter((a) => !heldAndFreshKeys.has(assetKey(a)))
      .map((a) => ({
        id: assetKey(a),
        symbol: a.symbol,
        address: a.address,
        chainId: a.chainId,
        weightPct: LAYOUT_FLOOR_PCT,
        labelPct: 0,
        dim: true,
        footer: { amount: 'watching' },
      })),
    ...(cashUsd > 0.5
      ? [
          {
            id: 'cash-pile',
            symbol: 'CASH',
            address: 'cash-pile',
            chainId: positions[0]?.asset.chainId ?? 1,
            // the pile AS HELD — its dollars don't move while you dial;
            // floored like every tile so it always holds its space. NOT
            // muted (owner ~09:4x: an inert tile reads as broken —
            // "unclickable") — clicking it opens the honest info deck
            // below instead of a dial. The SPECIAL CASH GREEN (owner ~09:5x)
            // marks it as the one aggregated tile in the grid.
            weightPct: Math.max((cashUsd / shareBase) * 100, LAYOUT_FLOOR_PCT),
            labelPct: (cashUsd / shareBase) * 100,
            color: CASH_GREEN,
            footer: {
              amount: fmtUsd(cashUsd),
              // the split ON the tile (owner ~09:5x): one stable reads as a
              // plain label; several each carry their own amount
              breakdown:
                cashSplit.length === 1
                  ? [{ label: `all $${cashSplit[0].symbol}` }]
                  : cashSplit.map((c) => ({ label: `$${showSymbol(c.symbol)}`, amount: fmtUsd(c.usd) })),
            },
          },
        ]
      : []),
  ]

  /** The asset the dial slot is showing (null for the pile / nothing). */
  const dialAsset =
    dialKey && dialKey !== 'cash-pile'
      ? cards.find((c) => assetKey(c.p.asset).toLowerCase() === dialKey) ?? null
      : null

  const href = flowHref('keep')
  /** Saving the plan is ALWAYS available — targets are device-local intent and
   *  planning stands on its own (the owner: operators default to positions ON).
   *  Executing needs the flow; where it isn't available the mode says so in
   *  words instead of hiding the button (R's dead-end finding). */
  const [saved, setSaved] = useState(false)
  // desk-204 provenance: every draft composed from this book carries its
  // owner, so a demo-book plan can be refused at real execution even after
  // adoptGuestDraft moves it under a real wallet.
  const provenance =
    bookOwner && /^0x[0-9a-fA-F]{40}$/.test(bookOwner) ? { seedBookOwner: bookOwner.toLowerCase() } : {}
  const savePlan = () => {
    if (changed.length === 0 || !composed.executable) return
    saveDraft(scope, {
      ...emptyDraft(),
      targets: composed.targets,
      amountUsd: composed.amountUsd,
      intent: 'keep',
      channel: 'market',
      funding: fundingBlock,
      ...provenance,
    })
    setSaved(true)
  }
  const execute = () => {
    if (!href || changed.length === 0 || !composed.executable) return
    saveDraft(scope, {
      ...emptyDraft(),
      targets: composed.targets,
      amountUsd: composed.amountUsd, // NET new money; 0 valid (funding marks it)
      intent: 'keep',
      channel: 'market',
      funding: fundingBlock,
      ...provenance,
    })
    // The plan does not LEAVE for the review any more — the review is the next
    // page of this popup, reading the draft that was just saved. `href` still
    // gates it: where the operator has the flow switched off, the exit stays
    // "Save this plan" (no dead ends) rather than mounting a hidden surface.
    setStage('review')
  }
  const refusal =
    changed.length === 0
      ? null
      : composed.reason === 'full-exit'
        ? 'selling everything is the whole-portfolio exit; that ships with the exit decision'
        : composed.reason === 'too-many-legs'
          ? `the flow executes up to 12 positions; this change leaves ${composed.targets.length}`
          : composed.reason === 'empty'
            ? 'this change nets out to nothing to execute; adjust a weight first'
            : null

  /** Sizing for the picture (see picH above): each pass adjusts by what is
   *  measurable without knowing which sibling is which —
   *    headroom = viewport space the panel is not using (panel under its cap)
   *    overflow = picture content the region cannot show (panel at its cap)
   *    next H  = H + headroom − overflow
   *  Under the cap, growing H grows the panel by the same amount (headroom
   *  hits 0); at the cap, shrinking H removes exactly the scroll debt. Either
   *  way it converges in a pass or two; picH in the deps re-runs the pass and
   *  the ≤1px guard halts it. Lives down here because it reads `changed`/
   *  `saved`/`refusal`; no early returns in this component, hook order safe. */
  const hasChanges = changed.length > 0
  useLayoutEffect(() => {
    if (view !== 'picture' || stage !== 'shape') return
    // NEVER resize the canvas mid-dial (owner ~09:3x: distant tiles moved
    // while dialing — the exit row appearing at the first change shrank the
    // measured region and reflowed EVERY tile). The grid holds still while
    // the hand is on the slider; release re-measures once, with the glide.
    if (dialing) return
    const measure = () => {
      // PHONES DON'T FIT-ONE-VIEWPORT: the panel is uncapped there (the popup
      // scrolls as one page, the natural phone idiom) so headroom is
      // meaningless — the picture takes a fixed readable height instead.
      if (window.innerWidth < 640) {
        setPicH(300)
        return
      }
      const panel = panelRef.current
      const wrap = picWrapRef.current
      const region = wrap?.parentElement?.parentElement
      if (!panel || !wrap || !region) return
      const headroom = window.innerHeight - 32 - panel.offsetHeight
      const overflow = Math.max(0, region.scrollHeight - region.clientHeight)
      setPicH((h) => {
        // floor 96, not 200: the picture must NEVER scroll (owner ~00:4x),
        // so on a genuinely short window it gets small rather than cut
        const next = Math.round(Math.min(Math.max(h + headroom - overflow, 96), 640))
        return Math.abs(next - h) > 1 ? next : h
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [view, stage, dialKey, hasChanges, fresh.length, saved, refusal, picH, dialing])

  return createPortal(
    /* popup in FRONT (13:50): a veil, not a wall — click it to leave */
    <div
      ref={scrollRef}
      className="fixed inset-0 z-50 overflow-y-auto bg-void/60 backdrop-blur-[6px]"
      role="dialog"
      aria-modal="true"
      aria-label={stage === 'review' ? 'Review and execute your changes' : 'Reshape your portfolio'}
      onClick={(e) => {
        if (e.target === e.currentTarget && !runInFlight()) onClose()
      }}
    >
      <div className="mx-auto my-3 w-[min(1180px,calc(100vw_-_1rem))] sm:my-4 sm:w-[min(1180px,calc(100vw_-_2rem))]">
        {/* CAPPED TO THE VIEWPORT (owner: "everything must fit in one viewport
              for reshape"). Tuning paddings to one screen height only ever fits
              THAT screen — a 900px window fitted while an 800px one did not.
              The panel is now a flex column bounded by the viewport, and the
              CARD GRID is the flexible region: it takes the space that is left
              and, only when a portfolio is genuinely too large for the screen,
              scrolls inside itself rather than pushing the summary and the exit
              off the bottom. The parts you must always see are never the parts
              that move. */}
          {/* The viewport cap comes off on PHONES in the picture view — there
              the popup scrolls as one page (nine tiles + deck + add bar can
              never share 844px), while sm+ keeps the fit-one-viewport law. */}
          <div
            ref={panelRef}
            className={`panel-in flex flex-col overflow-hidden rounded-[2rem] border border-white/12 bg-panel/90 shadow-[0_48px_128px_-32px_rgba(0,0,0,0.9)] backdrop-blur-2xl ${
              stage === 'shape' && view === 'picture' ? 'sm:max-h-[calc(100svh-2rem)]' : 'max-h-[calc(100svh-2rem)]'
            }`}
          >
          <div aria-hidden className="h-1 w-full" style={{ background: SPECTRAL, backgroundSize: '300% 100%', animation: 'spectrum-refract 16s ease-in-out infinite' }} />
          {stage === 'review' ? (
            /* PAGE TWO of the same popup — the flow's own review station,
               mounted here rather than navigated to. It reads the draft
               execute() just saved, so the plan crosses unchanged. Once a
               build has run, Back retires: reshaping a spent plan would be a
               lie about what is still pending.
               min-h-0 flex-1 overflow-y-auto: the panel is viewport-capped and
               overflow-hidden, and a PARTIAL run (sale cards + legs + notes)
               grows past it — the bottom used to CLIP with no way to reach it
               (owner 2026-08-16: "this card cuts off all elements at the
               bottom… worst case if it genuinely cant fit have a scroll so
               the flow doesnt brake"). Content that fits renders exactly as
               before; overflow scrolls inside the card instead of vanishing. */
            <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-8">
              <div className="flex items-center justify-between gap-4">
                {!onReview ? (
                  <span />
                ) : (
                  <button
                    type="button"
                    onClick={() => setStage('shape')}
                    className="press inline-flex h-10 items-center gap-2 rounded-full border border-white/15 px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
                  >
                    ← Back to reshape
                  </button>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="press grid h-11 w-11 shrink-0 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-white/40 hover:text-ink"
                >
                  ✕
                </button>
              </div>
              {/* "See your portfolio" closes the popup: the portfolio is the
                  page underneath, and it re-reads on mount (owner 17:53). */}
              <CreateSurface
                embedded
                chromeless
                intent="keep"
                channel="market"
                at="review"
                onDone={onClose}
                onStation={(s) => setOnReview(s === 'review')}
              />
            </div>
          ) : (
          // THE SHAPE PAGE IS THE FLEX COLUMN, not just the review page — an
          // earlier edit made only the review branch a column, so expanding a
          // card here grew the content past the panel's cap and the add bar and
          // the exit were CLIPPED by overflow-hidden rather than scrolled.
          // Clipped is worse than off-screen: there is no way to reach them at
          // all. The card grid is the one region allowed to flex; everything the
          // user must always reach sits outside it.
          <div className="flex min-h-0 flex-1 flex-col p-5 sm:p-8">
            <div className="flex items-start justify-between gap-6">
              <div>
                {/* the subtitle is GONE (owner ~09:1x: "remove this text so we
                    can move everything up a little") — the guide keeps its
                    eye, riding the title row */}
                {/* TWO LINES, A STEP BIGGER (the owner 2026-08-06 12:49 #13). The
                    verb gets its own line so the title lands as an instruction
                    rather than a label, and the tighter leading keeps the taller
                    type inside the same one-viewport budget the panel measures. */}
                <h2 className="font-display text-3xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-5xl">
                  <span className="block">Reshape</span>
                  <span className="flex items-center gap-3">
                    your portfolio
                    <button
                      type="button"
                      onClick={() => setGuideOpen((v) => !v)}
                      aria-expanded={guideOpen}
                      aria-label="Read more about how this works"
                      className="press grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/15 text-ink-faint hover:border-cyan/50 hover:text-cyan"
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.5" />
                      </svg>
                    </button>
                  </span>
                </h2>
                {guideOpen && (
                  <p className="mt-2 max-w-[58ch] text-[13px] leading-relaxed text-ink-dim">
                    Set every position where you want it; the board tells you what it takes.
                    Drag a bar left to trim a position, right to add to it, or type the exact
                    value. Trims become cash; adds draw on it. You can set targets beyond your
                    cash, and the board below shows exactly what you'd need to bring. New assets
                    scale against the money you already have.
                  </p>
                )}
              </div>
              {/* THE ACTIONS LIVE TOP-RIGHT (owner ~10:2x: "find a better
                  location for these buttons - maybe top right of card") —
                  always present, disabled until a change exists */}
              <div className="flex shrink-0 items-center gap-3">
                {dirty && (
                  <button
                    type="button"
                    onClick={reset}
                    className="press inline-flex h-10 items-center rounded-full border border-white/15 px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-white/40 hover:text-ink"
                  >
                    Reset
                  </button>
                )}
                {href ? (
                  <span className="flex flex-col items-end gap-1">
                    <button
                      type="button"
                      onClick={execute}
                      disabled={changed.length === 0 || !composed.executable}
                      className="spectral-btn press inline-flex h-11 items-center gap-2 rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void disabled:opacity-50"
                    >
                      Review &amp; execute →
                    </button>
                    {/* the disabled reason lives ON the button it explains
                        (audit 2026-08-16: it rendered in the pills row far
                        below, and the 'empty' case had no sentence at all) */}
                    {refusal && changed.length > 0 && (
                      <span className="max-w-[260px] text-right font-mono text-[10px] uppercase tracking-[0.12em] text-amber-300/85">
                        {refusal}
                      </span>
                    )}
                  </span>
                ) : (
                  /* execution isn't available on this site yet — the plan
                     still saves, and the mode SAYS so (no dead ends) */
                  <button
                    type="button"
                    onClick={savePlan}
                    disabled={changed.length === 0 || !composed.executable || saved}
                    className="spectral-btn press inline-flex h-11 items-center gap-2 rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void disabled:opacity-50"
                  >
                    {saved ? 'Plan saved ✓' : 'Save this plan'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="press grid h-11 w-11 shrink-0 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-white/40 hover:text-ink"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* ── THE SUMMARY, AT THE TOP (owner ~20:5x: "at the top of the
                reshape page, above the individual positions and baskets, you
                should see the total port value, and as you make adjustments
                the amounts, like we had the trimming, cash, to add"). It used
                to sit BELOW every card, so the number telling you what a
                change costs was the one thing you had to scroll to find.
                THE TOTAL IS ALWAYS THERE; the three change figures appear only
                once a change exists, which keeps his board-on-change rule —
                an all-zero board on an untouched portfolio was noise. Compact
                by necessity: everything has to fit one viewport. ─────────── */}
            {/* THE PRESET SAYS SO (the owner 2026-08-06): a change staged by an
                insight-card button announces itself — otherwise the popup
                opening with the change already absorbed into the tiles reads
                as the button having done nothing */}
            {presetNote && targets.size > 0 && (
              <div className="mt-5 flex items-center gap-3 rounded-xl border border-cyan/25 bg-cyan/[0.06] px-4 py-2.5">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-[0.12em] text-ink">
                  Staged for you: <span className="text-cyan">{presetNote}</span> · review &amp; execute when ready
                </span>
                <button
                  type="button"
                  onClick={() => setPresetNote(null)}
                  aria-label="Dismiss the staged-preset note"
                  className="press grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-faint hover:text-ink"
                >
                  ✕
                </button>
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-3">
              {/* the strip's LEAD fact, a step up (the owner 2026-08-06 12:49 #14):
                  it is the one number the whole page is about, and it was
                  reading at the same weight as the three supporting figures
                  beside it. */}
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                  {changed.length > 0 ? 'Portfolio after this' : 'Your portfolio'}
                </p>
                <p className="font-num text-3xl font-semibold tabular-nums text-ink">
                  {fmtUsd(changed.length > 0 ? resultTotalUsd : totalUsd)}
                </p>
              </div>
              {changed.length > 0 && (
                <>
                  <span aria-hidden className="hidden h-9 w-px bg-white/10 sm:block" />
                  {([
                    { label: 'Trims free up', value: proceeds, cls: 'text-magenta' },
                    { label: 'Your cash pile', value: cashUsd, cls: 'text-teal' },
                    { label: 'Adds use', value: spend, cls: 'text-ink' },
                  ] as const).map((b) => (
                    <div key={b.label}>
                      <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">{b.label}</p>
                      <p className={`font-num text-lg font-semibold tabular-nums ${b.value > 0.5 ? b.cls : 'text-ink-faint'}`}>
                        {fmtUsd(b.value)}
                      </p>
                    </div>
                  ))}
                  {/* the verdict rides the same strip — one line, the story */}
                  <p
                    key={`${composed.newMoneyUsd > 1}:${composed.cashless}:${composed.cashCreditUsd > 0}`}
                    /* ONE LINE (owner ~10:0x) — the 42ch cap wrapped the
                       more-needed sentence once the verdict grew to 15px */
                    className="verdict-in ml-auto text-right sm:whitespace-nowrap"
                  >
                    {composed.newMoneyUsd > 1 ? (
                      <span className="font-display text-[15px] font-bold uppercase tracking-[0.06em] text-amber-300/90">
                        {fmtUsd(composed.newMoneyUsd)} more needed; you&rsquo;ll settle it at review
                        <InfoDot>
                          Your adds exceed what trims and your cash pile cover. The review is where
                          you choose how to settle the difference; nothing is committed here.
                        </InfoDot>
                      </span>
                    ) : composed.cashless && proceeds > spend ? (
                      <span className="font-display text-[15px] font-bold uppercase tracking-[0.06em] text-ink-dim">
                        proceeds land as cash at execution
                        <InfoDot>
                          No cash asset is held, so the freed value can&rsquo;t be shown inside the
                          mix; the sells are still recorded and execute normally.
                        </InfoDot>
                      </span>
                    ) : composed.cashCreditUsd > 0 || proceeds > spend ? (
                      <span className="font-display text-[15px] font-bold uppercase tracking-[0.06em] text-teal">
                        {fmtUsd(composed.cashCreditUsd)} lands in your cash pile
                      </span>
                    ) : (
                      <span className="font-display text-[15px] font-bold uppercase tracking-[0.06em] text-ink">
                        covered; trims and cash fund every add
                      </span>
                    )}
                  </p>
                </>
              )}
            </div>

            {/* LIST OR PICTURE, then (list only) his group pills — the same
                "Show as" idiom the portfolio page speaks. Grouping is a list
                concern; the treemap IS the picture's structure, so the pills
                that don't apply don't render. */}
            {/* ── ADD SOMETHING NEW + THE REBALANCE BAR, ABOVE THE GRID
                  (owner 2026-08-03 ~00:2x: "this bar and the rebalance bar
                  should go above the bento and list layout, below the
                  portfolio / numbers card"). The search bar keeps its 16:22
                  inline law; picks still land in the grid — now BELOW — as
                  $0 cards, and in the picture a fresh pick lands SELECTED
                  with its dial open. The execute row keeps board-on-change:
                  absent until something changed. ────────── */}
            <InlineAdd
              takenKeys={heldAndFreshKeys}
              onAdd={(asset) => {
                setFresh((cur) => (cur.some((a) => assetKey(a) === assetKey(asset)) ? cur : [...cur, asset]))
                if (view === 'picture') setDialKey(assetKey(asset).toLowerCase())
              }}
              onWatch={(asset) => {
                toggleWatch(scope, asset)
                setWatched(loadWatchlist(scope))
              }}
            />
            {/* ── THE DIAL SLOT — FIXED HEIGHT, ALWAYS THERE in the picture
                  (owner ~09:5x: "clicking open or closed the slider card
                  shouldn't move the grid below it… make it take up less
                  space"). One 72px row that is the HINT when nothing is
                  selected, the CASH SPLIT for the pile, or the compact dial
                  for an asset — the grid below never reflows on tap. Same
                  TrimBar/DollarField as the list cards: one implementation. */}
            {view === 'picture' && (
              <div
                role={dialKey ? 'group' : undefined}
                aria-label={dialKey === 'cash-pile' ? 'Your cash pile' : dialKey ? `Adjust ${dialAsset ? `$${showSymbol(dialAsset.p.asset.symbol)}` : 'position'}` : undefined}
                className="relative mt-3 flex min-h-[72px] items-center overflow-hidden rounded-2xl border bg-white/[0.03] px-4 py-2 sm:h-[72px]"
                style={{
                  borderColor:
                    dialKey === 'cash-pile'
                      ? `color-mix(in srgb, ${CASH_GREEN} 55%, transparent)`
                      : dialAsset
                        ? `color-mix(in srgb, ${tokenVisual(dialAsset.p.asset.symbol, dialAsset.p.asset.address).color} 40%, transparent)`
                        : 'rgba(255,255,255,0.10)',
                }}
              >
                {dialKey && (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-1"
                    style={{
                      background:
                        dialKey === 'cash-pile'
                          ? CASH_GREEN
                          : dialAsset
                            ? `linear-gradient(180deg, ${tokenVisual(dialAsset.p.asset.symbol, dialAsset.p.asset.address).color}, color-mix(in srgb, ${tokenVisual(dialAsset.p.asset.symbol, dialAsset.p.asset.address).color} 45%, transparent))`
                            : 'transparent',
                    }}
                  />
                )}
                {!dialKey ? (
                  /* the invitation (his ~08:4x note), living IN the slot so
                     selecting a tile swaps content instead of adding rows */
                  <p className="flex items-center gap-2.5 font-mono text-[12px] uppercase tracking-[0.14em] text-ink-dim">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-cyan" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <g>
                        <animateTransform attributeName="transform" type="translate" values="0 0; 1.6 1.6; 0 0" keyTimes="0; 0.35; 1" dur="2.2s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1; 0.4 0 0.2 1" />
                        <path d="M5 3l14 7-6.5 1.5L9 18z" fill="currentColor" fillOpacity="0.18" />
                      </g>
                    </svg>
                    Tap a tile to dial it up or down
                  </p>
                ) : dialKey === 'cash-pile' ? (
                  /* the pile: total + the SPLIT across chains (owner ~09:5x) */
                  <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: CASH_GREEN }} />
                      <span className="font-display text-base font-bold text-ink">Cash</span>
                      <span className="font-num text-sm font-semibold tabular-nums text-ink-dim">{fmtUsd(cashUsd)}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      {cashSplit.map((c) => (
                        <span key={c.symbol} className="inline-flex items-center gap-1.5 rounded-full border border-white/12 px-2.5 py-1">
                          <span className="font-display text-xs font-bold text-ink">${showSymbol(c.symbol)}</span>
                          <span className="font-num text-xs font-semibold tabular-nums text-ink-dim">{fmtUsd(c.usd)}</span>
                          {[...c.chains].map((id) => (
                            <ChainBadge key={id} chainId={id} />
                          ))}
                        </span>
                      ))}
                    </span>
                    <span className="ml-auto flex items-center gap-3">
                      <span className="hidden font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint md:inline">
                        trims fill it, adds draw on it
                      </span>
                      <button
                        type="button"
                        onClick={() => setDialKey(null)}
                        aria-label="Done"
                        className="press inline-flex h-8 items-center gap-1.5 rounded-full border border-teal/40 bg-teal/[0.08] px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-teal hover:border-teal/70"
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M5 13l4 4L19 7" />
                        </svg>
                        Done
                      </button>
                    </span>
                  </div>
                ) : dialAsset ? (
                  (() => {
                    const { p, isNew } = dialAsset
                    const key = assetKey(p.asset)
                    const cur = p.valueUsd
                    const target = targetOf(key, cur)
                    const delta = target - cur
                    const moved = Math.abs(delta) > 0.5
                    return (
                      <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="flex min-w-0 items-center gap-2">
                          {p.kind === 'basket' ? (
                            <BasketAvatar address={p.asset.address} symbol={p.asset.symbol} size={24} />
                          ) : (
                            <AssetLogo address={p.asset.address} symbol={p.asset.symbol} chainId={p.asset.chainId} size={24} />
                          )}
                          <span className="truncate font-display text-sm font-bold text-ink">${showSymbol(p.asset.symbol)}</span>
                          {isNew && (
                            <span className="rounded-full border border-cyan/40 bg-cyan/[0.08] px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.1em] text-cyan">new</span>
                          )}
                          {!isNew && (
                            <span className="hidden whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint lg:inline">
                              now {fmtUsd(cur)}
                            </span>
                          )}
                        </span>
                        <div className="min-w-[160px] flex-1">
                          <TrimBar
                            symbol={p.asset.symbol}
                            cur={cur}
                            target={target}
                            /* the rail's ceiling is WHAT YOU CAN PULL — held +
                               cash pile + freed trims (owner 2026-08-16: "i
                               have a 10k cash pile yet the slider only allows
                               me to slide up like 15$… it's not registering
                               the cash pile"). cur*2 was a position-shaped
                               bound that ignored the money standing by. */
                            scaleUsd={isNew ? Math.max(totalUsd, cashUsd + proceeds, 100) : Math.max(cur + cashUsd + proceeds, cur * 2, 100)}
                            isNew={isNew}
                            onTarget={(usd) => {
                              markDialing()
                              setTarget(key)(usd)
                            }}
                          />
                        </div>
                        {/* the DELTA, not the resulting total (his 09:47
                            recording — the dial deck was the exact surface
                            he was dragging) */}
                        <DollarField
                          delta={Math.abs(delta) > 0.5 ? delta : 0}
                          lean={moved ? (delta < 0 ? 'sell' : 'buy') : isNew ? 'buy' : 'sell'}
                          onDelta={(signed) => {
                            markDialing()
                            setTarget(key)(Math.max(0, cur + signed))
                          }}
                          label={`The change for $${showSymbol(p.asset.symbol)} in dollars — minus sells, plus buys`}
                        />
                        <span
                          className={`whitespace-nowrap rounded-full px-2 py-1 font-mono text-[8px] uppercase tracking-[0.08em] ${
                            moved && delta < 0 ? 'bg-cyan/[0.12] text-cyan' : moved ? 'bg-teal/[0.12] text-teal' : 'bg-white/[0.05] text-ink-faint'
                          }`}
                        >
                          {moved ? (
                            <>
                              {delta < 0 ? 'frees ' : 'adds '}
                              <span className="font-num text-[11px] font-semibold tabular-nums">{fmtUsd(Math.abs(delta))}</span>
                            </>
                          ) : (
                            'held'
                          )}
                        </span>
                        {isNew && (
                          <button
                            type="button"
                            onClick={() => removeFresh(key)}
                            aria-label={`Remove $${showSymbol(p.asset.symbol)}`}
                            className="press grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-magenta/60 hover:text-magenta"
                          >
                            ✕
                          </button>
                        )}
                        {/* HELD BACK FROM FIRST LAUNCH (the owner 2026-08-06):
                            the whole range-order surface is behind
                            RANGE_ORDERS_ENABLED and ships in the update AFTER
                            launch. The door is the only way in, so gating it
                            here is what makes the feature unreachable. */}
                        {RANGE_ORDERS_ENABLED && (
                        <>
                        {/* THE OTHER WAY OUT of a position (his 15:2x ask):
                            dialling trims at today's price; this ladders the
                            same position across a band and earns fees while it
                            waits. A door, not a mode switch — the dial stays
                            exactly where it was. */}
                        <button
                          type="button"
                          onClick={() => setRangeKey((k) => (k === key ? null : key))}
                          aria-pressed={rangeKey === key}
                          className={`press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
                            rangeKey === key
                              ? 'border-cyan/60 bg-cyan/[0.1] text-cyan'
                              : 'border-white/15 text-ink-dim hover:border-cyan/50 hover:text-cyan'
                          }`}
                        >
                          Sell through a range
                        </button>
                        </>
                        )}
                        <button
                          type="button"
                          onClick={() => setDialKey(null)}
                          aria-label={`Done adjusting $${showSymbol(p.asset.symbol)}`}
                          className="press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-teal/40 bg-teal/[0.08] px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-teal hover:border-teal/70"
                        >
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M5 13l4 4L19 7" />
                          </svg>
                          Done
                        </button>
                      </div>
                    )
                  })()
                ) : null}
              </div>
            )}

            {RANGE_ORDERS_ENABLED && rangeKey && (() => {
              const hit = cards.find(({ p }) => assetKey(p.asset).toLowerCase() === rangeKey.toLowerCase())
              if (!hit) return null
              return (
                <RangeOrderPanel
                  className="mt-4"
                  asset={{
                    symbol: hit.p.asset.symbol,
                    address: hit.p.asset.address,
                    chainId: hit.p.asset.chainId,
                    valueUsd: hit.p.valueUsd,
                    nowMcap: mcaps.get(assetKey(hit.p.asset)) ?? null,
                  }}
                />
              )
            })()}
            {/* ONE CONTROL ROW (owner ~10:1x: the change-count text goes,
                and the view/group/spotlight pills "line up horizontally with
                the reset pill"). ALWAYS PRESENT and height-stable — this row
                appearing at the first change once translated the whole grid
                (measured); the execute button anchors the height and waits
                disabled until a change exists (it always works once there is
                something to review, so it is not a dead control). A refusal
                still says itself in words when one applies. */}
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 sm:gap-x-6">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Show as</span>
                {([
                  { id: 'list' as const, label: 'List' },
                  { id: 'picture' as const, label: 'Picture' },
                ]).map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    aria-pressed={view === v.id}
                    onClick={() => setView(v.id)}
                    className={`press rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide transition-colors sm:px-4 ${
                      view === v.id ? 'border-cyan/60 bg-cyan/[0.1] text-ink' : 'border-white/15 text-ink-dim hover:border-white/35'
                    }`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
              {/* Group-by works on BOTH views (owner ~23:2x) — list sections,
                  picture regroups */}
              <span aria-hidden className="hidden h-4 w-px bg-white/10 sm:block" />
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Group by</span>
                {GROUPS.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    aria-pressed={groupBy === g.id}
                    onClick={() => setGroupBy(g.id)}
                    className={`press rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide transition-colors sm:px-4 ${
                      groupBy === g.id ? 'border-cyan/60 bg-cyan/[0.1] text-ink' : 'border-white/15 text-ink-dim hover:border-white/35'
                    }`}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
              {/* the category spotlight — same pills as the portfolio page */}
              <span aria-hidden className="hidden h-4 w-px bg-white/10 sm:block" />
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Spotlight</span>
                <CategoryPills pills={catPills} active={catFilter} onToggle={setCatFilter} />
              </div>
              {/* NAMED PLANS (feature 6): one pill, a floating panel (the
                  search-results idiom — nothing below moves). Adopting a plan
                  sets every dial to its weights over today's total; unheld
                  plan assets land as fresh cards. Reset still clears. */}
              <span aria-hidden className="hidden h-4 w-px bg-white/10 sm:block" />
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setPlansOpen((v) => !v)}
                  aria-expanded={plansOpen}
                  className={`press rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide transition-colors sm:px-4 ${
                    plansOpen ? 'border-cyan/60 bg-cyan/[0.1] text-ink' : 'border-white/15 text-ink-dim hover:border-white/35'
                  }`}
                >
                  Plans{plans.length > 0 ? ` · ${plans.length}` : ''}
                </button>
                {plansOpen && (
                  <div className="absolute left-0 top-full z-30 mt-2 w-72 rounded-2xl border border-white/12 bg-panel/95 p-3 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.85)] backdrop-blur-xl">
                    {plans.length === 0 && (
                      <p className="px-1 pb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                        no saved plans yet — shape one and save it
                      </p>
                    )}
                    {plans.map((pl) => (
                      <div key={pl.name} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-white/[0.04]">
                        <button
                          type="button"
                          onClick={() => {
                            // adopt: weights over today's total become dial targets
                            const w = pl.targets.reduce((t, x) => t + x.weight, 0)
                            if (w <= 0) return
                            const freshOnes = pl.targets.filter((t) => !positions.some((p) => assetKey(p.asset) === assetKey(t.asset)))
                            setFresh((cur) => [...cur, ...freshOnes.map((t) => t.asset).filter((a) => !cur.some((c) => assetKey(c) === assetKey(a)))])
                            setTargets(() => {
                              const next = new Map<string, number>()
                              for (const t of pl.targets) next.set(assetKey(t.asset), Math.round(((t.weight / w) * totalUsd) * 100) / 100)
                              return next
                            })
                            setPlansOpen(false)
                          }}
                          className="press min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate font-display text-sm font-bold text-ink">{pl.name}</span>
                          <span className="block font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
                            {pl.targets.length} asset{pl.targets.length === 1 ? '' : 's'}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            import('../lib/spectrum/allocation').then((m) => {
                              m.deleteNamedPlan(scope, pl.name)
                              setPlans(loadNamedPlans(scope))
                            })
                          }}
                          aria-label={`Delete plan ${pl.name}`}
                          className="press grid h-7 w-7 shrink-0 place-items-center rounded-full text-ink-faint hover:text-magenta"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <div className="mt-2 flex items-center gap-2 border-t border-white/8 pt-2">
                      <input
                        value={planName}
                        onChange={(e) => setPlanName(e.target.value)}
                        placeholder="Save current as…"
                        aria-label="Plan name"
                        className="h-9 min-w-0 flex-1 rounded-lg border border-white/15 bg-white/[0.04] px-3 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-cyan/60 focus:outline-none"
                      />
                      <button
                        type="button"
                        disabled={planName.trim().length === 0 || composed.targets.length === 0}
                        onClick={() => {
                          saveNamedPlan(scope, { name: planName, targets: composed.targets, savedAt: Date.now() })
                          setPlans(loadNamedPlans(scope))
                          setPlanName('')
                        }}
                        className="press inline-flex h-9 shrink-0 items-center rounded-full border border-teal/40 bg-teal/[0.08] px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-teal hover:border-teal/70 disabled:opacity-40"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="ml-auto flex items-center gap-3">
                {refusal && changed.length > 0 && (
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300/85">{refusal}</span>
                )}
                {!href && changed.length > 0 && (
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                    {saved ? 'saved on this device' : 'saves on this device'}
                  </span>
                )}
              </div>
            </div>

            {/* the flexible region: takes what's left, scrolls only if the
                portfolio genuinely cannot fit the screen */}
            {/* picture: NO scroll, ever (owner ~00:4x: "the bento should
                never have a scroll bar, it should always be visible") — its
                height is computed to fit, so overflow stays off and the
                floor is a last-resort minimum. The list keeps its scroll. */}
            <div className={view === 'picture' ? 'min-h-0 flex-1' : 'min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 [scrollbar-width:thin]'}>
            {view === 'picture' ? (
              /* THE BENTO (owner 22:00): every position a tile, sized by its
                 target, animating to its new slot as you dial. Tap = the dial
                 deck below; the grid itself stays a clean picture. Its height
                 is chrome-measured (see picH) so it fills exactly the space
                 there is: opening the deck shrinks it, and only under the
                 240px floor does the region scroll instead of clipping. */
              <div className="pt-5">
                {/* the foot is a SIBLING of the measured wrapper, so the
                    picture pays for it automatically: the sizing pass sees the
                    extra content as overflow and shrinks picH by exactly that
                    much — his "maybe it makes the basket a little bit smaller
                    in height", converged rather than hardcoded. */}
                <div ref={picWrapRef} style={{ height: picH }}>
                  <BasketBento
                    items={bentoItems}
                    fill
                    animateLayout
                    layoutMotion={dialing ? 'live' : 'glide'}
                    selectedId={dialKey}
                    groupOrder={tileGroupOrder}
                    reveal={{ delayMs: 40, stepMs: 36 }}
                    show={tilesIn}
                    onSelect={(id) => {
                      const ghost = watched.find((a) => assetKey(a).toLowerCase() === id && !heldAndFreshKeys.has(assetKey(a)))
                      if (ghost) {
                        // never append an asset already staged (the plans path
                        // beside this one has always guarded; this one did not)
                        setFresh((cur) => (cur.some((a) => assetKey(a) === assetKey(ghost)) ? cur : [...cur, ghost]))
                        setDialKey(id)
                        return
                      }
                      setDialKey((k) => (k === id ? null : id))
                    }}
                  />
                </div>
                {facetTotals.length > 1 && (
                  <MoneyFacets rows={facetTotals} size="sm" className="mt-4 justify-center border-t border-white/[0.06] pt-4" />
                )}
              </div>
            ) : (
              groups.map((g, gi) => (
              <div key={g.key} className="mt-5">
                {g.label && (
                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-dim">
                      {g.badge != null && <ChainBadge chainId={g.badge} />}
                      {g.label}
                      <span className="text-ink-faint">
                        · {g.cards.length} position{g.cards.length === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span className="font-num text-sm font-semibold tabular-nums text-ink">{fmtUsd(g.usd)}</span>
                  </div>
                )}
                {/* PHONES SWIPE, NEVER SCROLL FOREVER (owner 2026-08-15, the
                    giant mobile pass: "carousels where possible rather than
                    infinite scrolling") — the house Carousel: a snap rail
                    below sm, the exact same grid at sm+. resetKey returns the
                    rail to card one when the grouping or spotlight changes. */}
                <Carousel
                  label={`${g.label || 'positions'} cards`}
                  gridFrom="sm"
                  gridClassName="sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 sm:items-start sm:gap-2.5"
                  peek="88%"
                  resetKey={`${groupBy}|${catFilter ?? ''}`}
                >
                  {g.cards.map(({ p, isNew }, i) => {
                    const key = assetKey(p.asset)
                    return (
                      <div key={key} data-poskey={key} className={`rounded-2xl transition-opacity duration-300 ${litKey(p.asset) ? '' : 'opacity-30'}`}>
                        <AssetCard
                          p={p}
                          isNew={isNew}
                          i={gi * 3 + i}
                          target={targetOf(key, p.valueUsd)}
                          // same what-you-can-pull ceiling as the dial deck
                          scaleUsd={isNew ? Math.max(totalUsd, cashUsd + proceeds, 100) : Math.max(p.valueUsd + cashUsd + proceeds, p.valueUsd * 2, 100)}
                          onTarget={setTarget(key)}
                          onRemove={isNew ? () => removeFresh(key) : undefined}
                          expanded={openKeys.has(key) || isNew}
                          onToggle={() => toggleCard(key)}
                        />
                      </div>
                    )
                  })}
                </Carousel>
              </div>
              ))
            )}
            {lpRows.length > 0 && (
              <div className="mt-4">
                <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                  liquidity positions · view only
                </div>
                <Carousel
                  label="Liquidity positions"
                  gridFrom="sm"
                  gridClassName="sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 sm:items-start sm:gap-2.5"
                  peek="88%"
                >
                  {lpRows.map((r) => (
                    <LpCard key={`${r.chainId}:${r.symbol}`} row={r} />
                  ))}
                </Carousel>
              </div>
            )}

            </div>
          </div>
          )}
        </div>
      </div>

    </div>,
    document.body,
  )
}
