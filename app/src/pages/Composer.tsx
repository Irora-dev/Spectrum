import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router'
import { useQueries } from '@tanstack/react-query'
import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { setActiveChainId, useActiveChain } from '../lib/chain/active-chain'
import { CHAINS, SUPPORTED_CHAIN_IDS, chainCfg } from '../lib/chain/chains'
import { deploymentFor } from '../lib/chain/deployments'
import { starterSuggestionsFor } from '../lib/chain/starter-suggestions'
import { fetchAssetHistory, type ChartRange } from '../lib/spectrum/history'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { formatNav, formatPct, formatPrice, formatUsdCompact, shortAddr } from '../lib/spectrum/format'
import { tokenVisual } from '../lib/spectrum/token-meta'
import { BasketBuilder, FeeSlider, creatorShareBpsOf, resolveAsset, seedLaunchDraft, type BuilderAsset } from '../components/launch/BasketBuilder'
import { FeeSplitBar } from '../components/launch/FeeSplitBar'
import { useFeeBounds } from '../lib/spectrum/use-basket-fees'
import { isAddress } from 'viem'
import { useAccount } from 'wagmi'
import { PoolDetectionError, isRetryableDetection, rejectedV2Legs, v2LegBlockedMessage } from '../lib/pools'
import { useMinWidth } from '../lib/motion'
import { AssetSearch } from '../components/launch/AssetSearch'
import { PopularAssets } from '../components/launch/PopularAssets'
import { AssetLogo } from '../components/AssetLogo'
import { PrismAnim } from '../components/SwapPendingOverlay'
import { PageHeader } from '../components/PageHeader'
import { COMPOSER_TEMPLATES, resolveCuratedSymbols, type CuratedSet } from '../lib/spectrum/curated-tokens'
import { ChainBadge, chainMeta } from '../components/ChainBadge'
import { groupBundleDraft, isBundleDraft } from '../components/reshape/publish-bundle-model'
import { PublishBundleModal } from '../components/reshape/PublishBundleModal'
import { takeBuilderDraftForComposer } from '../components/launch/BasketBuilder'
import { markTickerDeployed } from '../lib/spectrum/launch-journey'
// The mix's pick cap is the weight law's own arithmetic (Σ=100, MIN=5 ⇒ 20) —
// the builder every pick ultimately lands in enforces the same bound, so a
// local cap here was a second statement of one constraint (it sat at 8, which
// a 3-network bundle hit fast — owner greenlit raising it 2026-08-12).
import { MAX_ASSETS } from '../lib/spectrum/weights'
import { bundleSubjectOf, clearLandedLanes, loadLandedLanes, recordLandedLane } from '../lib/spectrum/landed-lanes'
import { BasketBento, type BentoItem } from '../components/BasketBento'
import { TrimBar } from '../components/TrimBar'
import { CAP } from '../lib/spectrum/weights'
import { CreateAssetPicker, routeFeePct } from '../components/launch/CreateAssetPicker'

// ─────────────────────────────────────────────────────────────────────────────
// THE COMPOSER (/compose) — owner + R session 2026-07-07 17:19, tightened to
// the owner's 17:32 live test: composition FIRST (full launch-bar search:
// AssetSearch + PopularAssets — paste, ranks, the lot), the backtest below
// with Split ON by default from two assets, the blend priced AS A TOKEN
// ("started at $1.00 → $1.24"), forecast steppers matching the composition,
// spectral gradient dress on every card.
//
// Honesty rails (§9): the backtest is a weighted replay of real price history,
// labelled; the forecast is user-authored hypothesis, labelled louder. The
// money path stays single: Launch = seeding the builder's own draft.
// ─────────────────────────────────────────────────────────────────────────────

const RANGES: ChartRange[] = ['7D', '30D', 'ALL']

/** Map a deep-link `?chain=` value (name or numeric id) to a SUPPORTED chainId,
 *  or null. A basket is single-chain (one V2 factory per chain), so an inbound
 *  create link must name its chain.
 *
 *  NAMES RESOLVE FROM THE CHAIN TABLE'S OWN `key`, never from a map written out
 *  here. The hand-written version of this listed eth/ethereum/mainnet/base and
 *  silently omitted robinhood — which is the chain every live basket is actually
 *  on (SpectrumContracts, 2026-08-07: 21 of 21 on 4663, zero on Base or
 *  Ethereum). So the one chain a create link most needed to name was reachable
 *  only by typing its number. Deriving from `key` means a chain becomes
 *  addressable by name the moment an operator enables it, and this function
 *  cannot drift from the table again. */
export function parseChainParam(v: string | null): number | null {
  if (!v) return null
  const raw = v.trim().toLowerCase()
  const byKey = SUPPORTED_CHAIN_IDS.find((id) => chainCfg(id).key === raw)
  if (byKey != null) return byKey
  // spoken shorthands the table's keys don't carry; each still has to clear the
  // supported check below, so an alias for a disabled chain resolves to null
  const ALIASES: Record<string, number> = { eth: 1, mainnet: 1, rh: 4663, robinhoodchain: 4663 }
  const id = ALIASES[raw] ?? Number(raw)
  return Number.isInteger(id) && (SUPPORTED_CHAIN_IDS as readonly number[]).includes(id) ? id : null
}

interface ComposedAsset extends BuilderAsset {
  color: string
  /** The chain this pick was resolved on (BUNDLE MODE, the owner 2026-08-10:
   *  picks spanning networks compose a bundle, so every pick carries its own
   *  chain instead of borrowing the page's). */
  chainId: number
}

/** The one pick identity — an address alone stops being unique the moment two
 *  chains can hold picks (deterministic deploys share addresses across chains),
 *  so every map keyed by lowercase address keys by this instead. */
const keyOf = (a: { chainId: number; address: string }) => `${a.chainId}:${a.address.toLowerCase()}`

/** Symbols carried by picks on MORE THAN ONE chain — those rows disambiguate
 *  with the chain's short mark (the thesis bento's chainMark rule: only where
 *  the displayed text alone would collide). Keyed on the DISPLAYED text. */
function duplicateSymbols(assets: readonly ComposedAsset[]): Set<string> {
  const chainsOf = new Map<string, Set<number>>()
  for (const a of assets) {
    const k = a.symbol.toLowerCase()
    const set = chainsOf.get(k) ?? new Set<number>()
    set.add(a.chainId)
    chainsOf.set(k, set)
  }
  return new Set([...chainsOf.entries()].filter(([, chains]) => chains.size > 1).map(([k]) => k))
}

// ── THE COMPOSER DRAFT SURVIVES A RELOAD (2026-08-11, the parked QoL): a
// cross-network mix is minutes of picking, and a refresh threw it away. One
// versioned localStorage row: picks (chain-tagged), weights, name, ticker.
// Weights/laws re-derive; the backtest re-fetches; the scenario is deliberately
// NOT kept (forecast points are a thought-experiment, not a draft). Validated
// field-by-field on read — a corrupt row reads as no draft, never a crash.
const COMPOSER_DRAFT_KEY = 'spectrum:composer-draft:v1'

interface ComposerDraftRow {
  assets: ComposedAsset[]
  weights: number[]
  name: string
  symbol: string
  savedAt: number
}

function loadComposerDraft(): ComposerDraftRow | null {
  try {
    const raw = localStorage.getItem(COMPOSER_DRAFT_KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<ComposerDraftRow>
    if (!Array.isArray(d.assets) || !Array.isArray(d.weights)) return null
    if (d.assets.length === 0 || d.assets.length !== d.weights.length) return null
    const ok = d.assets.every(
      (a) =>
        a &&
        typeof a.address === 'string' &&
        /^0x[0-9a-fA-F]{40}$/.test(a.address) &&
        Number.isInteger(a.chainId) &&
        (SUPPORTED_CHAIN_IDS as readonly number[]).includes(a.chainId) &&
        typeof a.symbol === 'string' &&
        typeof a.decimals === 'number' &&
        a.route != null,
    )
    if (!ok || !d.weights.every((w) => Number.isFinite(w))) return null
    // HEAL, don't crash (2026-08-12): a draft row missing `warnings` (hand-
    // crafted, or written before the field existed) sailed through this
    // validator, and launchIt later seeded it into the BUILDER's draft — whose
    // restore runs `warnings.filter(…)` and took the whole page down with it
    // (the error boundary ate /create). A missing array reads as empty; the
    // row stays a valid draft.
    for (const a of d.assets) if (!Array.isArray(a.warnings)) a.warnings = []
    // same heal for the venue label (2026-08-13): the leg lists now PRINT it,
    // and a row written before the field existed would have taken the page
    // down on `.replace` exactly the way the missing `warnings` array did.
    for (const a of d.assets) if (typeof a.venueLabel !== 'string') a.venueLabel = ''
    return {
      assets: d.assets,
      weights: d.weights,
      name: typeof d.name === 'string' ? d.name : '',
      symbol: typeof d.symbol === 'string' ? d.symbol : '',
      savedAt: typeof d.savedAt === 'number' ? d.savedAt : 0,
    }
  } catch {
    return null
  }
}

// spectral p-px dress (the auction-canvas idiom) — subtle, not neon
const CARD_GRAD = 'linear-gradient(135deg, rgba(53,224,255,0.35), rgba(164,139,255,0.18) 45%, rgba(255,77,184,0.28))'
// the house's full-strength spectral fill — the create CTA's own, now shared
// with the step spine's live mark (one string, so the two cannot drift)
const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

/** `fill`: the card becomes a COLUMN that takes the height it is given and lets
 *  its child spend it — the choose page's one-viewport budget (2026-08-13).
 *  Off, it is the flowing card every other station uses, byte-identical. */
function Card({ children, className = '', fill = false }: { children: React.ReactNode; className?: string; fill?: boolean }) {
  return (
    <div className={`rounded-3xl p-px ${fill ? 'flex min-h-0 flex-1 flex-col' : ''}`} style={{ background: CARD_GRAD }}>
      <section
        className={`rounded-[calc(var(--radius-3xl)_-_1px)] bg-panel/92 backdrop-blur-md ${fill ? 'flex min-h-0 flex-1 flex-col' : ''} ${className}`}
      >
        {children}
      </section>
    </div>
  )
}

// ── weights: keep Σ=100, min 1, redistribute proportionally ────────────────
function rebalanceOthers(weights: number[], changed: number, next: number): number[] {
  const n = weights.length
  if (n === 1) return [100]
  const target = Math.min(100 - (n - 1), Math.max(1, Math.round(next)))
  const othersSum = weights.reduce((s, w, i) => (i === changed ? s : s + w), 0)
  const room = 100 - target
  const out = weights.map((w, i) => {
    if (i === changed) return target
    return othersSum > 0 ? Math.max(1, Math.round((w / othersSum) * room)) : Math.max(1, Math.round(room / (n - 1)))
  })
  let drift = 100 - out.reduce((s, w) => s + w, 0)
  while (drift !== 0) {
    let idx = -1
    let best = -1
    out.forEach((w, i) => {
      if (i !== changed && ((drift > 0 && w >= best) || (drift < 0 && w > 1 && (idx === -1 || w > out[idx])))) {
        best = w
        idx = i
      }
    })
    if (idx === -1) idx = changed
    out[idx] += drift > 0 ? 1 : -1
    drift += drift > 0 ? -1 : 1
  }
  return out
}

/** A TICKER SUGGESTED FROM A NAME (owner 2026-08-12) — the initials of a
 *  multi-word name ("Blue Chip Majors" → BCM), else the name's own letters
 *  ("Bluechip" → BLUECHI). Alphanumeric only, uppercase, 11 max: the same
 *  shape the ticker field itself enforces, so a suggestion is never a value
 *  the field would have rejected. Purely a starting point — the field stops
 *  following the name the moment anyone types in it. */
function tickerFromName(raw: string): string {
  const words = raw.trim().split(/\s+/).filter(Boolean)
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const initials = words.length > 1 ? words.map((w) => clean(w).slice(0, 1)).join('') : ''
  return (initials.length >= 2 ? initials : clean(words.join(''))).slice(0, 11)
}

/** THE ONE-VIEWPORT BUDGET, MEASURED (the owner 2026-08-13: "this whole thing
 *  should use more height whilst staying on the one viewport").
 *
 *  The choose page used to be a stack that happened to overflow by 32px; now it
 *  is a column handed exactly the height that is left over, so it FILLS 900 and
 *  fills 1200 without ever scrolling. Nothing is hardcoded — the block's own
 *  document offset (masthead, spine, everything above it) plus everything that
 *  renders BELOW it inside the document (the main column's bottom padding and
 *  the site footer) come off the viewport height. A banner dismissal, a resize,
 *  a footer that wraps to another line: the observer re-measures and the column
 *  re-fills. Returns undefined when the leftover is too small to be a page —
 *  that is a phone, and the phone face flows and docks instead. */
function useViewportBudget(ref: React.RefObject<HTMLElement | null>, on: boolean): number | undefined {
  const [h, setH] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (!on) {
      setH(undefined)
      return
    }
    const measure = () => {
      const el = ref.current
      if (!el) return
      // document offset, not viewport offset — stable whatever the scroll is
      const top = el.getBoundingClientRect().top + window.scrollY
      const main = el.closest('main')
      const padBottom = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0
      const footer = document.querySelector('footer')
      const footerH = footer ? footer.getBoundingClientRect().height : 0
      const avail = Math.floor(window.innerHeight - top - padBottom - footerH)
      setH(avail >= MIN_CHOOSE_HEIGHT ? avail : undefined)
    }
    measure()
    window.addEventListener('resize', measure)
    // WHAT ACTUALLY MOVES THE BUDGET: anything that appears ABOVE this block in
    // the page column, and the footer's height. Measured 2026-08-13: another
    // lane's 223px "continue your launch" card mounts above the masthead on
    // /create and the budget has to see it arrive AND leave.
    //
    // OBSERVE THE SIBLINGS, NOT THE CONTAINER. `main` is a flex-1 child of a
    // min-h-full column, so its own box does not change when its content grows
    // or shrinks — a ResizeObserver on `main` (or on `body`, which is
    // height:100%) is deaf to exactly the event this needs. Each DIRECT CHILD
    // of main is content-sized, so watching them catches a card appearing,
    // resizing, or hiding; a MutationObserver on main's child list re-attaches
    // when the set of children itself changes. Our own height feeds back into
    // this, but `top` and the footer do not depend on it, so the value
    // converges rather than oscillating (and an identical setH is a no-op).
    const main = ref.current?.closest('main')
    const footer = document.querySelector('footer')
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    const attach = () => {
      if (!ro) return
      ro.disconnect()
      if (main) for (const child of Array.from(main.children)) ro.observe(child)
      if (footer) ro.observe(footer)
    }
    attach()
    const mo =
      typeof MutationObserver !== 'undefined' && main
        ? new MutationObserver(() => {
            attach()
            measure()
          })
        : null
    mo?.observe(main as Element, { childList: true })
    return () => {
      window.removeEventListener('resize', measure)
      ro?.disconnect()
      mo?.disconnect()
    }
  }, [ref, on])
  return h
}

/** Below this, the leftover is not a page — three rows of cards plus a search
 *  and the picks bar cannot honestly live in it, so the column stops pretending
 *  and flows (the phone face). Measured against the choose page's own anatomy:
 *  search 48 + three 76px rows + the picks bar + the seams between them. */
const MIN_CHOOSE_HEIGHT = 420

function equalWeights(n: number): number[] {
  const base = Math.floor(100 / n)
  const out = Array(n).fill(base)
  out[0] += 100 - base * n
  return out
}

// ── the forecast model (owner 17:53): dated price points ────────────────────
// "By this date I think this token will be at this price" — several dates per
// token if you like. The scenario path replays them through the mix; assets
// without a point hold flat. Hypothesis, never a prediction (§9).
interface ForecastPoint {
  id: string
  /** yyyy-mm-dd — the native date input's value */
  date: string
  /** target USD price, free-typed */
  price: string
}

let pointSeq = 0
const nextPointId = () => `fp${++pointSeq}`

const DAY_MS = 86_400_000
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const dateToUnix = (d: string): number | null => {
  const t = Date.parse(`${d}T00:00:00Z`)
  return Number.isFinite(t) ? t / 1000 : null
}

// Full-decimal price → input string (4 sig figs, never scientific notation —
// micro-caps must round-trip through the input unmangled).
function priceToInput(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return ''
  if (p >= 1) return p.toFixed(2)
  const m = p.toFixed(20).match(/^0\.(0*)([1-9]\d{0,3})/)
  return m ? `0.${m[1]}${m[2]}`.replace(/0+$/, '').replace(/\.$/, '') : String(p)
}

const shortMonthDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })

// ── natural-language forecast entry (owner 19:15: "just have a natural language
// search bar with suggestions — I think syrup will be this price on this date") ──
// Parse "SYRUP to $0.50 by Aug 30" into {asset, price, date}. Price must be
// $-prefixed or keyword-led (to/at/be/hit/reach/worth) so a bare number is never
// mistaken for the day; date handles ISO, "in N days/weeks/months", and
// "<month> <day> [year]" (a past day with no year rolls to next year).
const NL_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function parseDatePhrase(s: string, nowMs: number): string | null {
  const t = s.toLowerCase()
  const iso = t.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/)
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]))
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
  }
  const rel = t.match(/in\s+(\d+)\s*(day|week|month|year)/)
  if (rel) {
    const n = parseInt(rel[1], 10)
    const mult = rel[2][0] === 'd' ? 1 : rel[2][0] === 'w' ? 7 : rel[2][0] === 'm' ? 30 : 365
    return isoDay(nowMs + n * mult * DAY_MS)
  }
  const mi = NL_MONTHS.findIndex((m) => t.includes(m))
  if (mi >= 0) {
    const day = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/)
    const yr = t.match(/\b(20\d{2})\b/)
    if (day) {
      const dd = parseInt(day[1], 10)
      if (dd < 1 || dd > 31) return null
      let year = yr ? parseInt(yr[1], 10) : new Date(nowMs).getUTCFullYear()
      if (!yr && Date.UTC(year, mi, dd) < nowMs) year += 1
      const dt = new Date(Date.UTC(year, mi, dd))
      return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10)
    }
  }
  return null
}

interface ParsedForecast {
  /** The matched pick's keyOf identity (chain-qualified, never a bare address). */
  key: string | null
  symbol: string | null
  price: number | null
  dateISO: string | null
}

function parseForecastEntry(text: string, assets: ComposedAsset[], nowMs: number): ParsedForecast {
  let work = ` ${text.toLowerCase()} `
  let key: string | null = null
  let symbol: string | null = null
  for (const a of assets) {
    const re = new RegExp(`\\b${a.symbol.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    if (re.test(work)) {
      key = keyOf(a)
      symbol = a.symbol
      work = work.replace(re, ' ')
      break
    }
  }
  let price: number | null = null
  const dollar = work.match(/\$\s*([0-9]*\.?[0-9]+)/)
  if (dollar) {
    price = parseFloat(dollar[1])
    work = work.replace(dollar[0], ' ')
  } else {
    const kw = work.match(/(?:to|at|be|hit|reach|worth)\s+\$?\s*([0-9]*\.?[0-9]+)/)
    if (kw) {
      price = parseFloat(kw[1])
      work = work.replace(kw[0], ' ')
    }
  }
  if (price != null && (!Number.isFinite(price) || price <= 0)) price = null
  // date parses from the REMAINDER (price already stripped, so its digits can't
  // be misread as the day).
  const dateISO = parseDatePhrase(work, nowMs)
  return { key, symbol, price, dateISO }
}

/** THE LEG'S VENUE, SAID WHERE THE LEGS ARE LISTED (2026-08-13, off a live
 *  failure): the rehearsal deployments' basket constructor REJECTS a Uniswap V2
 *  route — it reverts InvalidEthPool, which reaches the creator only as
 *  CREATE2Failed — while the kit's pool detector still routes a leg through V2
 *  whenever a V2 pair wins the depth ranking. Such a leg mines, prices and
 *  previews perfectly and then bricks the deploy at simulate, on both rehearsal
 *  chains; the owner lost a bundle publish to exactly that. The create face listed
 *  its picks without ever naming their venue, so the leg that would brick the
 *  publish was invisible until the publish failed.
 *
 *  This SHOWS, it does not decide: no pick is blocked and no venue is
 *  substituted here. The wording is the builder's own leg chip (BasketBuilder:
 *  `venueLabel` minus its "Uniswap " prefix), and V2 wears the amber the flow
 *  already gives blockers.
 *
 *  WHETHER a leg is refused is not this file's opinion: it asks lib/pools'
 *  v2-legs — the one module that owns the rule and its sentence — per leg on
 *  THAT LEG'S OWN CHAIN (a bundle spans networks, and a chain with no rejecting
 *  factory must not be given a scary mark). Nothing here rewords the refusal.
 *
 *  A draft restored from before the field existed carries no label — the chip
 *  renders nothing rather than inventing one. */
/** "V3 · 0.3%" — the venue's words, said ONCE for every surface that carries
 *  them (the chip here, page 1's picked rail): the label minus its "Uniswap "
 *  prefix, plus the fee tier where the route states one (the owner 2026-08-13:
 *  "we could just take V3 · 0.3% fee and surface it when you do click and add
 *  an asset to the basket"). routeFeePct never guesses — a V2 pair's fee is
 *  not in the route struct, so a V2 leg reads plain "V2". */
function venueShort(a: ComposedAsset): string {
  const label = typeof a.venueLabel === 'string' ? a.venueLabel.replace('Uniswap ', '').trim() : ''
  if (!label) return ''
  const fee = routeFeePct(a.route)
  return fee != null ? `${label} · ${fee}%` : label
}

function venueTitle(a: ComposedAsset): string {
  const fee = routeFeePct(a.route)
  return `Routes through ${a.venueLabel}${fee != null ? ` at the ${fee}% fee tier` : ''}`
}

function VenueChip({ a }: { a: ComposedAsset }) {
  const label = venueShort(a)
  if (!label) return null
  const rejected = rejectedV2Legs([a], a.chainId).length > 0
  return (
    <span
      title={rejected ? v2LegBlockedMessage([showSymbol(a.symbol)]) : venueTitle(a)}
      className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${
        rejected ? 'border-amber-400/45 bg-amber-400/10 text-amber-200' : 'border-white/12 text-ink-dim'
      }`}
    >
      {rejected ? `\u26a0 ${label}` : label}
    </span>
  )
}

/** One picked asset's row — logo (on ITS chain), live move, weight controls.
 *  Extracted so the flat mix and bundle mode's per-network groups render the
 *  exact same row. Weights stay index-aligned to the page's arrays; the row
 *  only ever speaks in the original index. */
function PickRow({
  a,
  i,
  weight,
  perAssetPct,
  range,
  onWeight,
  onRemove,
}: {
  a: ComposedAsset
  i: number
  weight: number
  perAssetPct: Map<string, number>
  range: ChartRange
  onWeight: (i: number, next: number) => void
  onRemove: (i: number) => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2.5 transition-colors hover:border-white/15">
      <span aria-hidden className="h-6 w-1 shrink-0 rounded-full" style={{ background: a.color }} />
      <AssetLogo address={a.address} symbol={a.symbol} chainId={a.chainId} size={26} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate font-display text-sm font-bold uppercase tracking-wide text-ink">{showSymbol(a.symbol)}</span>
          <VenueChip a={a} />
        </span>
        <span className="block truncate font-mono text-[9px] text-ink-faint">
          {perAssetPct.has(keyOf(a)) ? (
            <span className={perAssetPct.get(keyOf(a))! >= 0 ? 'text-teal' : 'text-magenta'}>
              {formatPct(perAssetPct.get(keyOf(a))!, 1)} {range}
            </span>
          ) : (
            'loading…'
          )}
          {a.depthUsd != null && <span> · {formatUsdCompact(a.depthUsd)} pool</span>}
          {/* THE ADDRESS ITSELF, one link away (the owner 2026-08-13, the deeper
              provenance): the shape row is where it lives — the picker card is
              a button and cannot honestly nest a link. Inline py keeps the tap
              area at the floor without moving the 9px line. */}
          {' · '}
          <a
            href={`${chainCfg(a.chainId).explorer}/address/${a.address}`}
            target="_blank"
            rel="noopener noreferrer"
            title={`${a.address} — open on the explorer`}
            className="py-2 text-ink-faint underline decoration-white/20 underline-offset-2 hover:text-cyan"
          >
            {shortAddr(a.address)} ↗
          </a>
        </span>
      </span>
      <div className="flex items-center gap-1.5">
        <Stepper label={`${showSymbol(a.symbol)} weight`} onStep={(d) => onWeight(i, weight + d)} />
        <span className="flex items-center rounded-md border border-white/10 px-1.5 py-1">
          <input
            value={String(weight)}
            onChange={(e) => {
              const v = parseInt(e.target.value.replace(/[^0-9]/g, ''), 10)
              if (Number.isFinite(v)) onWeight(i, v)
            }}
            inputMode="numeric"
            aria-label={`${showSymbol(a.symbol)} weight percent`}
            className="w-9 bg-transparent text-right font-num text-sm tabular-nums text-ink outline-none"
          />
          <span className="ml-0.5 font-mono text-[10px] text-ink-faint">%</span>
        </span>
      </div>
      <button
        type="button"
        onClick={() => onRemove(i)}
        className="press ml-1 grid h-7 w-7 place-items-center rounded-md text-ink-faint hover:bg-white/8 hover:text-ink"
        aria-label={`Remove ${showSymbol(a.symbol)}`}
      >
        ✕
      </button>
    </div>
  )
}

function Stepper({ onStep, label }: { onStep: (d: number) => void; label: string }) {
  return (
    <>
      <button
        type="button"
        onClick={() => onStep(-5)}
        className="press grid h-7 w-7 place-items-center rounded-md border border-white/10 text-ink-dim hover:border-white/30 hover:text-ink"
        aria-label={`Decrease ${label}`}
      >
        −
      </button>
      <button
        type="button"
        onClick={() => onStep(5)}
        className="press grid h-7 w-7 place-items-center rounded-md border border-white/10 text-ink-dim hover:border-white/30 hover:text-ink"
        aria-label={`Increase ${label}`}
      >
        +
      </button>
    </>
  )
}

// ── TWO FACES, ONE MACHINE (owner 2026-08-12: "/create … should show the nice
// create system we had before where you selected any asset and then you saw
// the bento grid and could click on an asset and reshape it by dragging the
// slider, this composer is old and horrible") — `face` picks the DRESSING,
// never the machinery:
//   'research' (default — /compose, /createbasket): the full bench, byte-
//     identical to what those routes always rendered.
//   'create' (bare /create): THE STAGED CREATE SYSTEM (owner 2026-08-12,
//     round 3 + addenda — "the old system's flow"), three pages on one state:
//       1 CHOOSE — one viewport, never scrolls: the cross-chain picker
//         (CreateAssetPicker — search every network, three-row browse grid),
//         the picks as logo CIRCLES at the bottom (✕ each · start fresh),
//         Continue arming at two picks. The draft restore folds into the
//         circles — restored picks just ARE them.
//       2 SHAPE — the bento + TrimBar mix card (Picture leading), a compact
//         cross-chain add bar on-page, back preserves everything.
//       3 PUBLISH — name + ticker + THE FEE STATION (the builder's own
//         FeeSlider dials + FeeSplitBar + payout, one implementation) +
//         the publish CTA.
//     No backtest, forecast, templates, or chain toggle on this face.
//     The weights law, the bundle derivation and both publish seams are the
//     same code paths — the fee dials PREFILL them (seedLaunchDraft's fee
//     fields · PublishBundleModal's initial* props), never bypass them.
export function Composer({
  embedded = false,
  face = 'research',
}: { embedded?: boolean; face?: 'research' | 'create' } = {}) {
  const createFace = face === 'create'
  const { chainId } = useActiveChain()
  const cfg = chainCfg(chainId)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { data: allBaskets } = useAllBaskets()

  // boot from the saved draft ONCE (lazy initializers share one read)
  const bootDraft = useRef<ComposerDraftRow | null | undefined>(undefined)
  if (bootDraft.current === undefined) {
    bootDraft.current = loadComposerDraft()
    // THE STUDIO MIGRATION (the owner live 2026-08-15: "Pick up where you left
    // off doesn't work") — with no composer draft, a studio-era builder draft
    // adopts forward ONCE (the taker deletes its row; from here this page's
    // own persistence owns it, and the journey follows).
    if (!bootDraft.current) {
      const taken = takeBuilderDraftForComposer(SUPPORTED_CHAIN_IDS)
      if (taken) {
        bootDraft.current = {
          assets: taken.assets.map((a) => ({ ...a, chainId: taken.chainId, color: tokenVisual(a.symbol, a.address).color })) as ComposerDraftRow['assets'],
          weights: taken.weights,
          name: taken.name,
          symbol: taken.symbol,
          savedAt: Date.now(),
        } as ComposerDraftRow
      }
    }
  }
  const [assets, setAssets] = useState<ComposedAsset[]>(() => bootDraft.current?.assets ?? [])
  const [weights, setWeights] = useState<number[]>(() => bootDraft.current?.weights ?? [])
  const [range, setRange] = useState<ChartRange>('30D')
  // Split is the DEFAULT view (owner 17:32) — it only draws from 2 assets.
  const [split, setSplit] = useState(true)
  const [scenario, setScenario] = useState<Record<string, ForecastPoint[]>>({})
  // the natural-language forecast bar's text (owner 19:15)
  const [fcInput, setFcInput] = useState('')
  // the "what is this?" forecast explainer popup (owner 19:15)
  const [fcInfoOpen, setFcInfoOpen] = useState(false)
  const [name, setName] = useState(() => bootDraft.current?.name ?? '')
  const [symbol, setSymbol] = useState(() => bootDraft.current?.symbol ?? '')
  // A SUGGESTION, NEVER A RULE (owner 2026-08-12: the ticker should auto-suggest
  // from the name, "editable, never enforced"). The moment anyone types in the
  // ticker field it stops following the name — including a restored draft, whose
  // ticker was already somebody's choice.
  const symbolTouched = useRef(!!bootDraft.current?.symbol)
  // the restore, SAID (owner 2026-08-12 QoL round: simple + easy) — a silent
  // restore reads as "why is my mix full?"; the chip names it and offers the
  // fresh start in one tap. Dismisses itself the moment the mix is touched.
  const [restoredAt, setRestoredAt] = useState<number | null>(() =>
    bootDraft.current && bootDraft.current.savedAt > 0 ? bootDraft.current.savedAt : null,
  )
  // PICTURE-LEADS (owner 2026-08-12: "use the slider to reweight each asset
  // after clicking on it on the bento layout much like the portfolio reshape
  // system") — the real BasketBento as tiles-as-controls + the real TrimBar
  // in a FIXED dial slot (the reshape law: the grid below never reflows on
  // tap). 1%-granular here — the composer's own floor, no 5-snap.
  const [mixView, setMixView] = useState<'picture' | 'list'>('picture')
  // THE TAP NUDGE (the owner live 2026-08-15: "a little tap glow around the bento
  // asset for a second or two at the start") — the largest tile wears the
  // arrival ring briefly when the picture first shows, teaching the tap.
  const [tapNudge, setTapNudge] = useState(true)
  useEffect(() => {
    if (mixView !== 'picture') return
    setTapNudge(true)
    const t = window.setTimeout(() => setTapNudge(false), 2_200)
    return () => window.clearTimeout(t)
  }, [mixView])
  const [dial, setDial] = useState<string | null>(null)
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
  const dialIndex = dial ? assets.findIndex((a) => keyOf(a) === dial) : -1
  const [adding, setAdding] = useState(false)
  // the in-flight PICK — drives the pending popup card (the swap flow's own
  // rings) while resolveAsset probes the chain
  const [addingPick, setAddingPick] = useState<{ chainId: number; address: string; symbol?: string } | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  // THE FEW-SECONDS TOAST (owner 2026-08-15: the hooked-pool refusal should be
  // "a pop up that stays for a few seconds" with less text) — refusals about
  // the TOKEN (not the user's input) float and clear themselves; inline
  // addError stays for everything the user needs to act on in the form.
  const [addToast, setAddToast] = useState<string | null>(null)
  useEffect(() => {
    if (!addToast) return
    const t = setTimeout(() => setAddToast(null), 6_000)
    return () => clearTimeout(t)
  }, [addToast])
  // Launch-in-a-popup (owner 17:53): the REAL BasketBuilder in a dialog, so
  // launching never leaves the composer. Seeding stays the single money path.
  const [launchOpen, setLaunchOpen] = useState(false)
  // The chain the open launch dialog's draft was seeded for — BasketBuilder
  // self-pins to the ACTIVE chain, so the dialog is only honest while these
  // two agree (the guard effect below closes it the moment they diverge).
  const [launchChain, setLaunchChain] = useState<number | null>(null)
  // BUNDLE MODE's own ceremony door (the owner 2026-08-10): picks spanning >1
  // network publish as one basket per network through PublishBundleModal.
  const [publishOpen, setPublishOpen] = useState(false)
  // Set by the ceremony the moment every lane lands: on the next close the
  // mix clears — a published draft left sitting in the composer is an
  // accidental-double-publish invitation (each deploy costs real money).
  const publishedRef = useRef(false)
  // Deploys that landed in an INTERRUPTED ceremony (closed mid-run): remembered
  // here so reopening seeds them as done lanes instead of deploying paid
  // duplicates — with the NAME they shipped under, so a composer-field edit
  // between runs cannot rename half a bundle. Cleared with the mix once the
  // whole bundle lands. PERSISTED beside the draft (2026-08-12 audit): a
  // useRef alone died on reload while the draft survived, so a reload
  // mid-bundle re-armed already-paid lanes.
  // ⚠ HYDRATED AT PUBLISH-OPEN, NOT AT MOUNT (the 2026-08-14 hijack: these
  // used to load the persisted row unconditionally, so a BRAND-NEW draft
  // inherited an old interrupted run — locked to its name, lanes pre-done,
  // "won't redeploy"). The row seeds a ceremony only when it was deploying
  // THIS draft's subject; see launchIt. A foreign row PARKS instead:
  const landedRef = useRef<Map<number, `0x${string}` | null>>(new Map())
  const landedNameRef = useRef<string | null>(null)

  // ── THE STAGED CREATE FACE (owner 2026-08-12 round 3): choose → shape →
  // publish, three dressings of this one state. Research face never leaves
  // 'choose' conceptually — its gates below all test `createFace` first. ──
  const [stage, setStage] = useState<'choose' | 'shape' | 'publish'>('choose')
  // THE CHOOSE PAGE IS A COLUMN THAT FILLS ITS BUDGET (the owner 2026-08-13). The
  // one-viewport law used to be a ceiling to squeeze under; it is a budget to
  // SPEND now — the card takes the leftover height and the picker's grid
  // stretches three rows across it. A phone is not in this posture: its page
  // is taller than its viewport by nature, so it flows and docks its CTA.
  const wideEnoughToFill = useMinWidth(640)
  const chooseRef = useRef<HTMLDivElement>(null)
  const chooseHeight = useViewportBudget(chooseRef, createFace && stage === 'choose' && wideEnoughToFill)
  const fillsViewport = createFace && stage === 'choose' && wideEnoughToFill && chooseHeight != null
  // the spine's own text, in order — one place, so the pages cannot disagree
  const STAGES = [
    { key: 'choose' as const, label: 'Choose' },
    { key: 'shape' as const, label: 'Shape' },
    { key: 'publish' as const, label: 'Name & publish' },
  ]
  // Emptying the mix mid-flow (removing every pick, a published bundle
  // clearing) drops the later stages' subjects — fall back rather than strand.
  useEffect(() => {
    if (!createFace) return
    if (assets.length === 0 && stage !== 'choose') setStage('choose')
    else if (assets.length < 1 && stage === 'publish') setStage('shape')
  }, [createFace, assets.length, stage])

  // ── the publish stage's FEE STATION (owner addendum: "the last step
  // (naming the basket) should also include the fee configuration") — the
  // ceremony's exact posture: defaults are what the handoffs always self-
  // healed to (1% clamped into bounds · share at the cap · payout = the
  // wallet), the dials PREFILL the real flows, and validation is the
  // ceremony's own law (empty payout = "this wallet"; EIP-55 checksum is
  // evidence — mixed case must verify, PublishBundleModal ~278). Bounds read
  // from the mix's first chain, the ceremony's own convention. ──
  const { address: account } = useAccount()
  const { data: feeBounds } = useFeeBounds(assets[0]?.chainId ?? chainId)
  const [feePct, setFeePct] = useState(() =>
    (Math.min(Math.max(100, feeBounds.minFeeBps), feeBounds.maxFeeBps) / 100).toFixed(2),
  )
  const [creatorSharePct, setCreatorSharePct] = useState(() => String(feeBounds.maxCreatorShareBps / 100))
  const [creatorPayout, setCreatorPayout] = useState('')
  const feeBpsSet = (() => {
    const v = parseFloat(feePct)
    return isFinite(v) && v > 0 ? Math.round(v * 100) : null
  })()
  const feeInBounds = feeBpsSet != null && feeBpsSet >= feeBounds.minFeeBps && feeBpsSet <= feeBounds.maxFeeBps
  const creatorShareBps = creatorShareBpsOf(creatorSharePct, feeBounds.maxCreatorShareBps)
  const payoutTrimmed = creatorPayout.trim()
  const payoutHasCase = /[a-f]/.test(payoutTrimmed.slice(2)) && /[A-F]/.test(payoutTrimmed.slice(2))
  const payoutValid = payoutTrimmed === '' || isAddress(payoutTrimmed, { strict: payoutHasCase })
  const feeValid = feeInBounds && (creatorShareBps === 0 || payoutValid)

  useEffect(() => {
    if (!launchOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [launchOpen])

  // Switching chains KEEPS the mix (the owner 2026-08-10: picking assets on
  // different networks composes a BUNDLE — which is only possible if a switch
  // keeps the picks; this supersedes the 2026-07-07 clear-on-switch ruling,
  // whose rationale was that untagged addresses are meaningless off their
  // chain — every pick now carries its own chainId, so nothing is orphaned).
  // The switch changes WHICH CHAIN YOU'RE ADDING FROM, nothing else. Only the
  // single-chain launch dialog closes, and only when the new active chain no
  // longer matches the draft it was seeded for.
  const prevChainRef = useRef(chainId)
  useEffect(() => {
    if (prevChainRef.current === chainId) return
    prevChainRef.current = chainId
    setAddError(null)
    if (launchOpen && launchChain !== chainId) setLaunchOpen(false)
  }, [chainId, launchOpen, launchChain])

  // persist the draft as it changes; an emptied mix clears the row (deliberate
  // removal must not resurrect on the next visit)
  useEffect(() => {
    try {
      if (assets.length === 0) {
        localStorage.removeItem(COMPOSER_DRAFT_KEY)
        return
      }
      localStorage.setItem(
        COMPOSER_DRAFT_KEY,
        JSON.stringify({ assets, weights, name, symbol, savedAt: Date.now() } satisfies ComposerDraftRow),
      )
    } catch {
      // storage full/blocked — the draft is a convenience, never load-bearing
    }
  }, [assets, weights, name, symbol])

  // the launch page's own popular-assets suggestions: constituents of live
  // baskets, backstopped by the live-proven per-chain starter set (owner
  // 2026-07-30; lib/chain/starter-suggestions.ts) so a young chain still shelves
  const suggestions = useMemo(() => {
    const freq = new Map<string, { address: string; symbol: string; n: number }>()
    const usdc = cfg.usdc?.toLowerCase()
    const weth = cfg.weth?.toLowerCase()
    for (const ix of allBaskets ?? []) {
      if (ix.chainId !== chainId) continue
      for (const t of ix.top) {
        const k = t.address.toLowerCase()
        if (k === usdc || k === weth) continue
        const cur = freq.get(k)
        if (cur) cur.n += 1
        else freq.set(k, { address: t.address, symbol: t.symbol, n: 1 })
      }
    }
    const organic = [...freq.values()].sort((a, b) => b.n - a.n)
    const seen = new Set(organic.map((s) => s.address.toLowerCase()))
    const starters = starterSuggestionsFor(chainId)
      .filter((s) => !seen.has(s.address.toLowerCase()))
      .map((s) => ({ ...s, n: 0 }))
    return [...organic, ...starters].slice(0, 10)
  }, [allBaskets, chainId, cfg.usdc, cfg.weth])

  /** The research face's picker speaks in the ACTIVE chain (the header toggle
   *  is "which network am I adding from"). */
  async function addAsset(address: string, knownSymbol?: string) {
    return addAssetOn(chainId, address, knownSymbol)
  }

  /** CROSS-CHAIN PICKS (owner 2026-08-12 round 2): the create face's picker
   *  hands the HIT'S OWN chain — searching every network at once means a pick
   *  can land off the header toggle, which is what composes a bundle naturally.
   *  Same body, same refusal law as always; only the chain is a parameter. */
  async function addAssetOn(onChain: number, address: string, knownSymbol?: string) {
    if (assets.length >= MAX_ASSETS || adding) return
    // the same token on ANOTHER chain is a legitimate bundle pick — only the
    // exact (chain, address) pair is a duplicate
    if (assets.some((a) => a.chainId === onChain && a.address.toLowerCase() === address.toLowerCase())) return
    setAdding(true)
    // the pending card's subject (the owner 2026-08-13: a pick "takes a while to
    // add" with nothing on screen — the resolve is a real on-chain probe).
    // Held separately from `adding`: applyTemplate shares the flag but has no
    // single subject to show.
    setAddingPick({ chainId: onChain, address, symbol: knownSymbol })
    setAddError(null)
    try {
      // a client-side timeout so the pending card can never HANG (audit 2026-
      // 08-13): resolveAsset is an on-chain probe, and an RPC that accepts the
      // connection but never answers would leave "Adding…" up forever and
      // `adding` stuck true, blocking every further add. Race it against a
      // reject so the finally always fires and the user gets a retry.
      const resolved = await Promise.race([
        resolveAsset(address, onChain, knownSymbol),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The network did not answer in time — try again.')), 25_000)),
      ])
      const withColor: ComposedAsset = { ...resolved, chainId: onChain, color: tokenVisual(resolved.symbol, resolved.address).color }
      setAssets((prev) => [...prev, withColor])
      setWeights((prev) => equalWeights(prev.length + 1))
      setRestoredAt(null)
    } catch (e) {
      if (e instanceof PoolDetectionError && e.code === 'HOOKED_MARKET') setAddToast(e.message)
      else setAddError(e instanceof Error ? e.message.split('\n')[0].slice(0, 140) : 'Could not add that asset.')
    } finally {
      setAdding(false)
      setAddingPick(null)
    }
  }

  // Start from a template (owner 2026-07-07): resolve the set's symbols to
  // canonical tokens on this chain, then REPLACE the (empty) mix with them at
  // equal weight. Only listed + routable tokens survive; nothing is guessed.
  async function applyTemplate(t: CuratedSet) {
    if (adding) return
    setAdding(true)
    setAddError(null)
    try {
      const cands = (await resolveCuratedSymbols(chainId, t.symbols)).slice(0, MAX_ASSETS)
      const resolved = await Promise.all(
        cands.map((c) =>
          resolveAsset(c.address, chainId, c.symbol)
            .then((r): ComposedAsset | 'retry' => ({ ...r, chainId, color: tokenVisual(r.symbol, r.address).color }))
            // retryable ≠ unlisted: an RPC blip must ask for another click, not
            // silently shrink the template (verify pass F5)
            .catch((e) => (isRetryableDetection(e) ? ('retry' as const) : null)),
        ),
      )
      if (resolved.includes('retry')) {
        setAddError(`Couldn’t check every ${t.label} token (RPC error) — try again.`)
        return
      }
      const ok = resolved.filter((r): r is ComposedAsset => r != null && r !== 'retry')
      const uniq = ok.filter((a, i, arr) => arr.findIndex((x) => x.address.toLowerCase() === a.address.toLowerCase()) === i)
      if (uniq.length === 0) {
        setAddError(`None of the ${t.label} set is listed on ${cfg.name} yet — try search.`)
        return
      }
      setAssets(uniq)
      setWeights(equalWeights(uniq.length))
      setScenario({})
    } catch {
      setAddError('Could not load that template.')
    } finally {
      setAdding(false)
    }
  }

  // Deep-link pre-fill (Prismbeat /createbasket, 2026-07-08): open the composer
  // populated from ?tokens=<addr,addr,…> (comma-separated ERC-20s on ONE chain)
  // + optional ?chain=eth|base. Each resolves to a routable asset; any the app
  // can't trade are skipped and surfaced. The bot only validates + deep-links —
  // wallet + the create/sign tx are the app's job.
  async function seedFromAddresses(rawAddrs: string[], chain: number) {
    const addrs = [...new Set(rawAddrs.map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))].slice(0, MAX_ASSETS)
    if (addrs.length === 0) {
      setAddError('That create link had no valid token addresses.')
      return
    }
    setAdding(true)
    setAddError(null)
    try {
      const resolved = await Promise.all(
        addrs.map((a) =>
          resolveAsset(a, chain)
            .then((r): ComposedAsset | 'retry' => ({ ...r, chainId: chain, color: tokenVisual(r.symbol, r.address).color }))
            // same honesty as templates: "couldn't check" must not be reported
            // as "not tradeable" (verify pass F5)
            .catch((e) => (isRetryableDetection(e) ? ('retry' as const) : null)),
        ),
      )
      if (resolved.includes('retry')) {
        setAddError('Couldn’t check every token in that link (RPC error) — reload to try again.')
        return
      }
      const ok = resolved.filter((r): r is ComposedAsset => r != null && r !== 'retry')
      if (ok.length === 0) {
        setAddError(`None of those tokens are tradeable on ${chainCfg(chain).name} yet.`)
        return
      }
      setAssets(ok)
      setWeights(equalWeights(ok.length))
      setScenario({})
      const dropped = addrs.length - ok.length
      if (dropped > 0) setAddError(`Added ${ok.length}. ${dropped} not tradeable on ${chainCfg(chain).name} — skipped.`)
    } catch {
      setAddError('Could not load the tokens from that link.')
    } finally {
      setAdding(false)
    }
  }

  // Run the deep-link ONCE on mount (standalone /createbasket + /compose only,
  // never the /creators-embedded instance).
  const deepLinkedRef = useRef(false)
  useEffect(() => {
    if (embedded || deepLinkedRef.current) return
    const raw = searchParams.get('tokens')
    if (!raw) return
    deepLinkedRef.current = true
    const wantChain = parseChainParam(searchParams.get('chain'))
    if (wantChain) setActiveChainId(wantChain)
    void seedFromAddresses(raw.split(','), wantChain ?? chainId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function removeAsset(i: number) {
    const dropped = assets[i]
    setAssets((prev) => prev.filter((_, k) => k !== i))
    setWeights((prev) => {
      const rest = prev.filter((_, k) => k !== i)
      const sum = rest.reduce((s, w) => s + w, 0)
      return sum > 0 ? rebalanceOthers(rest, 0, Math.round((rest[0] / sum) * 100)) : []
    })
    if (dropped) {
      setScenario((prev) => {
        const { [keyOf(dropped)]: _drop, ...keep } = prev
        return keep
      })
    }
  }

  // ── the backtest: real history per asset, combined into a weighted index ──
  // Each pick's history reads from ITS OWN chain (bundle mode: the mix can
  // span networks, and a Base token's series does not exist on Ethereum).
  const histories = useQueries({
    queries: assets.map((a) => ({
      queryKey: ['spectrum', 'assetHist', a.chainId, a.address.toLowerCase(), range],
      queryFn: () => fetchAssetHistory(a.chainId, a.address, range),
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
    })),
  })
  const historiesKey = histories.map((h) => h.dataUpdatedAt).join(',')
  const loadingHist = histories.some((h) => h.isLoading)

  const { rows, perAssetPct, combinedPct, anchors } = useMemo(() => {
    const ready = assets
      .map((a, i) => ({ a, w: weights[i] ?? 0, s: histories[i]?.data ?? [] }))
      .filter((x) => x.s.length >= 2)
    if (ready.length === 0)
      return {
        rows: [] as Record<string, number>[],
        perAssetPct: new Map<string, number>(),
        combinedPct: null as number | null,
        anchors: new Map<string, { first: number; last: number }>(),
      }
    const anchor = ready.reduce((best, x) => (x.s.length > best.s.length ? x : best), ready[0]).s
    const n = anchor.length
    const sample = (s: { time: number; value: number }[], k: number) => s[Math.round((k / (n - 1)) * (s.length - 1))].value
    const wSum = ready.reduce((s, x) => s + x.w, 0) || 1
    const rows: Record<string, number>[] = []
    for (let k = 0; k < n; k++) {
      const r: Record<string, number> = { time: anchor[k].time }
      let idx = 0
      ready.forEach((x, j) => {
        const rel = sample(x.s, k) / (x.s[0].value || 1)
        idx += (x.w / wSum) * rel
        r[`a${j}`] = rel * 100
      })
      r.value = idx * 100
      rows.push(r)
    }
    const perAssetPct = new Map<string, number>()
    // real-price anchors per asset: `first` converts typed target prices into
    // the chart's rebased space, `last` is "now" for implied-% and impact math.
    const anchors = new Map<string, { first: number; last: number }>()
    ready.forEach((x) => {
      const first = x.s[0].value || 1
      const last = x.s[x.s.length - 1].value
      perAssetPct.set(keyOf(x.a), (last / first - 1) * 100)
      anchors.set(keyOf(x.a), { first, last })
    })
    const combinedPct = rows.length >= 2 ? rows[rows.length - 1].value - 100 : null
    return { rows, perAssetPct, combinedPct, anchors }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, weights, range, historiesKey])

  const readyAssets = useMemo(
    () => assets.filter((_, i) => (histories[i]?.data?.length ?? 0) >= 2),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assets, historiesKey],
  )
  const showSplit = split && readyAssets.length >= 2
  // The blend AS A TOKEN (owner 17:32): a basket token seeded at $1.00 at the
  // range start — the index rebased to dollars.
  const tokenPrice = rows.length >= 2 ? rows[rows.length - 1].value / 100 : null
  // The launch story (owner 19:15): "if you'd launched at $1.00 on <start date>,
  // it'd be $X now." The date is the first point of the shown range.
  const startDate =
    rows.length >= 2
      ? new Date(rows[0].time * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
      : null

  // ── the forecast: dated price points → a replayed scenario path ──
  const forecast = useMemo(() => {
    if (rows.length < 2 || readyAssets.length === 0) return null
    const lastRow = rows[rows.length - 1]
    const tLast = lastRow.time
    const wOf = (key: string) => weights[assets.findIndex((a) => keyOf(a) === key)] ?? 0
    const perAsset = readyAssets.map((a, j) => {
      const key = keyOf(a)
      const anchor = anchors.get(key)
      const first = anchor?.first || 1
      const relNow = (anchor?.last ?? first) / first
      const pts = (scenario[key] ?? [])
        .map((p) => ({ t: dateToUnix(p.date), price: parseFloat(p.price) }))
        .filter((p): p is { t: number; price: number } => p.t != null && p.t > tLast && Number.isFinite(p.price) && p.price > 0)
        .sort((x, y) => x.t - y.t)
      return { key, j, first, relNow, pts }
    })
    if (!perAsset.some((x) => x.pts.length > 0)) return null
    // Each asset walks its own points: linear between them, holding beyond the
    // last one; assets with no points hold flat — the blend states that.
    const relAt = (x: (typeof perAsset)[number], t: number): number => {
      let prevT = tLast
      let prevRel = x.relNow
      for (const p of x.pts) {
        const rel = p.price / x.first
        if (t <= p.t) return prevRel + (rel - prevRel) * ((t - prevT) / (p.t - prevT || 1))
        prevT = p.t
        prevRel = rel
      }
      return prevRel
    }
    const wSum = perAsset.reduce((s, x) => s + wOf(x.key), 0) || 1
    const times = [...new Set(perAsset.flatMap((x) => x.pts.map((p) => p.t)))].sort((a, b) => a - b)
    const scenRows = times.map((t) => {
      const r: Record<string, number> = { time: t }
      let blend = 0
      for (const x of perAsset) {
        const rel = relAt(x, t)
        blend += (wOf(x.key) / wSum) * rel
        if (x.pts.length > 0) r[`fca${x.j}`] = rel * 100
      }
      r.fc = blend * 100
      return r
    })
    const totalPct = (scenRows[scenRows.length - 1].fc / lastRow.value - 1) * 100
    const predictedIdx = perAsset.filter((x) => x.pts.length > 0).map((x) => x.j)
    return { scenRows, totalPct, endT: times[times.length - 1], predictedIdx }
  }, [rows, readyAssets, anchors, scenario, weights, assets])

  const chartRows = useMemo<Record<string, number>[]>(() => {
    if (!forecast || rows.length < 2) return rows
    const out: Record<string, number>[] = rows.map((r) => ({ ...r }))
    const last = rows[rows.length - 1]
    // connector row: the dashes join the solid lines at "now"
    const conn: Record<string, number> = { ...last, fc: last.value }
    for (const j of forecast.predictedIdx) conn[`fca${j}`] = last[`a${j}`]
    out[out.length - 1] = conn
    out.push(...forecast.scenRows)
    return out
  }, [rows, forecast])

  // A FIXED y-domain over every series drawn (blend + constituents + forecast),
  // independent of the split toggle. Recharts' default ['auto','auto'] refits to
  // only the visible series, so toggling Split (which shows/hides the wide-ranging
  // constituent lines) made the basket-token line jump vertically. Pinning the
  // domain keeps that line in the exact same place — only its styling changes
  // when you toggle (owner 2026-07-07 18:4x). Break-even (100) is folded in so the
  // reference line is always on-scale.
  const yDomain = useMemo<[number, number]>(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const r of chartRows) {
      for (const k in r) {
        if (k === 'time') continue
        const v = r[k]
        if (typeof v === 'number' && Number.isFinite(v)) {
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 100]
    lo = Math.min(lo, 100)
    hi = Math.max(hi, 100)
    if (lo === hi) return [lo - 1, hi + 1]
    const pad = (hi - lo) * 0.06
    return [lo - pad, hi + pad]
  }, [chartRows])

  // every scenario point across all assets, date-sorted — the readable list that
  // replaces the per-asset date pickers (owner 19:15).
  const activePoints = useMemo(
    () =>
      assets
        .flatMap((a) => (scenario[keyOf(a)] ?? []).map((pt) => ({ a, pt })))
        .sort((x, y) => (dateToUnix(x.pt.date) ?? 0) - (dateToUnix(y.pt.date) ?? 0)),
    [assets, scenario],
  )

  // Add a point parsed from the NL bar (owner 19:15). One point per (asset,date):
  // re-stating a date for the same asset overwrites, so editing = re-adding.
  function addParsedPoint(key: string, dateISO: string, priceStr: string) {
    setScenario((prev) => {
      const rest = (prev[key] ?? []).filter((p) => p.date !== dateISO)
      return { ...prev, [key]: [...rest, { id: nextPointId(), date: dateISO, price: priceStr }] }
    })
  }
  function removePoint(key: string, id: string) {
    setScenario((prev) => ({ ...prev, [key]: (prev[key] ?? []).filter((p) => p.id !== id) }))
  }

  // ── BUNDLE MODE (the owner 2026-08-10) — a DERIVATION from the draft: picks on
  // more than one network make the mix a bundle (one basket per network),
  // never a toggle someone can leave stale. publish-bundle-model owns the law.
  const bundle = isBundleDraft(assets)
  const bundleGroups = useMemo(() => (assets.length >= 2 ? groupBundleDraft(assets, weights) : []), [assets, weights])
  const dupSyms = useMemo(() => duplicateSymbols(assets), [assets])
  /** legs THIS deployment's contracts will refuse — the shared law's verdict,
   *  asked per leg on that leg's own chain (see VenueChip). A derivation of the
   *  picks, never a flag someone can leave stale. */
  const v2Legs = useMemo(() => assets.filter((a) => rejectedV2Legs([a], a.chainId).length > 0), [assets])
  // HOW THE REVIEW LIST BREAKS INTO ROWS (the owner 2026-08-13: "assets should be
  // balanced and centered across two rows"). The rows are derived, not decreed:
  // an entry needs ~171px before a six-character ticker starts truncating
  // (measured at 1440 — the block is 910 wide, so FIVE per row is the floor),
  // and the split is then even by construction. Nine legs read 5 + 4; three
  // read as one centred row, never one row plus an empty one; from ELEVEN it
  // grows a third row rather than squeezing a sixth entry onto a line, and
  // twenty read 5 + 5 + 5 + 5. A phone takes ONE per row unless every ticker is
  // short — two 135px entries truncated MORPHO/CBETH/PENDLE (measured at 390),
  // and the no-truncation rule outranks the row count.
  const LEG_MAX_PER_ROW = 5
  const legRows = Math.max(1, Math.ceil(assets.length / LEG_MAX_PER_ROW))
  const longestSymbol = useMemo(() => assets.reduce((m, a) => Math.max(m, showSymbol(a.symbol).length), 0), [assets])
  const legPerRow = Math.max(
    1,
    wideEnoughToFill ? Math.ceil(assets.length / legRows) : longestSymbol <= 4 ? Math.min(2, assets.length) : 1,
  )
  /** how many networks the picks span — the fact that decides basket vs bundle,
   *  said out loud on every page of the staged face rather than inferred */

  /** START FRESH — the restore chip's, the picks bar's and the dock's one
   *  body. Deliberate emptying: the persisted draft clears with it (the effect
   *  above removes the row when the mix empties). */
  function clearMix() {
    setAssets([])
    setWeights([])
    setScenario({})
    setName('')
    setSymbol('')
    setRestoredAt(null)
  }

  // ONE asset launches (the owner's ruling 2026-08-15, contract-verified) — a
  // single-token basket is a valid product shape; zero still cannot.
  const canLaunch = assets.length >= 1
  function launchIt() {
    if (!canLaunch) return
    // the create face's fee station gates its own CTA (an out-of-bounds fee
    // or a share with a bad payout must not seed the money path)
    if (createFace && !feeValid) return
    if (bundle || createFace) {
      // The ceremony popup owns readiness + deploys — for EVERY create-face
      // launch, single-network included (the owner live 2026-08-14: pressing
      // "Launch this basket" dropped him into the legacy 6-step studio,
      // re-asking everything the publish stage had just answered — "the old
      // launch page that shouldnt be there anymore"). One network = a
      // one-lane ceremony; deploy naked → seed → thesis → share is the ruled
      // journey. The legacy builder remains only the research face's door.
      //
      // Resume-vs-park, decided HERE where the subject is final: a persisted
      // run seeds this ceremony ONLY when it was deploying this exact mix.
      const row = loadLandedLanes()
      const subject = bundleGroups.length > 0 ? bundleSubjectOf(bundleGroups) : null
      if (row && row.subject != null && row.subject === subject) {
        landedRef.current = new Map(row.lanes.map((l) => [l.chainId, l.newAddress]))
        landedNameRef.current = row.name
      } else {
        landedRef.current = new Map()
        landedNameRef.current = null
      }
      setPublishOpen(true)
      return
    }
    // Seed the MIX's own chain, never the active toggle's (2026-08-12 audit):
    // a switch keeps the picks, so "adding from" can point at chain B while
    // every pick lives on chain A — seeding B would hand the builder a draft
    // full of another network's addresses (fails closed at simulate, but as a
    // dead end). The remix door's pattern: move the view to the draft's chain
    // first, or the seeded draft would never be found.
    const mixChain = assets[0]?.chainId ?? chainId
    if (mixChain !== chainId) setActiveChainId(mixChain)
    seedLaunchDraft(mixChain, {
      assets,
      weights,
      name: name.trim(),
      symbol: symbol.trim().toUpperCase(),
      // the create face's fee station rides the draft, so the builder opens
      // with the dials where they were set (absent on the research face —
      // the builder self-heals to its defaults exactly as before)
      ...(createFace ? { feePct, creatorSharePct, creatorPayout: payoutTrimmed } : {}),
    })
    setLaunchChain(mixChain)
    setLaunchOpen(true)
  }

  /* THE STEP SPINE (owner 2026-08-12: the flow should read as one system;
     the owner 2026-08-13, looking at it: "make this more obvious and nicer").
     All three pages wear it, so page one stops being the only one with no
     sense of where it sits. A step you have already been through is a
     BUTTON — going back preserves everything, because the one shared state
     IS the three pages — and a step ahead is inert text, never a shortcut
     past the gates that let you reach it.

     NOTHING HERE IS INVENTED — the whole vocabulary is the ceremonies':
       · the MARK per step, and its states, are PublishBundleModal's lane
         marks (LaneRowView): a teal ✓ once done, the live one filled and
         glowing, a quiet disc for what hasn't happened yet.
       · the current step's fill is the app's own selected treatment (the
         picker's AddDisc): the spectral gradient with void-colored type.
       · the CONNECTORS are drawn rails — `h-px w-…` hairlines, the exact
         joiner ReshapeThesisModal draws between shape · review · ship —
         and they LIGHT as the flow passes them, so the spine reads as one
         continuous backbone rather than three words and two arrow glyphs.
     One type step up (10 → 11px, the live step 12px display) and the marks
     give it presence; it still costs the choose page ~40px of height. */
  const stepSpine = createFace ? (
    <nav aria-label="Create steps" className="flex flex-wrap items-center gap-y-2 sm:justify-end">
      {stage !== 'choose' && (
        <button
          type="button"
          onClick={() => setStage(stage === 'publish' ? 'shape' : 'choose')}
          className="press mr-2 inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/12 px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-white/30 hover:text-ink"
        >
          ← Back
        </button>
      )}
      {STAGES.map((s, i) => {
        const at = STAGES.findIndex((x) => x.key === stage)
        const done = i < at
        const here = i === at
        const mark = (
          <span
            aria-hidden
            className={`relative grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full font-mono text-[11px] font-bold leading-none ${
              done ? 'bg-teal/15 text-teal' : here ? 'text-void shadow-[0_0_20px_-4px_var(--color-cyan)]' : 'bg-white/[0.06] text-ink-faint'
            }`}
          >
            {here && <span aria-hidden className="absolute inset-0" style={{ background: SPECTRAL }} />}
            <span className="relative">{done ? '✓' : i + 1}</span>
          </span>
        )
        // A PHONE NAMES ONLY WHERE YOU ARE. All three labels run 423px at 390
        // and wrapped the spine onto two lines with a rail dangling at the head
        // of the second (measured 2026-08-13); the marks alone still say how
        // many steps there are and which one is lit, and the live step keeps
        // its name. sm and up, every step is named.
        const text = done ? (
          <span className="hidden font-mono text-[11px] uppercase tracking-[0.16em] text-ink-dim transition-colors group-hover:text-ink sm:inline">
            {s.label}
          </span>
        ) : here ? (
          <span className="font-display text-[12px] font-bold uppercase tracking-[0.14em] text-ink">{s.label}</span>
        ) : (
          <span className="hidden font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint/60 sm:inline">{s.label}</span>
        )
        return (
          <span key={s.key} className="flex items-center">
            {/* the rail LIGHTS behind you: lit up to the live step, quiet ahead */}
            {i > 0 && <span aria-hidden className={`mx-2 h-px w-5 sm:w-9 ${i <= at ? 'bg-cyan/45' : 'bg-white/10'}`} />}
            {done ? (
              <button
                type="button"
                onClick={() => setStage(s.key)}
                title={`Back to ${s.label.toLowerCase()} — nothing is lost`}
                className={`press group inline-flex min-h-[36px] items-center gap-2 rounded-lg pl-2 transition-colors hover:bg-white/[0.05] ${i === STAGES.length - 1 ? 'sm:pr-0' : 'pr-2'}`}
              >
                {mark}
                {text}
              </button>
            ) : (
              <span
                aria-current={here ? 'step' : undefined}
                /* the LAST step drops its right padding so the spine's edge is
                   the card's edge optically as well as structurally */
                className={`inline-flex min-h-[36px] items-center gap-2 pl-2 ${i === STAGES.length - 1 ? 'sm:pr-0' : 'pr-2'}`}
              >
                {mark}
                {text}
              </span>
            )}
          </span>
        )
      })}
    </nav>
  ) : null

  return (
    <div className="relative">
      {/* embedded (owner 19:15: composer sits inside /creators above the launch
          section) drops the page masthead + ambient orbs and lets the global
          network toggle govern the chain. The CREATE face keeps the masthead but
          titles itself as the create system, not the Composer — and carries NO
          chain toggle (the owner 2026-08-12: "Robinhood / Ethereum / Base — no need
          for this on /create"): the picker is cross-chain-always, picks land on
          the hit's own chain, and the launch handoff seeds the MIX's chain, so
          the toggle was vestigial there. /compose keeps it — chain-scoped
          backtesting is the research bench's point. */}
      {!embedded && (
        <>
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-visible">
            <div className="absolute left-1/3 top-6 h-[380px] w-[380px] -translate-x-1/2 rounded-full bg-cyan/10 blur-[120px]" />
            <div className="absolute right-[8%] top-40 h-72 w-72 rounded-full bg-violet/12 blur-[130px]" />
            <div className="absolute bottom-0 left-[14%] h-64 w-64 rounded-full bg-magenta/10 blur-[120px]" />
          </div>

          <PageHeader
            /* pl-1 on the create face, not px-1 (the owner 2026-08-13: the spine
               "lined up with right hand side of the main card edge") — the
               masthead row now ENDS where the card below ends, so the spine
               riding its actions slot is aligned structurally rather than by a
               guessed margin. The title keeps its 4px left inset. */
            className={createFace ? 'mb-3 pl-1' : 'mb-5 px-1'}
            size="lg"
            title={createFace ? 'Create' : 'Composer'}
            /* NO SUBTITLE on the create face (the owner 2026-08-13, looking at the
               masthead: "Create a basket or bundle. remove this text") — the
               title and the step spine below carry the page. The words survive
               where they are a LABEL rather than a caption: Nav's link to
               /create still reads "Create a basket or bundle". */
            actions={
              createFace ? (
                stepSpine
              ) : (
              <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1">
                {[...SUPPORTED_CHAIN_IDS].reverse().map((id) => {
                  // the toggle is "which network am I adding FROM" — the count
                  // shows where picks already live, so a bundle-in-progress is
                  // legible from the header (switching keeps the mix now)
                  const picked = assets.filter((a) => a.chainId === id).length
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setActiveChainId(id)}
                      aria-pressed={chainId === id}
                      aria-label={picked > 0 ? `${CHAINS[id].name} — ${picked} picked` : CHAINS[id].name}
                      className={`press inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
                        chainId === id ? 'bg-white/10 text-ink' : 'text-ink-faint hover:text-ink-dim'
                      }`}
                    >
                      {CHAINS[id].name}
                      {picked > 0 && (
                        <span
                          aria-hidden
                          className={`grid h-4 min-w-4 place-items-center rounded-full px-1 font-num text-[9px] tabular-nums ${
                            chainId === id ? 'bg-white/15 text-ink' : 'bg-white/8 text-ink-dim'
                          }`}
                        >
                          {picked}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              )
            }
          />
        </>
      )}

      {/* the choose page's column — see useViewportBudget. Off the create face
          (and on a phone) it is an unstyled wrapper and changes nothing. */}
      <div
        ref={chooseRef}
        className={fillsViewport ? 'flex min-h-0 flex-col' : undefined}
        style={fillsViewport ? { height: chooseHeight } : undefined}
      >
      {/* ── COMPOSITION FIRST (owner 17:32), streamlined 17:53: no heading, no
          counter (the page title says it), compact search + trending rail.
          On the staged create face this card IS page one (choose) — and there
          it is a COLUMN THAT FILLS ITS BUDGET (the owner 2026-08-13: "this whole
          thing should use more height whilst staying on the one viewport"):
          the card takes the leftover height, the picker's grid takes the
          leftover inside that, and the picks bar below is fixed. ── */}
      {(!createFace || stage === 'choose') && (
      <Card fill={fillsViewport} className={fillsViewport ? 'p-3' : 'p-4'}>
        {/* the restored draft, named — with the fresh start one tap away.
            The create face folds the restore into the circles row below:
            restored picks just ARE the circles (owner addendum #4). */}
        {!createFace && restoredAt != null && assets.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
            <span className="min-w-0 flex-1 font-mono text-[10px] leading-relaxed text-ink-faint">
              your draft from last time — {assets.length} {assets.length === 1 ? 'pick' : 'picks'}
              {name.trim() ? ` · “${name.trim()}”` : ''}
            </span>
            <button
              type="button"
              onClick={clearMix}
              className="press inline-flex min-h-[28px] items-center rounded-md border border-white/12 px-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim hover:border-white/30 hover:text-ink"
            >
              Start fresh
            </button>
            <button
              type="button"
              aria-label="Keep the draft and dismiss this note"
              onClick={() => setRestoredAt(null)}
              className="press grid h-7 w-7 place-items-center rounded-md text-ink-faint hover:bg-white/8 hover:text-ink"
            >
              ✕
            </button>
          </div>
        )}
        {/* THE CREATE FACE PICKS BIG AND CROSS-CHAIN (owner 2026-08-12 round 2:
            "shouldnt we show the assets in that nice larger select flow where
            you see different assets across chain rather than the small little
            search bar with recommended tickers?") — the /manager choose
            station's selection experience: one search across every network,
            large browse tiles with chain marks, picks landing on the hit's own
            chain. The research face keeps the compact rail unchanged. */}
        {createFace ? (
          <CreateAssetPicker
            fill={fillsViewport}
            picked={assets}
            full={assets.length >= MAX_ASSETS}
            busy={adding}
            onPick={(onChain, addr, sym) => void addAssetOn(onChain, addr, sym)}
            onRemove={(onChain, addr) => {
              const i = assets.findIndex((a) => a.chainId === onChain && a.address.toLowerCase() === addr.toLowerCase())
              if (i >= 0) removeAsset(i)
            }}
          />
        ) : (
          <>
            {/* exclusions are per-chain: a token already picked on ANOTHER network
                is still addable here — that cross-chain pair is what a bundle IS */}
            <AssetSearch
              chainId={chainId}
              compact
              busy={adding || assets.length >= MAX_ASSETS}
              excludeAddresses={assets.filter((a) => a.chainId === chainId).map((a) => a.address)}
              onPick={(addr, sym) => void addAsset(addr, sym)}
            />
            <PopularAssets
              chainId={chainId}
              chainName={cfg.name}
              compact
              candidates={suggestions}
              excludeAddresses={assets.filter((a) => a.chainId === chainId).map((a) => a.address)}
              onPick={(addr, sym) => void addAsset(addr, sym)}
              busy={adding}
            />
          </>
        )}
        {/* templates — a starting point when the mix is empty (owner 2026-07-07).
            Research bench only: the 2026-08-12 ruling counts them in the "old
            and horrible" chrome, so the create face opens on pure search. */}
        {!createFace && assets.length === 0 && (
          <div className="mt-3.5 border-t border-white/8 pt-3.5">
            <div className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-wide text-ink-dim">
              <span className="h-1.5 w-1.5 rounded-full bg-violet" />
              Start from a template
            </div>
            <div className="flex flex-wrap gap-1.5">
              {COMPOSER_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  disabled={adding}
                  onClick={() => void applyTemplate(t)}
                  title={t.blurb}
                  className="press rounded-full border border-white/12 bg-white/[0.03] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-dim transition-colors hover:border-white/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {addError && <p className="mt-2 shrink-0 font-mono text-[11px] text-magenta">{addError}</p>}
      </Card>
      )}

      {/* ── CHOOSE, the bottom bar (owner 2026-08-12: "then see circles of the
          ones you selected below" + Continue): the picks as logo discs — ✕
          each, start fresh beside them — and Continue arming at two. One
          viewport with the card above; this bar never scrolls the page.

          ON A PHONE the discs become their own horizontally-scrolling strip
          and the Continue CTA leaves the flow for a floating dock (the owner
          2026-08-13: the CTA has to stay reachable without scrolling) — the
          house's own portaled bottom dock, lifted from the portfolio's action
          dock, drawn below the bar. ── */}
      {createFace && stage === 'choose' && (
        <div className="enter mt-3 flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          {/* THE PICKED SET'S OWN GROUND (the owner 2026-08-13: "these should have
              their own bg pill that's wide enough to accept a large amount of
              assets") — the house panel ground the rest of the flow uses, one
              rail spanning the content width, holding the chips, the count and
              Clear all. Those three belong to this object, so they live inside
              it; the CTA is the PAGE's action and sits beneath.

              IT SCROLLS, IT DOES NOT WRAP. Measured: at the 20-pick cap a
              wrapping rail runs to three lines (~120px) and page one clears 900
              at 1440 — and the one-viewport law governs. A single scrolling
              line is the same height at 2 picks and at 20, so the page cannot
              be pushed over by picking, and the phone gets the identical
              object (the kit's own scrolling-rail idiom) instead of a second
              design. The count + Clear all stay pinned outside the scroller,
              so they never scroll out of reach. */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-2xl border border-white/10 bg-white/[0.03] p-1 sm:gap-2">
            {/* THE CHIPS TAKE THE WHOLE LINE ON A PHONE. Measured at 390: with
                the count and Clear all sharing the line, the chip scroller was
                52px wide — a nine-pick set peeping through a keyhole. w-full
                gives the chips the rail's full width there and lets the meta
                wrap under them; sm and up the three share one line as before
                (w-auto + flex-1, not a basis override — a basis-full that lost
                its sm reset is exactly what wrapped the desktop rail onto two
                lines and stole 44px from the grid, measured). */}
            <div className="rail-fade scrollbar-none flex w-full min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:w-auto sm:flex-1">
              {assets.length === 0 ? (
                <>
                  {[0, 1, 2].map((g) => (
                    <span key={g} aria-hidden className="h-9 w-9 shrink-0 rounded-full border border-dashed border-white/15" />
                  ))}
                  <span className="shrink-0 pl-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                    your picks land here — choose at least two
                  </span>
                </>
              ) : (
                assets.map((a, i) => (
                  // logo + ticker + ✕ and NOTHING else (the owner 2026-08-13:
                  // "remove that there so we can show more assets on the
                  // chosen bar") — the venue rides the picker's highlighted
                  // card and the shape rows, never these chips: a chip's job
                  // is to keep twenty picks visible, and every extra word
                  // costs a chip.
                  <span
                    key={keyOf(a)}
                    className="enter flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] py-1 pl-1 pr-1"
                    style={{ '--enter-i': Math.min(i, 8) } as CSSProperties}
                  >
                    <AssetLogo address={a.address} symbol={a.symbol} chainId={a.chainId} size={26} />
                    <span className="max-w-[7rem] truncate font-mono text-[10px] uppercase tracking-wide text-ink">
                      {showSymbol(a.symbol)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAsset(i)}
                      aria-label={`Remove ${showSymbol(a.symbol)}`}
                      /* the ✕ is a 24px mark with a 36px reach — the tap floor
                         is met by the before:-inset expansion, the way the rest
                         of this flow's small controls meet it */
                      className="press relative grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] text-ink-faint before:absolute before:-inset-1.5 before:rounded-full before:content-[''] hover:bg-white/10 hover:text-magenta"
                    >
                      ✕
                    </button>
                  </span>
                ))
              )}
            </div>
            {assets.length > 0 && (
              <div className="flex shrink-0 items-center max-sm:w-full max-sm:justify-end max-sm:px-1">
                {/* the chips ARE the information (the owner 2026-08-13: "remove
                    this on the /create page so you can see the asset pills") —
                    the old "9 picked · 3 networks" label paid for itself in
                    chip space, and the CTA already counts the picks. Clear all
                    survives because it is an ACTION, not a label. */}
                <button
                  type="button"
                  onClick={clearMix}
                  className="press inline-flex h-9 shrink-0 items-center rounded-xl border border-white/12 px-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint hover:border-white/30 hover:text-ink"
                >
                  ✕ Clear all
                </button>
              </div>
            )}
          </div>
          {/* THE CTA SHARES THE RAIL'S LINE (the owner 2026-08-13: "we could allow
              the asset picker area more height by moving the selected assets
              pill in line with the shape 9 assets button") — one row instead of
              two stacked blocks, and the whole freed band goes to the grid
              above. The CTA's width is reserved FIRST (shrink-0) and the rail
              takes what remains, so twenty chips can never squeeze the button
              below a comfortable tap. A phone keeps the stacked shape: at 390
              a rail and a button on one line leave the rail ~120px, which is
              worse than the two-line reading — and the phone's CTA lives in the
              dock anyway, where it cannot be scrolled away from. */}
          <button
            type="button"
            disabled={assets.length < 2}
            onClick={() => setStage('shape')}
            className="press hidden h-11 shrink-0 rounded-xl px-6 font-display text-sm font-bold uppercase tracking-[0.15em] text-black transition-transform hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100 sm:block"
            style={{ background: SPECTRAL }}
          >
            {/* the CTA names WHAT HAPPENS NEXT, not the step number */}
            {assets.length < 2 ? 'Pick at least two →' : `Shape ${assets.length} assets →`}
          </button>
        </div>
      )}

      </div>

      {/* ── THE PHONE DOCK (the owner 2026-08-13: "ensure mobile has a beautiful
          mobile optimized version … the Continue CTA stays reachable") — the
          house's own floating dock, lifted from the portfolio's action dock
          (pages/Yours.tsx): portaled to body, a glass pill riding above the
          shell's tab bar, safe-area aware, and raising --page-dock-pad so the
          footer clears it at max scroll. Phone only — sm and up the CTA sits
          in the flow, where the whole page already fits one viewport. ── */}
      {createFace && stage === 'choose' &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
            <style>{'@media (max-width: 639.98px){:root{--page-dock-pad:72px}}'}</style>
            <nav
              aria-label="Create actions"
              className="fixed inset-x-0 z-40 flex justify-center px-4 sm:hidden"
              style={{ bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))' }}
            >
              {/* one control, no caption: the rail two lines up already says
                  how many are picked and across how many networks, and the
                  button's own words carry the count */}
              <div className="flex max-w-full items-center gap-2 rounded-full border border-white/12 bg-panel/90 p-1.5 shadow-[0_16px_48px_-16px_rgba(0,0,0,0.85)] backdrop-blur-xl">
                <button
                  type="button"
                  disabled={assets.length < 2}
                  onClick={() => setStage('shape')}
                  className="spectral-btn press flex h-11 shrink-0 items-center rounded-full px-5 font-display text-[12px] font-bold uppercase tracking-[0.1em] text-void disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {assets.length < 2 ? 'Pick at least two →' : `Shape ${assets.length} assets →`}
                </button>
              </div>
            </nav>
          </>,
          document.body,
        )}

      {/* ── THE ADD'S PENDING CARD (the owner 2026-08-13: a picked asset "takes a
          while to add … show that little pop up card we have in the system
          that shows asset and a rainbow loading circle until it completes")
          — the swap flow's own PrismAnim, the picked asset at its center,
          up for exactly as long as resolveAsset probes the chain. role=status
          not dialog: it takes no input and steals no focus. ── */}
      {addingPick &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed inset-0 z-[95] grid place-items-center p-4" role="status" aria-live="polite">
            <div className="fixed inset-0 bg-void/70 backdrop-blur-sm" />
            <div className="search-pop relative w-full max-w-xs overflow-hidden rounded-3xl card-surface p-7 text-center backdrop-blur-md">
              <div
                aria-hidden
                className="absolute inset-x-0 top-0 h-1"
                style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
              />
              <PrismAnim
                logo={
                  <AssetLogo
                    address={addingPick.address}
                    symbol={addingPick.symbol || '?'}
                    chainId={addingPick.chainId}
                    size={64}
                  />
                }
              />
              <h3 className="mt-5 font-display text-xl font-bold text-ink">
                Adding {addingPick.symbol ? `$${showSymbol(addingPick.symbol)}` : 'your pick'}…
              </h3>
              <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-ink-dim">
                reading the token on {chainMeta(addingPick.chainId).short} — it joins the mix the moment it
                resolves
              </p>
            </div>
          </div>,
          document.body,
        )}

      {/* ── SHAPE, the add bar (owner: "can also type to add more assets on
          this page too") — the same cross-chain search, compact ── */}
      {createFace && stage === 'shape' && (
        <Card className="p-4">
          <CreateAssetPicker
            searchOnly
            picked={assets}
            full={assets.length >= MAX_ASSETS}
            busy={adding}
            onPick={(onChain, addr, sym) => void addAssetOn(onChain, addr, sym)}
            onRemove={(onChain, addr) => {
              const i = assets.findIndex((a) => a.chainId === onChain && a.address.toLowerCase() === addr.toLowerCase())
              if (i >= 0) removeAsset(i)
            }}
          />
          {addError && <p className="mt-2 font-mono text-[11px] text-magenta">{addError}</p>}
        </Card>
      )}

      {/* ── the mix in a card of its own (owner 17:53): weights + steppers.
            BUNDLE MODE (the owner 2026-08-10): picks spanning networks group per
            network under a ChainBadge header — one basket each — with the
            split law said where the weights are set. Same rows, same arrays;
            only the arrangement changes. The staged face shows it on page
            two (shape) only — page one is picks-as-circles, no weights. ── */}
      {assets.length > 0 && (!createFace || stage === 'shape') && (
        <div className="enter mt-5">
        <Card className="p-4">
          {/* THE MIX HEADER (owner 2026-08-12) — what you are holding, said at
              the top of the card that holds it: how many assets, across how
              many networks, and whether that makes it a basket or a bundle.
              The bundle line used to live at the very bottom of the page in
              small mono, under the button; it belongs where the mix is. */}
          {createFace && (
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/8 pb-3">
              <span className="font-display text-sm font-bold uppercase tracking-wide text-ink">
                {assets.length} assets
              </span>
              {bundle ? (
                <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
                  {bundleGroups.map((g) => (
                    <ChainBadge key={g.chainId} chainId={g.chainId} />
                  ))}
                  <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-violet-bright">
                    a bundle · one basket on each of {bundleGroups.length} networks
                  </span>
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <ChainBadge chainId={assets[0]?.chainId ?? chainId} />
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                    a single-network basket
                  </span>
                </span>
              )}
              {/* the two-is-minimum warning left on the owner's note (live
                  2026-08-15: "not needed if you have two in the basket") —
                  removing to one drops the stage back to choosing, which is
                  its own explanation. */}
              {/* the V2 fact stated for the WHOLE mix as well as per leg: the
                  picture view lists no legs, so the chips alone would leave a
                  bricking mix silent while you shaped it (see VenueChip) */}
              {v2Legs.length > 0 && (
                <span className="w-full font-mono text-[10px] leading-relaxed text-amber-200/90">
                  ⚠ {v2LegBlockedMessage(v2Legs.map((a) => showSymbol(a.symbol)))}
                </span>
              )}
              {/* a group that cannot deploy is a blocker, said here rather than
                  in small print under the button */}
              {bundle &&
                bundleGroups
                  .filter((g) => !g.ready && g.blocker)
                  .map((g) => (
                    <span key={g.chainId} className="w-full font-mono text-[10px] leading-relaxed text-amber-200/90">
                      {g.blocker}
                    </span>
                  ))}
            </div>
          )}
          {/* Show-as — the portfolio page's own pill pair; picture leads.
              The tap instruction rides this row's right (the owner live
              2026-08-15: "move this to the right hand side of Show as"). */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Show as</span>
            {([
              { id: 'picture' as const, label: 'Picture' },
              { id: 'list' as const, label: 'List' },
            ]).map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={mixView === v.id}
                onClick={() => setMixView(v.id)}
                className={`press inline-flex min-h-[36px] items-center rounded-full border px-3 font-mono text-[10px] uppercase tracking-[0.12em] ${
                  mixView === v.id ? 'border-cyan/50 bg-cyan/[0.08] text-cyan' : 'border-white/12 text-ink-dim hover:border-white/30'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
          {mixView === 'picture' ? (
            <div>
              {/* tiles-as-controls: tap a tile, dial its weight — the reshape
                  system's grammar with the composer's own 1% floor. The bento
                  fills a FIXED frame (ShapeEditor's own sizing). */}
              <div className="h-[340px]">
              <BasketBento
                items={assets.map(
                  (a, i): BentoItem => ({
                    id: keyOf(a),
                    symbol: a.symbol,
                    address: a.address,
                    chainId: a.chainId,
                    chainMark: dupSyms.has(a.symbol.toLowerCase()),
                    // layout floor keeps a 1% tile visible + tappable; the
                    // label shows the TRUE weight (the label never lies)
                    weightPct: Math.max(weights[i] ?? 0, 1.6),
                    labelPct: weights[i] ?? 0,
                    // the tap nudge: the heaviest tile breathes for ~2s when
                    // the picture opens — look here, tap here
                    isNew: tapNudge && i === weights.indexOf(Math.max(...weights.map((w) => w ?? 0))),
                  }),
                )}
                fill
                animateLayout
                layoutMotion={dialing ? 'live' : 'glide'}
                selectedId={dial}
                onSelect={(id) => setDial((k) => (k === id ? null : id))}
              />
              </div>
              {/* the dial slot — FIXED height, always present (the reshape
                  law: the grid below never reflows on tap) */}
              <div className="mt-3 min-h-[64px]">
                {dialIndex >= 0 && assets[dialIndex] ? (
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <TrimBar
                        symbol={assets[dialIndex].symbol}
                        cur={0}
                        target={weights[dialIndex] ?? 0}
                        scaleUsd={CAP}
                        isNew
                        onTarget={(pct) => {
                          markDialing()
                          setWeights((w) => rebalanceOthers(w, dialIndex, Math.round(pct)))
                        }}
                      />
                    </div>
                    <VenueChip a={assets[dialIndex]} />
                    <button
                      type="button"
                      aria-label={`Remove ${showSymbol(assets[dialIndex].symbol)}`}
                      onClick={() => {
                        const i = dialIndex
                        setDial(null)
                        removeAsset(i)
                      }}
                      className="press grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/12 text-ink-dim hover:border-magenta/50 hover:text-magenta"
                    >
                      ✕
                    </button>
                    <button
                      type="button"
                      aria-label="Close the dial"
                      onClick={() => setDial(null)}
                      className="press grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-faint hover:bg-white/8 hover:text-ink"
                    >
                      ✓
                    </button>
                  </div>
                ) : (
                  <p className="grid h-[64px] place-items-center px-2 text-center">
                    {/* the LARGE instruction lives in the slot (the owner's final
                        word, 2026-08-15: seeing the whisper he asked the big
                        one back — supersedes the move-to-Show-as note). The
                        slot keeps its 64px: the no-reflow law is load-bearing. */}
                    <span className="font-display text-[15px] font-bold uppercase tracking-[0.08em] text-ink">
                      tap a tile to reweight it <span className="font-mono text-[11px] font-normal tracking-[0.14em] text-ink-dim">· 1% steps</span>
                    </span>
                  </p>
                )}
              </div>
            </div>
          ) : (
          <div className="space-y-3">
            {bundle ? (
              <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl border border-violet/25 bg-violet/[0.06] px-3.5 py-2.5">
                <span className="font-display text-sm font-bold uppercase tracking-wide text-violet-bright">
                  You&rsquo;re composing a bundle
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim">
                  one basket per network · one name groups them
                </span>
              </div>
            ) : (
              /* the law BEFORE it applies (discoverability, 2026-08-11): the
                 banner above only ever appeared after someone had already
                 stumbled into a cross-network mix — nothing said they could */
              <p className="px-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                pick on several networks (the header toggle) and this composes a bundle
              </p>
            )}
            {bundle ? (
              <div className="space-y-4">
                {bundleGroups.map((g) => (
                  <div key={g.chainId}>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <ChainBadge chainId={g.chainId} size="md" />
                      {/* the banner above already says one-basket-per-network —
                          this line stays short enough for one phone line */}
                      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                        {g.assets.length === 1 ? 'one asset' : `${g.assets.length} assets`} · {g.mixSharePct}% of the mix
                      </span>
                    </div>
                    <div className="grid gap-2 lg:grid-cols-2">
                      {g.indices.map((i) => (
                        <PickRow key={keyOf(assets[i])} a={assets[i]} i={i} weight={weights[i] ?? 0} perAssetPct={perAssetPct} range={range} onWeight={(i2, v) => setWeights((w) => rebalanceOthers(w, i2, v))} onRemove={removeAsset} />
                      ))}
                    </div>
                    {/* the group's blocker, said WHERE THE FIX IS — adding the
                        missing pick happens here, not in the ceremony that
                        would otherwise be the first to mention it */}
                    {!g.ready && g.blocker && (
                      <p className="mt-2 font-mono text-[10px] leading-relaxed text-amber-200/90">{g.blocker}</p>
                    )}
                  </div>
                ))}
                <p className="font-mono text-[10px] leading-relaxed text-ink-dim">
                  Weights shape the whole mix — each network renormalizes to 100% at publish.
                </p>
              </div>
            ) : (
              <div className="grid gap-2 lg:grid-cols-2">
                {assets.map((a, i) => (
                  <PickRow key={keyOf(a)} a={a} i={i} weight={weights[i] ?? 0} perAssetPct={perAssetPct} range={range} onWeight={(i2, v) => setWeights((w) => rebalanceOthers(w, i2, v))} onRemove={removeAsset} />
                ))}
              </div>
            )}
          </div>
          )}
            <div className="mt-3 flex items-center gap-3">
              <div aria-hidden className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/5">
                {assets.map((a, i) => (
                  <div key={keyOf(a)} className="h-full transition-[width] duration-300" style={{ width: `${weights[i] ?? 0}%`, background: a.color }} />
                ))}
              </div>
              {assets.length > 1 && (
                <button
                  type="button"
                  onClick={() => setWeights(equalWeights(assets.length))}
                  className="press inline-flex min-h-[36px] shrink-0 items-center rounded-md border border-white/12 px-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-white/30 hover:text-ink"
                >
                  Equal weight
                </button>
              )}
            </div>
        </Card>
        </div>
      )}

      {/* ── SHAPE → PUBLISH: the fresh-deploy shape law said where the fix is
          (a network holding one pick can't ship a basket — adding happens
          HERE, not first in the ceremony), then Continue ── */}
      {createFace && stage === 'shape' && assets.length > 0 && (
        <div className="enter mt-5">
          {/* the blockers and the basket/bundle line moved UP into the mix
              header, where the mix they describe actually is */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
              {assets.length} assets weighted · {weights.reduce((s, w) => s + w, 0).toFixed(0)}%
            </span>
            <button
              type="button"
              disabled={!canLaunch}
              onClick={() => setStage('publish')}
              className="press shrink-0 rounded-xl px-6 py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black transition-transform hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
              style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
            >
              Continue · name &amp; fees →
            </button>
          </div>
        </div>
      )}

      {/* ── the backtest: full width (owner 17:53) — research bench only.
          The create face is picker → bento → publish (2026-08-12: the chart
          and its range pills were the "old and horrible" chrome there). ── */}
      {!createFace && (
      <div className="mt-5">
        <Card className="min-w-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-3.5">
            <div className="flex items-baseline gap-3">
              <h2 className="font-display text-lg font-bold uppercase tracking-tight text-ink">Backtest</h2>
              {tokenPrice != null && (
                <span className="flex items-baseline gap-2">
                  <span className="font-num text-2xl font-semibold tabular-nums text-ink">${formatNav(tokenPrice, 4)}</span>
                  {combinedPct != null && (
                    <span className={`font-num text-sm tabular-nums ${combinedPct >= 0 ? 'text-teal' : 'text-magenta'}`}>
                      {formatPct(combinedPct, 1)}
                    </span>
                  )}
                  {startDate && (
                    <span className="font-mono text-[9px] uppercase tracking-wide text-ink-faint">
                      if launched at $1.00 · {startDate}
                    </span>
                  )}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {readyAssets.length >= 2 && (
                <button
                  type="button"
                  onClick={() => setSplit((v) => !v)}
                  aria-pressed={split}
                  className={`press rounded-lg px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide ${
                    split ? 'bg-cyan/15 text-cyan ring-1 ring-inset ring-cyan/30' : 'text-ink-faint ring-1 ring-inset ring-white/10 hover:text-ink'
                  }`}
                >
                  Split
                </button>
              )}
              {RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={`press rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wide ${
                    range === r ? 'bg-white/12 text-ink' : 'text-ink-faint hover:text-ink-dim'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div className="relative h-72 sm:h-80">
            {assets.length === 0 ? (
              <div className="relative grid h-full place-items-center px-8 text-center">
                {/* a blueprint of the chart that will draw here (owner 19:15:
                    "a blueprint of how the chart would look behind this text") */}
                <div aria-hidden className="pointer-events-none absolute inset-0 opacity-40">
                  <BacktestBlueprint />
                </div>
                <div className="relative">
                  <div className="font-display text-xl font-bold uppercase tracking-tight text-ink">Start with an asset</div>
                  <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-ink-dim">
                    Add a token and its real price history draws here. Two or more become a
                    backtestable basket token.
                  </p>
                </div>
              </div>
            ) : rows.length < 2 ? (
              <div className="grid h-full place-items-center font-mono text-[11px] uppercase tracking-widest text-ink-faint">
                {loadingHist ? 'Loading price history…' : 'No price history for this mix yet'}
              </div>
            ) : (
              <div className="absolute inset-0 px-2 py-2">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartRows} margin={{ top: 6, right: 2, bottom: 0, left: 2 }}>
                    <defs>
                      <linearGradient id="composer-line" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="var(--color-amber)" />
                        <stop offset="50%" stopColor="var(--color-magenta)" />
                        <stop offset="100%" stopColor="var(--color-cyan)" />
                      </linearGradient>
                      <linearGradient id="composer-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-cyan)" stopOpacity={0.16} />
                        <stop offset="55%" stopColor="var(--color-violet-bright)" stopOpacity={0.1} />
                        <stop offset="100%" stopColor="var(--color-violet-bright)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="time"
                      type="number"
                      scale="time"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(t) => new Date((t as number) * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                      tick={{ fill: 'var(--color-ink-faint)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                      axisLine={false}
                      tickLine={false}
                      minTickGap={48}
                    />
                    <YAxis domain={yDomain} allowDataOverflow hide />
                    <Tooltip
                      cursor={{ stroke: 'rgba(255,255,255,0.28)', strokeWidth: 1, strokeDasharray: '3 4' }}
                      content={<ComposerTooltip assets={readyAssets} split={showSplit} anchors={anchors} />}
                      isAnimationActive={false}
                    />
                    {/* break-even: the $1.00 the token started at (100 rebased) —
                        above the line the mix gained, below it lost. Quiet, but
                        it grounds every point on the chart. */}
                    <ReferenceLine
                      y={100}
                      stroke="rgba(255,255,255,0.16)"
                      strokeDasharray="2 5"
                      ifOverflow="extendDomain"
                      label={{
                        value: '$1.00',
                        position: 'insideLeft',
                        fill: 'var(--color-ink-faint)',
                        fontSize: 9,
                        fontFamily: 'var(--font-mono)',
                        dy: -6,
                      }}
                    />
                    {showSplit &&
                      readyAssets.map((a, j) => (
                        <Line
                          key={keyOf(a)}
                          type="monotone"
                          dataKey={`a${j}`}
                          stroke={a.color}
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 3, fill: a.color, stroke: 'var(--color-void)', strokeWidth: 1.5 }}
                          isAnimationActive={false}
                        />
                      ))}
                    {/* The blend/basket-token line: in SPLIT view it's WHITE +
                        SOLID so it stands out cleanly against the coloured
                        constituents (owner 2026-07-07 18:4x — SUPERSEDES the
                        17:53 "blend takes the gradient in split" call: the
                        gradient blend got lost among the coloured lines). With
                        split OFF it swaps back to the spectral gradient + fill.
                        Solid in both now — no dash. */}
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke={showSplit ? '#f4f4f8' : 'url(#composer-line)'}
                      strokeWidth={showSplit ? 2.5 : 3}
                      fill={showSplit ? 'transparent' : 'url(#composer-fill)'}
                      dot={false}
                      activeDot={{ r: 3.5, fill: showSplit ? '#f4f4f8' : 'var(--color-violet-bright)', stroke: 'var(--color-void)', strokeWidth: 2 }}
                      isAnimationActive={false}
                    />
                    {/* the scenario, on the split view too (owner 17:53): each
                        predicted asset extends dashed in its own color */}
                    {forecast &&
                      showSplit &&
                      forecast.predictedIdx.map((j) => (
                        <Line
                          key={`fca${j}`}
                          type="linear"
                          dataKey={`fca${j}`}
                          stroke={readyAssets[j]?.color}
                          strokeWidth={1.5}
                          strokeDasharray="4 5"
                          strokeOpacity={0.8}
                          dot={false}
                          activeDot={false}
                          isAnimationActive={false}
                        />
                      ))}
                    {forecast && (
                      <Line
                        type="linear"
                        dataKey="fc"
                        stroke="#ffb87a"
                        strokeWidth={2}
                        strokeDasharray="4 5"
                        dot={false}
                        activeDot={false}
                        isAnimationActive={false}
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* owner 19:15 removed the "past performance…" line as clutter; the
              forecast's hypothetical legend stays (only shown when a scenario is
              drawn). NOTE (§9): the backtest is now an unqualified performance
              display — flagged for owner/counsel review. */}
          {forecast && (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 px-5 py-2.5">
              <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wide text-[#ffb87a]">
                <span aria-hidden className="h-0 w-4 border-t-2 border-dashed border-[#ffb87a]" />
                your hypothetical scenario
              </span>
            </div>
          )}
        </Card>

      </div>
      )}

      {/* ── below the backtest (owner 17:53): forecast appears with the first
          asset, launch with the second — forecast left, launch right. The
          CREATE face is picker → mix → publish: the forecast (research chrome,
          2026-08-12) drops and the publish card takes the full row. ── */}
      {(createFace ? stage === 'publish' && canLaunch : assets.length >= 1) && (
        <div className={createFace ? 'enter mt-5' : 'enter mt-5 grid items-start gap-5 md:grid-cols-2'}>
          {!createFace && (
          <Card className="p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-lg font-bold uppercase tracking-tight text-ink">Forecast</h2>
              <button
                type="button"
                onClick={() => setFcInfoOpen(true)}
                aria-label="What is the forecast?"
                className="press grid h-6 w-6 place-items-center rounded-full border border-white/15 font-mono text-[11px] text-ink-faint transition-colors hover:border-cyan/50 hover:text-cyan"
              >
                ?
              </button>
            </div>
            <div className="mt-3 space-y-2">
              <ForecastBar assets={assets} anchors={anchors} value={fcInput} onChange={setFcInput} onAdd={addParsedPoint} />

              {/* the committed points, date-sorted — click to edit, ✕ to drop */}
              {activePoints.map(({ a, pt }) => {
                const addr = keyOf(a)
                const anchor = anchors.get(addr)
                const priceNum = parseFloat(pt.price)
                const implied =
                  anchor && Number.isFinite(priceNum) && priceNum > 0 ? (priceNum / anchor.last - 1) * 100 : null
                return (
                  <div
                    key={pt.id}
                    className="group flex items-center gap-2 rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2 transition-colors hover:border-white/15"
                  >
                    <span aria-hidden className="h-4 w-1 shrink-0 rounded-full" style={{ background: a.color }} />
                    <button
                      type="button"
                      onClick={() => {
                        setFcInput(`${showSymbol(a.symbol)} to $${pt.price} by ${shortMonthDay(pt.date)}`)
                        removePoint(addr, pt.id)
                      }}
                      className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                      aria-label={`Edit ${showSymbol(a.symbol)} forecast`}
                    >
                      <span className="font-display text-sm font-bold uppercase tracking-wide text-ink">
                        {showSymbol(a.symbol)}
                        {dupSyms.has(a.symbol.toLowerCase()) && (
                          <span className="ml-1.5 font-mono text-[9px] font-normal tracking-wide text-ink-faint">{chainMeta(a.chainId).short}</span>
                        )}
                      </span>
                      <span className="font-num text-sm tabular-nums text-ink-dim">${pt.price || '—'}</span>
                      <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">{shortMonthDay(pt.date)}</span>
                    </button>
                    {implied != null && (
                      <span className={`font-num text-[11px] tabular-nums ${implied >= 0 ? 'text-teal' : 'text-magenta'}`}>
                        {formatPct(implied, 1)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => removePoint(addr, pt.id)}
                      className="press grid h-6 w-6 place-items-center rounded-md text-ink-faint hover:bg-white/8 hover:text-ink"
                      aria-label={`Remove ${showSymbol(a.symbol)} forecast`}
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
              <div className="flex items-baseline justify-between border-t border-white/10 pt-2.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                  Basket impact
                  {forecast && (
                    <>
                      {' '}
                      · by {new Date(forecast.endT * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                    </>
                  )}
                </span>
                <span
                  className={`font-num text-2xl font-semibold tabular-nums ${
                    forecast == null ? 'text-ink-faint' : forecast.totalPct >= 0 ? 'text-teal' : 'text-magenta'
                  }`}
                >
                  {forecast == null ? '—' : formatPct(forecast.totalPct, 2)}
                </span>
              </div>
            </div>
          </Card>
          )}

          {canLaunch && (
          <Card className="relative overflow-hidden p-5">
            <div aria-hidden className={`pointer-events-none absolute -right-14 -top-16 h-48 w-48 rounded-full blur-[90px] ${bundle ? 'bg-violet/15' : 'bg-cyan/12'}`} />
            {bundle && (
              <div className="relative mb-1 flex items-center gap-2">
                {bundleGroups.map((g) => (
                  <ChainBadge key={g.chainId} chainId={g.chainId} />
                ))}
              </div>
            )}
            <h2 className="relative font-display text-lg font-bold uppercase tracking-tight text-ink">
              {bundle ? 'Publish the bundle' : 'Launch this basket'}
            </h2>
            {/* SUBHEAD, CUT TO THE FACT (the owner live 2026-08-15: "too much text
                on this create screen"). The chain badges directly above already
                say WHICH networks and how many, and the button below says how
                many transactions — the old sentence restated both and then
                explained the bundle rule a third time. One clause survives:
                the thing the badges cannot show. */}
            <p className="relative mt-1.5 text-sm leading-relaxed text-ink-dim">
              {bundle ? 'One basket per network, one shared name.' : 'Prefilled with your mix.'}
            </p>
            {/* WHAT YOU ARE PUBLISHING, restated where you sign off on it —
                page three showed fees and fields but never the mix itself.
                Read-only: shaping happens on page two, and this is the receipt
                of that, not a second place to edit it. */}
            {createFace && (
              /* THE LEGS, BALANCED AND CENTERED (the owner 2026-08-13: "assets
                 should be balanced and centered across two rows and easier to
                 read/bigger") — the rows split EVENLY from the count rather
                 than however many happen to fit: nine legs read 5 + 4, not
                 8 + 1, and the short row centres under the long one.
                 legRows/legPerRow own that arithmetic; the entries are one
                 type step up with real padding, and the venue chip stays
                 legible but secondary (it is the thing that saves a wasted
                 deploy — see VenueChip). The asset face is the flow's own
                 logo + colour rail, not a third invention. */
              <div className="relative mt-3 flex flex-wrap justify-center gap-2 rounded-xl border border-white/8 bg-white/[0.02] p-2.5">
                {assets.map((a, i) => (
                  <span
                    key={keyOf(a)}
                    className="relative flex items-center gap-2.5 overflow-hidden rounded-xl border border-white/[0.07] bg-black/25 py-2 pl-3 pr-2.5"
                    style={{ width: `calc((100% - ${(legPerRow - 1) * 8}px) / ${legPerRow})` }}
                  >
                    <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: a.color }} />
                    <AssetLogo address={a.address} symbol={a.symbol} chainId={a.chainId} size={28} />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 truncate font-display text-[13px] font-bold uppercase tracking-wide text-ink">
                          {showSymbol(a.symbol)}
                        </span>
                        <span className="shrink-0 font-num text-[13px] tabular-nums text-ink-dim">{(weights[i] ?? 0).toFixed(0)}%</span>
                      </span>
                      <span className="flex">
                        <VenueChip a={a} />
                      </span>
                    </span>
                  </span>
                ))}
              </div>
            )}
            <div className="relative mt-3 space-y-2.5">
              {/* ONLY the name+ticker pair shares a row (the owner's correction,
                  2026-08-15: "I just want the ticker and title boxes next to
                  each other but still full width" — the first cut flexed the
                  WHOLE publish stack and broke every element's width). */}
              <div className="flex w-full flex-col gap-2.5 sm:flex-row">
              <input
                value={name}
                onChange={(e) => {
                  const v = e.target.value.slice(0, 42)
                  setName(v)
                  if (!symbolTouched.current) setSymbol(tickerFromName(v))
                }}
                placeholder={bundle ? 'Bundle name — shared by every network' : 'Basket name'}
                className="min-h-[44px] w-full min-w-0 flex-[2] rounded-xl border border-white/12 bg-black/30 px-3.5 py-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-cyan/50"
              />
              <div className="flex min-w-0 flex-1 items-center rounded-xl border border-white/12 bg-black/30 px-3.5 transition-colors focus-within:border-cyan/50">
                <span aria-hidden className="font-num text-sm text-ink-dim">$</span>
                <input
                  value={symbol}
                  onChange={(e) => {
                    symbolTouched.current = true
                    setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11))
                  }}
                  placeholder={bundle ? 'TICKER — seeds every network' : 'TICKER'}
                  className="min-h-[44px] w-full bg-transparent py-2.5 pl-1 font-display text-sm font-bold uppercase tracking-wide text-ink outline-none placeholder:text-ink-faint"
                />
                {!symbolTouched.current && symbol.length > 0 && (
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">suggested</span>
                )}
              </div>
              </div>
              {/* the inline name/ticker hint line left on the owner's note
                  (2026-08-14 live): the empty fields say enough themselves,
                  and the CTA's own law still decides. */}

              {/* ── THE FEE STATION (owner 2026-08-12 addendum: "the last step
                  (naming the basket) should also include the fee configuration
                  … the fee slider, the amount that goes to them vs holders,
                  the address the fee goes to") — the builder's own dials, one
                  implementation (FeeSlider/FeeSplitBar), prefilling the real
                  flows. Create face only; the research face's card is
                  byte-identical to before. ── */}
              {createFace && (
                <div className="space-y-4 border-t border-white/10 pt-4">
                  <div className="grid gap-6 sm:grid-cols-2">
                    <FeeSlider
                      id="create-fee-pct"
                      label="Total fee"
                      tip={
                        <>
                          The one fee this basket ever charges: taken once per buy, sell or swap, as a %
                          of that trade. There is no management fee and no other cost. You set it now and
                          it is written into the contract forever, nobody (including you) can change it
                          later.
                        </>
                      }
                      value={parseFloat(feePct)}
                      onChange={(v) => setFeePct(v.toFixed(2))}
                      min={feeBounds.minFeeBps / 100}
                      max={feeBounds.maxFeeBps / 100}
                      step={0.05}
                      format={(v) => `${v.toFixed(2)}%`}
                      minLabel={`${(feeBounds.minFeeBps / 100).toFixed(2)}%`}
                      maxLabel={`${(feeBounds.maxFeeBps / 100).toFixed(2)}%`}
                      defaultValue={1}
                    />
                    <FeeSlider
                      id="create-creator-share"
                      label="Your share of it"
                      tip={
                        <>
                          {`Every fee first burns ${(feeBounds.burnShareBps / 100).toFixed(0)}% as PRISM and reserves the small protocol slices. This slider is YOUR cut of what remains, paid to your payout address on every trade${bundle ? ', on every network' : ''}. Whatever you don't take belongs to the basket's holders — they always keep at least ${(100 - feeBounds.maxCreatorShareBps / 100).toFixed(0)}% of the remainder. Fixed forever at deploy.`}
                        </>
                      }
                      value={parseFloat(creatorSharePct)}
                      onChange={(v) => setCreatorSharePct(String(Math.round(v)))}
                      min={0}
                      max={feeBounds.maxCreatorShareBps / 100}
                      step={1}
                      format={(v) => `${Math.round(v)}%`}
                      minLabel="0%"
                      maxLabel={`${(feeBounds.maxCreatorShareBps / 100).toFixed(0)}%`}
                    />
                  </div>
                  {/* who gets what — the split drawn live against the sliders,
                      league-aware for the draft's own networks (owner live
                      2026-08-14: the league-less bar overstated the creator) */}
                  <FeeSplitBar
                    creatorShareBps={creatorShareBps}
                    leagueBps={Math.max(0, ...[...new Set(assets.map((a) => a.chainId))].map((cid) => deploymentFor(cid).leagueShareBps))}
                  />
                  {creatorShareBps === 0 ? (
                    <p className="font-mono text-[10px] leading-relaxed text-teal">
                      You&rsquo;re taking no fee — your whole share flows to the basket&rsquo;s holders.
                    </p>
                  ) : (
                    <div>
                      {/* the "— every network pays it" tail retired with the
                          rest of the create-screen trim: the label sits under a
                          header that already names the networks, and the fact it
                          added is the default a reader assumes anyway. */}
                      <label htmlFor="create-creator-payout" className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                        your payout address
                      </label>
                      <input
                        id="create-creator-payout"
                        value={creatorPayout}
                        onChange={(e) => setCreatorPayout(e.target.value)}
                        placeholder={account ? `${account.slice(0, 6)}…${account.slice(-4)} — this wallet (paste another to redirect)` : '0x… where your fee is sent'}
                        spellCheck={false}
                        className={`mt-2 w-full rounded-xl border bg-black/30 px-3.5 py-2.5 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:border-cyan/50 ${
                          payoutValid ? 'border-white/12' : 'border-alert/50'
                        }`}
                      />
                      {!payoutValid && (
                        <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-alert">
                          That address doesn&rsquo;t verify — mixed-case addresses carry a checksum, and this one fails it.
                          Paste it exactly as your wallet or the explorer shows it.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* A PARKED RUN, SAID OUT LOUD (the 2026-08-14 hijack guard's
                  other half): an interrupted publish that is NOT this draft
                  never seeds the ceremony — but its deploys were PAID, so it
                  is surfaced with an explicit discard, never silently eaten. */}
              {/* the parked-run notice left the create flow (the owner live
                  2026-08-15: "it shouldn't show… in the basket creation
                  flow") — the hijack guard still holds silently: a foreign
                  run never seeds this ceremony, and a matching subject still
                  resumes. The memory row just stops advertising itself. */}
              {/* WHAT IT COSTS, BEFORE THE BUTTON (owner 2026-08-12). Stated in
                  transactions and in the network's own fee, which is the whole
                  of it — Spectrum charges nothing to publish. No estimate is
                  quoted: this repo has no deploy-gas estimator, and a made-up
                  figure on a money surface is worse than an honest sentence. */}
              {createFace && (
                /* THE COST LINE, CUT TO ITS TWO FACTS (same 2026-08-15 note).
                   It said "one per network" and "sent one at a time" — both
                   already stated above — then made the same no-extra-cost point
                   twice in one sentence. What a person needs before signing is
                   how many transactions and who charges them. */
                <p className="font-mono text-[10px] leading-relaxed text-ink-faint">
                  {bundle
                    ? `${bundleGroups.length} transactions · network fees only, nothing from us.`
                    : 'One transaction · network fee only, nothing from us.'}
                </p>
              )}

              <button
                type="button"
                onClick={launchIt}
                disabled={createFace && !feeValid}
                className="press w-full rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black transition-transform hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
                style={{
                  background: bundle
                    ? 'linear-gradient(90deg,var(--color-violet-bright),var(--color-magenta),var(--color-amber))'
                    : 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))',
                }}
              >
                {bundle ? `Publish on ${bundleGroups.length} networks →` : 'Launch this basket →'}
              </button>
            </div>
          </Card>
          )}
        </div>
      )}

      {/* ── the launch popup: the real builder, right here (owner 17:53) ──
          Portaled to <body> (no ancestor stacking-context surprises). No
          backdrop-click or Escape close — the builder runs a deploy flow and
          its own search uses Escape; the ✕ is the only way out. */}
      {launchOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[70] overflow-y-auto bg-black/70 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-label="Launch this basket"
          >
            <div className="mx-auto my-6 w-[min(64rem,calc(100vw-2rem))]">
              <div className="rounded-3xl p-px" style={{ background: CARD_GRAD }}>
                <div className="rounded-[calc(var(--radius-3xl)_-_1px)] bg-panel/[0.97] p-4 sm:p-6">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h2 className="font-display text-lg font-bold uppercase tracking-tight text-ink">Launch this basket</h2>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => navigate('/create?studio=1')}
                        className="press rounded-md border border-white/12 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim hover:border-white/30 hover:text-ink"
                      >
                        Open full page ↗
                      </button>
                      <button
                        type="button"
                        onClick={() => setLaunchOpen(false)}
                        aria-label="Close launch"
                        className="press grid h-8 w-8 place-items-center rounded-md text-ink-dim hover:bg-white/8 hover:text-ink"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <BasketBuilder />
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* the bundle ceremony — per-network readiness, then sequential real
          deploys under the one shared name (publish-bundle-model's lanes) */}
      {addToast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-8 z-[95] flex justify-center px-4">
          <div className="search-pop pointer-events-auto max-w-md overflow-hidden rounded-2xl border border-white/12 bg-void/95 shadow-2xl backdrop-blur-md">
            <div aria-hidden className="h-1 w-full" style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
            <p role="status" className="px-5 py-4 text-center text-[14px] leading-relaxed text-ink">
              {addToast}
            </p>
          </div>
        </div>
      )}
      {publishOpen && (
        <PublishBundleModal
          groups={bundleGroups}
          seedName={name}
          seedSymbol={symbol}
          initialFeePct={createFace ? feePct : undefined}
          initialCreatorSharePct={createFace ? creatorSharePct : undefined}
          initialCreatorPayout={createFace ? payoutTrimmed : undefined}
          alreadyLive={[...landedRef.current.entries()].map(([chainId, newAddress]) => ({ chainId, newAddress }))}
          lockedName={landedNameRef.current ?? undefined}
          onLaneDone={(chainId, newAddress, shippedName) => {
            landedRef.current.set(chainId, newAddress)
            landedNameRef.current = shippedName
            // the subject binds the persisted run to THIS mix (hijack guard)
            recordLandedLane(shippedName, { chainId, newAddress }, bundleGroups.length > 0 ? bundleSubjectOf(bundleGroups) : undefined)
          }}
          onPublished={() => {
            publishedRef.current = true
            // the deployed-ticker stamp retires this ticker's drafts on every
            // resume surface (the TEST100 ghost) — at COMPLETION, not per lane:
            // mid-run the draft is the ceremony's own resume door (a first-lane
            // stamp deleted it and orphaned the remaining lanes on refresh)
            markTickerDeployed(symbol)
          }}
          onClose={() => {
            setPublishOpen(false)
            if (publishedRef.current) {
              // the bundle is live — a fresh composer, not a re-armed one
              publishedRef.current = false
              landedRef.current = new Map()
              landedNameRef.current = null
              clearLandedLanes()
              setAssets([])
              setWeights([])
              setScenario({})
              setName('')
              setSymbol('')
            }
          }}
        />
      )}

      {fcInfoOpen && <ForecastInfoModal onClose={() => setFcInfoOpen(false)} />}
    </div>
  )
}

// ── the "what is the forecast?" explainer (owner 19:15): a worked example with
// the real chart idiom — a solid backtest line that continues dashed to a point
// you set, so people see how a forecast reads before they build one. ─────────
function ForecastInfoModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[70] grid place-items-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="What is the forecast?"
      onClick={onClose}
    >
      <div className="w-[min(30rem,100%)] rounded-3xl p-px" style={{ background: CARD_GRAD }} onClick={(e) => e.stopPropagation()}>
        <div className="rounded-[calc(var(--radius-3xl)_-_1px)] bg-panel/[0.97] p-5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-display text-lg font-bold uppercase tracking-tight text-ink">What is the forecast?</h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="press grid h-8 w-8 place-items-center rounded-md text-ink-dim hover:bg-white/8 hover:text-ink"
            >
              ✕
            </button>
          </div>

          {/* worked example: the solid backtest continues dashed to a set point */}
          <div className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-black/30 p-3">
            <svg viewBox="0 0 260 96" className="h-auto w-full" role="img" aria-label="Example: a backtest line continuing to a forecast point">
              <defs>
                <linearGradient id="fc-info-line" x1="0" y1="0" x2="100%" y2="0">
                  <stop offset="0%" stopColor="var(--color-amber)" />
                  <stop offset="50%" stopColor="var(--color-magenta)" />
                  <stop offset="100%" stopColor="var(--color-cyan)" />
                </linearGradient>
              </defs>
              <line x1="0" y1="66" x2="260" y2="66" stroke="rgba(255,255,255,0.14)" strokeWidth="1" strokeDasharray="2 3" />
              <text x="2" y="62" fill="var(--color-ink-faint)" fontSize="8" fontFamily="var(--font-mono)">$1.00</text>
              {/* the backtest so far — solid */}
              <polyline points="8,70 44,64 80,68 116,52 150,44" fill="none" stroke="url(#fc-info-line)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              {/* the forecast you set — dashed amber to your point */}
              <polyline points="150,44 200,30 244,16" fill="none" stroke="#ffb87a" strokeWidth="2" strokeDasharray="4 4" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="244" cy="16" r="3.5" fill="#ffb87a" stroke="var(--color-void)" strokeWidth="1.5" />
              <text x="150" y="86" fill="#7a7a88" fontSize="8" fontFamily="var(--font-mono)">backtest</text>
              <text x="196" y="86" fill="#ffb87a" fontSize="8" fontFamily="var(--font-mono)">your forecast →</text>
            </svg>
          </div>

          <div className="mt-4 space-y-2.5 text-sm leading-relaxed text-ink-dim">
            <p>
              The backtest replays your mix on real prices — the solid line. The{' '}
              <span className="text-[#ffb87a]">forecast</span> is the dashed part: you say where you think a
              token will trade and when, and we carry the line out to that point.
            </p>
            <p>
              Type it in plain words — <span className="text-ink">“SYRUP to $0.50 by Aug 30”</span> — add as
              many calls as you like, and the basket impact updates to what your mix would be worth then.
            </p>
            <p className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">
              It’s a hypothesis you draw, not a prediction.
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── the natural-language forecast bar (owner 19:15) ─────────────────────────
// Type "SYRUP to $0.50 by Aug 30"; a live read-back shows what's understood and
// the implied move, Enter (or Add) commits it. Focused-and-empty shows one
// editable template per asset so people build the forecast themselves.
function ForecastBar({
  assets,
  anchors,
  value,
  onChange,
  onAdd,
}: {
  assets: ComposedAsset[]
  anchors: Map<string, { first: number; last: number }>
  value: string
  onChange: (v: string) => void
  onAdd: (addr: string, dateISO: string, priceStr: string) => void
}) {
  const [focused, setFocused] = useState(false)
  const parsed = useMemo(() => parseForecastEntry(value, assets, Date.now()), [value, assets])
  const anchor = parsed.key ? anchors.get(parsed.key) : undefined
  const implied = anchor && parsed.price != null ? (parsed.price / anchor.last - 1) * 100 : null
  const dateFuture = parsed.dateISO != null && (dateToUnix(parsed.dateISO) ?? 0) * 1000 > Date.now()
  const ready = !!(parsed.key && parsed.price != null && parsed.dateISO && dateFuture)

  const submit = () => {
    if (!ready) return
    onAdd(parsed.key as string, parsed.dateISO as string, priceToInput(parsed.price as number))
    onChange('')
  }

  const suggestions = assets
    .filter((a) => anchors.has(keyOf(a)))
    .map((a) => ({
      key: keyOf(a),
      symbol: a.symbol,
      color: a.color,
      text: `${showSymbol(a.symbol)} to $${priceToInput(anchors.get(keyOf(a))!.last)} by ${shortMonthDay(isoDay(Date.now() + 30 * DAY_MS))}`,
    }))

  let hint: React.ReactNode = 'e.g. “SYRUP to $0.50 by Aug 30”'
  if (value.trim()) {
    if (!parsed.key) hint = 'name a token from your mix'
    else if (parsed.price == null) hint = 'add a target price like $0.50'
    else if (!parsed.dateISO) hint = 'add a date, e.g. “by Aug 30”'
    else if (!dateFuture) hint = 'pick a future date'
    else
      hint = (
        <span className="text-ink-dim">
          <span className="font-bold text-ink">{showSymbol(parsed.symbol)}</span> → ${priceToInput(parsed.price as number)} · {shortMonthDay(parsed.dateISO as string)}
          {implied != null && <span className={implied >= 0 ? 'text-teal' : 'text-magenta'}> · {formatPct(implied, 1)}</span>}
        </span>
      )
  }

  return (
    <div className="relative">
      <div className={`flex items-center gap-2 rounded-xl border bg-black/30 px-3 py-2 transition-colors ${ready ? 'border-cyan/45' : 'border-white/12 focus-within:border-white/25'}`}>
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 17l6-6 4 4 8-8" />
          <path d="M17 7h4v4" />
        </svg>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Forecast a token to a price by a date…"
          aria-label="Forecast a token to a price by a date"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
        />
        <button
          type="button"
          disabled={!ready}
          onClick={submit}
          className={`press shrink-0 rounded-lg px-3 py-1 font-display text-[11px] font-bold uppercase tracking-[0.14em] transition-colors ${
            ready ? 'bg-cyan/15 text-cyan ring-1 ring-inset ring-cyan/30' : 'text-ink-faint ring-1 ring-inset ring-white/10'
          }`}
        >
          Add
        </button>
      </div>
      <div className="mt-1.5 px-1 font-mono text-[10px] tracking-wide text-ink-faint">{hint}</div>
      {focused && !value.trim() && suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s.key}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                onChange(s.text)
              }}
              className="press inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.03] py-1 pl-1.5 pr-2.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-dim hover:border-white/30 hover:text-ink"
            >
              <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.symbol}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── the empty-state blueprint (owner 19:15): a wireframe of the backtest chart
// — dashed grid, a break-even baseline, and a dashed spectral curve rising
// across it — so the empty panel reads as "your chart draws here". Decorative. ─
function BacktestBlueprint() {
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-full w-full" aria-hidden>
      <defs>
        <linearGradient id="composer-blueprint-line" x1="0" y1="0" x2="100%" y2="0">
          <stop offset="0%" stopColor="var(--color-amber)" />
          <stop offset="50%" stopColor="var(--color-magenta)" />
          <stop offset="100%" stopColor="var(--color-cyan)" />
        </linearGradient>
      </defs>
      {[8, 16, 24, 32].map((y) => (
        <line key={`h${y}`} x1="0" y1={y} x2="100" y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth="0.4" strokeDasharray="1.5 2.5" vectorEffect="non-scaling-stroke" />
      ))}
      {[25, 50, 75].map((x) => (
        <line key={`v${x}`} x1={x} y1="0" x2={x} y2="40" stroke="rgba(255,255,255,0.05)" strokeWidth="0.4" strokeDasharray="1.5 2.5" vectorEffect="non-scaling-stroke" />
      ))}
      {/* break-even baseline — the $1.00 the real chart marks */}
      <line x1="0" y1="30" x2="100" y2="30" stroke="rgba(255,255,255,0.16)" strokeWidth="0.6" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      <polyline
        points="0,31 12,28 24,32 36,25 48,22 60,24 72,15 84,18 96,9"
        fill="none"
        stroke="url(#composer-blueprint-line)"
        strokeWidth="1.6"
        strokeDasharray="3 3"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

// ── tooltip: the basket token ($ + %) + each asset's rebased move ────────────
function ComposerTooltip({
  active,
  payload,
  assets,
  split,
  anchors,
}: {
  active?: boolean
  payload?: { payload: Record<string, number> }[]
  assets: ComposedAsset[]
  split: boolean
  anchors: Map<string, { first: number; last: number }>
}) {
  if (!active || !payload || payload.length === 0) return null
  const p = payload[0].payload
  // one ticker on two chains would paint two identical rows — mark those
  const dups = duplicateSymbols(assets)
  const rowLabel = (a: ComposedAsset) =>
    dups.has(a.symbol.toLowerCase()) ? `${a.symbol} · ${chainMeta(a.chainId).short}` : a.symbol
  if (p.value == null && p.fc != null) {
    return (
      <div className="min-w-[11rem] rounded-lg border border-[#ffb87a]/40 bg-void/90 px-3 py-2 shadow-xl backdrop-blur">
        <div className="flex items-baseline justify-between gap-4">
          <span className="font-mono text-[9px] uppercase tracking-wide text-ink-faint">Basket token</span>
          <span className="font-num text-sm font-semibold tabular-nums text-[#ffb87a]">${formatNav(p.fc / 100, 4)}</span>
        </div>
        {split &&
          assets.map((a, j) => {
            const rel = p[`fca${j}`]
            const first = anchors.get(keyOf(a))?.first
            if (rel == null || first == null) return null
            return (
              <div key={keyOf(a)} className="mt-1 flex items-baseline justify-between gap-4">
                <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-dim">
                  <span aria-hidden className="h-1 w-3 rounded-full" style={{ background: a.color }} />
                  {rowLabel(a)}
                </span>
                <span className="font-num text-[11px] tabular-nums text-ink">{formatPrice((rel / 100) * first)}</span>
              </div>
            )
          })}
        <div className="mt-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-faint">
          hypothetical · {new Date((p.time as number) * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
        </div>
      </div>
    )
  }
  return (
    <div className="min-w-[12rem] rounded-lg border border-white/15 bg-void/90 px-3.5 py-2.5 shadow-xl backdrop-blur">
      <div className="flex items-baseline justify-between gap-5">
        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-faint">Basket token</span>
        <span className="flex items-baseline gap-2">
          <span className="font-num text-sm font-semibold tabular-nums text-ink">${formatNav(p.value / 100, 4)}</span>
          <span className={`font-num text-[11px] tabular-nums ${p.value >= 100 ? 'text-teal' : 'text-magenta'}`}>
            {formatPct(p.value - 100, 1)}
          </span>
        </span>
      </div>
      {split && assets.length > 0 && (
        <div className="mt-1.5 space-y-0.5 border-t border-white/10 pt-1.5">
          {assets.map((a, j) => (
            <div key={keyOf(a)} className="flex items-baseline justify-between gap-5">
              <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-dim">
                <span aria-hidden className="h-1 w-3 rounded-full" style={{ background: a.color }} />
                {rowLabel(a)}
              </span>
              <span className={`font-num text-[11px] tabular-nums ${(p[`a${j}`] ?? 100) >= 100 ? 'text-teal' : 'text-magenta'}`}>
                {p[`a${j}`] != null ? formatPct(p[`a${j}`] - 100, 1) : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-faint">
        {new Date((p.time as number) * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  )
}
