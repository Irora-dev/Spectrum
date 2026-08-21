import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { reapportionStrips, squarify, squarifyGroups, type TmRect } from '../lib/treemap'
import { AssetLogo } from './AssetLogo'
import { ChainLogo } from './ChainBadge'
import { AssetHoverCard } from './AssetHoverCard'
import { tokenVisual } from '../lib/spectrum/token-meta'
import { useTokenColors } from '../lib/spectrum/use-token-color'
import { formatUsdCompact } from '../lib/spectrum/format'
import { innerLegsFit, type TileClassSignal } from '../lib/spectrum/class-signal'
import { capMeterLabel } from '../lib/spectrum/market-tiers'

/** THE ENTRANCE COUNT-UP (touch round, owner 2106): a where-held amount rolls
 *  from zero to its figure once, when the tile first seats it. Direct DOM
 *  writes on rAF — no per-frame React state — and the FINAL frame writes the
 *  exact formatted string handed in, so the number standing when motion ends
 *  is the caller's own figure, never an interpolation. useLayoutEffect seats
 *  the zero state before first paint (no flash of the full value), and
 *  reduced-motion renders the final figure immediately, no roll at all. */
function CountUpUsd({
  usd,
  formatted,
  className,
  style,
}: {
  usd: number
  formatted: string
  className?: string
  style?: CSSProperties
}) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !(usd > 0)) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.textContent = formatUsdCompact(0)
    let raf = 0
    const t0 = performance.now()
    const D = 700
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / D)
      const eased = 1 - Math.pow(1 - t, 3)
      el.textContent = t >= 1 ? formatted : formatUsdCompact(usd * eased)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      el.textContent = formatted
    }
    // entrance-only by design: re-rolling on every price tick would turn a
    // welcome into a slot machine
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <span ref={ref} className={className} style={style}>
      {formatted}
    </span>
  )
}

export interface BentoItem {
  symbol: string
  address: string
  weightPct: number
  chainId: number
  /** Draw the chain's own mark inside the ticker pill. For surfaces where the
   *  SAME asset legitimately appears on several chains (the thesis bento's two
   *  WETH tiles): the ticker alone cannot say which is which, and hover is not
   *  a phone's answer. Callers set it per item — typically only on the
   *  duplicated assets, so single-instance tiles stay unmarked. */
  chainMark?: boolean
  /** Unique key when addresses may collide across chains, or for synthetic
   *  context tiles (the reshape picture's cash pile). Defaults to `address`. */
  id?: string
  /** Display %, for when `weightPct` carries a floored LAYOUT weight so a
   *  zeroed tile stays visible and tappable. The label shows THIS number —
   *  the label never lies about the plan, only the geometry is floored. */
  labelPct?: number
  /** A context tile: drawn quieter and never selectable (the cash pile is
   *  moved by trims and adds, not dialed). */
  muted?: boolean
  /** Drawn DARK but still selectable — the publish picker's resting state
   *  ("they're kind of dark, and you select which ones you want to make
   *  public"). Selection visuals beat dim; muted beats both. */
  dim?: boolean
  /** OUT OF THE RUNNING entirely — the darkest state, never selectable (the
   *  publish picker's baskets: they show so the picture is the whole
   *  portfolio, but they cannot be legs). Must read DARKER than `dim`:
   *  `muted` is quiet-but-present context, and a vivid identity hue at
   *  muted's brightness outshone every pickable tile on the board. */
  excluded?: boolean
  /** Shared-element handle (the glide): a CSS view-transition-name applied to
   *  the tile's positioned root, so the SAME name on another surface's tile
   *  lets the browser morph one into the other across a route change.
   *  Optional-absent = nothing changes anywhere. */
  transitionName?: string
  /** Layout group (owner ~23:2x: spotlighted tiles "rearranged to be grouped
   *  together"; the group-by pills "rearrange the bento by the pill metric").
   *  Tiles sharing a group lay out CONTIGUOUSLY; group regions follow the
   *  bento's `groupOrder`. Absent on every item = the plain treemap. */
  group?: string
  /** Identity colour override — the cash tile's "special cash green" (owner
   *  ~09:5x). Absent = the token's own visual, exactly as before. */
  color?: string
  /** OPTIONAL FOOTER (owner 2026-08-02 ~21:2x, the portfolio's picture view):
   *  "include position size on the bento grid for each asset — a vignette /
   *  dark gradient at the bottom where we display the position amount and %,
   *  and the dexscreener link, and even a % increase over a time period."
   *
   *  Optional so the shared bento is UNCHANGED wherever it is not passed: the
   *  homepage and the basket cards render exactly as before. A tile only grows
   *  a footer when a surface asks for one, and only when the tile is big enough
   *  to carry it without crowding the ticker. */
  footer?: {
    /** Already formatted by the caller — the bento does not know about money. */
    amount: string
    /** 24h change, percent. Null = unreadable, and it is then NOT shown: a
     *  missing change is not a flat one. Renders in the FOOTER STACK under
     *  the amount, beside the price (the owner 2026-08-06: the top-cluster pill
     *  "feels very messy" — the bottom vignette is where ink reads). */
    change24hPct?: number | null
    /** The asset's unit price, formatted by the caller (the bento does not
     *  know about money). Second line of the footer stack. */
    price?: string
    /** An outbound chart link, if the surface has one for this asset. */
    href?: string
    /** Accessible label for that link. */
    hrefLabel?: string
    /** The venue's REAL brand mark, so the link is recognisable as DexScreener
     *  rather than a generic arrow. Rendered beside the ticker (owner ~21:3x:
     *  "the dexscreener should show as the dexscreener icon next to the ticker
     *  name") — a chart link belongs with the asset's identity, not buried in
     *  the money strip. */
    markSrc?: string
    /** WHAT THE TILE IS MADE OF (owner ~09:5x: the cash tile "needs to show
     *  which stablecoins it's made up of on the actual bento") — small rows
     *  above the amount, drawn only when the tile is tall enough to seat
     *  them. Caller-worded; amount optional (a single component reads better
     *  as a plain label than as its own total repeated).
     *  `share` (0–1, owner 2026-08-05: "too ugly" on the stacked rows): when
     *  every row carries one, the rows render as a SINGLE PROPORTIONAL SPLIT
     *  BAR with compact labels on the fill — a fill beats a number column.
     *  Any row without a share keeps the old text-row presentation. */
    breakdown?: {
      label: string
      amount?: string
      share?: number
      /** The raw dollars behind `amount` (touch round 3): lets the folded bar
       *  COUNT UP at tile entrance — the formatted `amount` string stays the
       *  landing value, so the final frame is always the exact figure. */
      amountUsd?: number
    }[]
  }
  /** AT-A-GLANCE CLASS SIGNAL (owner 2026-08-05, option A confirmed from
   *  previews: shape grammar + cap meter — class-signal.ts carries the
   *  grammar and why it is deliberately color-free). Optional-absent = the
   *  tile renders exactly as it always has, on every surface that does not
   *  pass one. */
  classSignal?: TileClassSignal
  /** THE BASKET'S OWN LEGS (owner 2026-08-05: "when a basket is a big enough
   *  portion of the portfolio, the basket bento should show the bento assets
   *  within the bento") — rendered as a mini-treemap INSIDE the tile, only
   *  when the tile's MEASURED box passes `innerLegsFit`: legibility decides,
   *  never the share (a 20% tile is a stamp on a phone, a wall on a
   *  desktop). Display-only exposure — a basket is a POSITION; these are
   *  what it carries — so the mini-cells are never selectable. */
  innerLegs?: { symbol: string; address?: string; weightPct: number }[]
  /** A SMALL STANDING FACT beside the ticker (owner 2026-08-05 21:06: a
   *  basket with a newer version "should also pop up on the actual bento").
   *  No urgency theater — a quiet chip whose title carries the sentence. */
  badge?: { label: string; title?: string }
  /** WHAT AN AGGREGATE TILE IS MADE OF, AS MARKS (the owner 2026-08-06 12:49 #7:
   *  the cash tile's held stablecoins "slightly overlapping" at the bottom
   *  right). Replaces the single logo in that same slot — a tile that stands
   *  for several assets cannot honestly wear just one of their faces. Absent
   *  = the usual one-logo tile, unchanged on every other surface. */
  logoCluster?: { address: string; symbol: string; chainId: number }[]
  /** JUST ARRIVED (the owner 2026-08-06 12:58: a newly detected position "glows for
   *  the first time in your positions in the bento"). A ring in the tile's own
   *  hue that breathes rather than flashes — the point is "look here", not
   *  alarm. Absent = the tile is drawn exactly as before. */
  isNew?: boolean
}

const VW = 300 // virtual width; height derives from the `aspect` prop (default 3:2)
/** The widest box a PHONE will draw, however wide the host asked for. 1.25 is
 *  near-square: five tiles then get ~2.5x the height a 2.2 box gave them.
 *
 *  RATIFIED BY THE PM (UIGuy, 2026-08-07): 1.25 is right, and it belongs HERE
 *  rather than each host opting in — "a cramped tile is cramped on every
 *  surface, and if each caller re-derived the floor they would drift within a
 *  week." His homepage hero passes 1.6 on phone and this cap correctly
 *  overrides it (at 390 that is ~294x235 for five tiles, taller than what he
 *  shipped), so it is deliberately NOT special-cased.
 *  ⚠ IF THIS IS EVER RETUNED, TEST IT AGAINST FIVE TILES, NOT NINE — the hero
 *  cut its rotating window to 5 below `sm`, and a cap that looks right for nine
 *  slivers is not the cap that looks right for five real tiles. */
const PHONE_MAX_ASPECT = 1.25

// Tile AREA scales by weight^SIZE_EXP (< 1) so a dominant holding doesn't take a
// full-height column and the long tail stays legible. Labels show the TRUE weight.
const SIZE_EXP = 0.65

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** One key per tile — `id` beats `address` so synthetic tiles and same-address
 *  assets on two chains cannot collide in the treemap. */
const keyOf = (i: BentoItem) => (i.id ?? i.address).toLowerCase()

// Deterministic 0..1 per asset — gives each tile its own sheen timing.
function hashUnit(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return (h % 997) / 997
}

// Basket as a squarified treemap; ticker/weight/logo scale to each block's real
// pixel size (measured) so a 12-token basket stays legible in a small card.
export function BasketBento({
  items,
  compact = false,
  className = '',
  reveal,
  show = true,
  entrance,
  aspect = 1.5,
  fill = false,
  expandable = false,
  hoverShareLabel = 'of basket',
  onSelect,
  onOpen,
  selectedId = null,
  selectedIds,
  ariaPressedIds,
  groupOrder,
  animateLayout = false,
  layoutMotion = 'glide',
}: {
  items: BentoItem[]
  compact?: boolean
  className?: string
  // Optional staggered entrance: each tile pops in by weight rank when `show`
  // flips true. Omit for the default (all tiles visible immediately).
  reveal?: { delayMs: number; stepMs: number }
  show?: boolean
  /** Premium per-tile entrance (owner 2026-08-06 15:2x: "the colour filling
   *  up with a fluid kinda wave from bottom to top"): each tile mounts with
   *  its color RISING like liquid — a clipped fill with a bright crest —
   *  then its content fades in. Plays once per tile mount; reduced motion
   *  skips to the settled tile. Absent = tiles render exactly as before. */
  entrance?: 'fill'
  // Layout aspect ratio (width / height). 1.5 = 3:2 (default); pass a larger
  // value (e.g. 3.2) for a wide, full-width strip of tiles.
  //
  // ⚠ A PHONE IGNORES A WIDE ASPECT (the owner, 2026-08-07, on the homepage:
  // "we need to allow the bento assets to use a bit more width and height so the
  // smaller bentos in the grid dont look too cramped"). A box like 2.2 is only
  // ~177px tall inside a 390px phone, and five tiles inside that leaves the
  // small ones a sliver each — the ticker, the amount and the percent are all
  // fighting for the same 40px. Below `sm` the box is capped at
  // PHONE_MAX_ASPECT so every tile gets real height, which is the same reasoning
  // the portfolio's own map already used (it goes portrait on phones). Hosts do
  // not opt in: a cramped tile is cramped on every surface, so the floor lives
  // here rather than being re-derived by each caller.
  aspect?: number
  // Fill the parent's box (measures real width AND height) instead of imposing
  // `aspect`. Use when the bento sits in a flex/grid cell that owns the height.
  fill?: boolean
  // Hover-to-expand: hovering a tile dims the rest and pops a brand-colored
  // preview card (logo, price, 24h, sparkline) for that asset. Lazy-loaded.
  expandable?: boolean
  /** The hover card's share wording — 'of portfolio' on the portfolio mount. */
  hoverShareLabel?: string
  // Tiles as CONTROLS (the reshape picture): tap/Enter selects a tile to dial.
  // Absent = the bento stays the pure display every other surface renders.
  onSelect?: (id: string) => void
  /** THE DOUBLE-CLICK DOOR (touch round 3): open this tile somewhere deeper
   *  (the portfolio passes the positions mode). Independent of onSelect —
   *  a display-only bento can still be a door. */
  onOpen?: (id: string) => void
  selectedId?: string | null
  // Multi-select (the publish picker): every id in the set wears the ring.
  selectedIds?: ReadonlySet<string>
  // Accessibility-only toggle state (same keys as selectedIds): when set, a
  // selectable tile's aria-pressed reads from THIS set instead of the visual
  // selection. Needed because isSelected doubles as a filter-suppressor — a
  // pickable board expressing exclusion via `dim` (the found book) has no
  // honest way to VOICE the toggle without also un-dimming it. Display
  // untouched; absent = today's aria exactly.
  ariaPressedIds?: ReadonlySet<string>
  // Region order for item `group`s (first = top-left). Groups not listed
  // append in first-seen order; items without a group form a trailing region.
  groupOrder?: string[]
  // Animate tiles to their new place/size as weights change, so dialing an
  // allocation visibly grows or shrinks the structure.
  animateLayout?: boolean
  // HOW layout changes move (owner 22:xx live: "make moving around the bento
  // with the slider feel more graceful"). 'glide' suits a DISCRETE change —
  // one long expo settle. During a DRAG it is exactly wrong: every input tick
  // restarts the 450ms curve toward a target that immediately moves again, so
  // tiles rubber-band behind the thumb. 'live' is a short ease-out that
  // re-targets from the tile's current interpolated position each tick and
  // tracks the hand; the caller flips it on while a slider is moving.
  layoutMotion?: 'glide' | 'live'
}) {
  // Unknown tokens upgrade from hash colors to their logo's dominant color as
  // extractions land (items carry per-item chainId; 1 is just the fallback).
  useTokenColors(items, items[0]?.chainId ?? 1)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hovered, setHovered] = useState<string | null>(null)
  // TAP THE WHERE-HELD BAR → the exact per-chain rows, tap to fold (touch
  // round 3). Per-tile, user-undoable; ids of tiles that left the picture
  // linger harmlessly. Touch-first by design — the bar's labels were the
  // hover-free summary, this is the hover-free detail.
  const [unfoldedIds, setUnfoldedIds] = useState<Set<string>>(new Set())
  // BENTO KEYBOARD NAV (touch round 2): roving tabindex — ONE tile in the tab
  // order, arrows walk the map. A treemap has no rows to index, so "next" is
  // geometry: nearest tile whose center lies in the arrow's half-plane,
  // aligned tiles preferred (lateral drift costs double). Selectable tiles
  // (the weight station) keep their existing all-tabbable behavior — arrows
  // are added there, the tab order is not changed under its tests.
  const [rovingKey, setRovingKey] = useState<string | null>(null)
  const tileEls = useRef(new Map<string, HTMLDivElement>())
  // MEASURE THE BOX WHENEVER IT APPEARS — a CALLBACK ref, not an effect.
  //
  // This was `useEffect(..., [])` reading `ref.current`, and it silently never
  // ran: the component early-returns a placeholder while `rects` is empty, and
  // that placeholder carries no ref, so on first mount `ref.current` was null,
  // the effect bailed, and with `[]` deps it never tried again. `size` stayed
  // {0,0} for the component's whole life and every pixel calculation fell back
  // to `cW = 320` — against a container measured at 1150.
  //
  // The damage was invisible because LAYOUT is percentage-based and looked
  // right, while everything sized in PIXELS off cW was computed at roughly a
  // quarter scale: tickers pinned to their floor, amounts and cap meters gated
  // away as "too small", on tiles the browser was painting at 270x438. the owner
  // reported all three separately as different bugs.
  const roRef = useRef<ResizeObserver | null>(null)
  const measure = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    if (!el) return
    setSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (cr) setSize({ w: cr.width, h: cr.height })
    })
    ro.observe(el)
    roRef.current = ro
  }, [])
  useEffect(() => () => roRef.current?.disconnect(), [])
  const width = size.w
  const height = size.h

  // ONE resolution of the box shape, used by the layout AND by both the
  // placeholder and the real container — three sites read it, so a divergence
  // here would draw a box of one shape and lay tiles out for another.
  // Read once per mount, like the other phone decisions in this lane (a
  // rotation reloads). matchMedia rather than innerWidth so it agrees with the
  // `sm` breakpoint the rest of the surface uses.
  const isPhone = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 639px)').matches
    : false
  const boxAspect = isPhone ? Math.min(aspect, PHONE_MAX_ASPECT) : aspect
  const VH = fill && width > 0 && height > 0 ? VW * (height / width) : VW / boxAspect
  // WHILE THE DIAL IS LIVE, SLOT ORDER FREEZES (08:55: fast dialing made
  // tiles "stack on each other" — the dialed tile kept crossing weight ranks,
  // so the treemap swapped slot order every tick and tiles teleported across
  // the grid, permanently mid-flight). Frozen order = tiles resize IN PLACE,
  // tracking the hand; the settle back to 'glide' re-sorts once, smoothly.
  const liveMode = animateLayout && layoutMotion === 'live'
  // zap machinery is declared ahead of the layout memo: LIVE rank crossings
  // register zaps from inside it (owner ~10:0x: "it should zap position
  // live while you scroll the slider, not only on stop")
  const zaps = useRef(new Set<string>())
  const noMotion =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  /** Live slot assignment: keys in REST slot order; neighbours bubble-swap
   *  as their weights cross (2% hysteresis so equals don't flutter), each
   *  swap zapping both tiles — identities exchange, boxes stay. Cleared on
   *  release; the settle then has little left to move. */
  const liveOrderRef = useRef<string[] | null>(null)
  if (!liveMode) liveOrderRef.current = null
  // WHILE LIVE, THE LAYOUT IS STRIP-FROZEN (owner ~09:3x: distant tiles
  // "move even when another asset not close gets changed", and the dialed
  // tile "changes literally size too much"). The rest layout's strips are
  // kept and only the dialed tile's OWN strip re-divides its space — its
  // strip-mates absorb the change, every other strip's rects come out
  // byte-identical, so nothing far away can move and the dialed tile's
  // growth is bounded by its strip. Labels and dollars stay fully live;
  // the release plays the TRUE layout once, with the glide/zap.
  const restRects = useRef<TmRect[]>([])
  const rects = useMemo(() => {
    const live = items.filter((i) => i.weightPct > 0)
    const tm = (i: BentoItem) => ({ ticker: keyOf(i), weight: Math.pow(i.weightPct, SIZE_EXP) })
    // live dialing over an unchanged tile SET: re-apportion inside the rest
    // strips, with LIVE RANK SWAPS — when a neighbour's weight crosses,
    // the two exchange SLOTS (a zap: boxes stay, identities swap) so the
    // order corrects mid-drag instead of all at once on release
    if (liveMode && restRects.current.length > 0) {
      const restKeys = new Set(restRects.current.map((r) => r.ticker))
      if (live.length === restKeys.size && live.every((i) => restKeys.has(keyOf(i)))) {
        const weights = new Map(live.map((i) => [keyOf(i), Math.pow(i.weightPct, SIZE_EXP)]))
        if (!liveOrderRef.current) liveOrderRef.current = restRects.current.map((r) => r.ticker)
        const order = liveOrderRef.current
        for (let n = 0; n < order.length - 1; n++) {
          const a = order[n]
          const b = order[n + 1]
          if ((weights.get(b) ?? 0) > (weights.get(a) ?? 0) * 1.02) {
            order[n] = b
            order[n + 1] = a
            if (!noMotion) {
              zaps.current.add(a)
              zaps.current.add(b)
            }
          }
        }
        const assigned = restRects.current.map((r, n) => ({ ...r, ticker: order[n] }))
        return reapportionStrips(assigned, weights)
      }
    }
    const grouped = live.some((i) => i.group != null)
    if (!grouped) return squarify(live.map(tm), VW, VH)
    // regions follow groupOrder; unknown groups append first-seen; items
    // WITHOUT a group always form the trailing region
    const wanted = groupOrder ?? []
    const seen: string[] = []
    for (const i of live) if (i.group != null && !seen.includes(i.group)) seen.push(i.group)
    const order = [
      ...wanted.filter((g) => seen.includes(g)),
      ...seen.filter((g) => !wanted.includes(g)),
      ...(live.some((i) => i.group == null) ? ['~ungrouped'] : []),
    ]
    const buckets = order
      .map((g) => live.filter((i) => (i.group ?? '~ungrouped') === g).map(tm))
      .filter((b) => b.length > 0)
    return squarifyGroups(buckets, VW, VH, 3)
  }, [items, VH, groupOrder, liveMode])
  if (!liveMode) restRects.current = rects
  // ── THE FLUID BEND (owner 2026-08-03 ~00:3x: "the bento that moves when
  //    you reweight should feel smoother… a stretch/transform that bends it
  //    a little as it moves"). Squash-and-stretch: when a tile's slot
  //    changes, it leans INTO the travel — stretched along the dominant
  //    axis, squashed on the other, proportional to how far it moves — then
  //    relaxes to identity over the same duration the box glides, so the
  //    bend rides the motion and dies with it. Two-phase: the render that
  //    moves a tile applies the bend with NO transform transition, a
  //    post-paint tick releases it WITH one. Velocity-proportional for free:
  //    slow drags barely bend, fast sweeps visibly lean. Skipped entirely
  //    under prefers-reduced-motion.
  const prevRects = useRef(new Map<string, TmRect>())
  const bends = useRef(new Map<string, string>())
  // THE ZAP (owner 2026-08-03 ~09:2x: "assets swap position too randomly…
  // what actually happens is the colour sort of zaps from one asset to the
  // other — they swap their colours and tickers rather than physically
  // move"). When two tiles MUTUALLY EXCHANGE slots (each lands where the
  // other stood, within tolerance — which is exactly what a rank crossing
  // between near-equal tiles produces), their boxes SNAP instead of flying
  // past each other, and each tile fires a bright pulse: to the eye the two
  // boxes stay put and their colours/tickers zap across. Genuine moves
  // (different-sized slots, reflows, regroups) keep the physical glide.
  const [, bumpRelax] = useState(0)
  if (animateLayout && !noMotion) {
    const prev = prevRects.current
    const next = new Map<string, TmRect>()
    const moved: { key: string; from: TmRect; to: TmRect }[] = []
    for (const r of rects) {
      next.set(r.ticker, r)
      const p = prev.get(r.ticker)
      if (!p) continue
      const dx = r.x + r.w / 2 - (p.x + p.w / 2)
      const dy = r.y + r.h / 2 - (p.y + p.h / 2)
      const dist = Math.abs(dx) + Math.abs(dy)
      if (dist < 1) continue
      moved.push({ key: r.ticker, from: p, to: r })
    }
    // mutual exchanges first: A lands on B's old slot AND B lands on A's
    const isNear = (a: TmRect, b: TmRect) => {
      const dc = Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) + Math.abs(a.y + a.h / 2 - (b.y + b.h / 2))
      const tol = 0.3 * Math.min(a.w + a.h, b.w + b.h)
      const ratio = (a.w * a.h) / Math.max(1e-6, b.w * b.h)
      return dc < tol && ratio > 0.55 && ratio < 1.8
    }
    const swapped = new Set<string>()
    for (let i = 0; i < moved.length; i++) {
      if (swapped.has(moved[i].key)) continue
      for (let j = i + 1; j < moved.length; j++) {
        if (swapped.has(moved[j].key)) continue
        if (isNear(moved[i].to, moved[j].from) && isNear(moved[j].to, moved[i].from)) {
          swapped.add(moved[i].key)
          swapped.add(moved[j].key)
          zaps.current.add(moved[i].key)
          zaps.current.add(moved[j].key)
          break
        }
      }
    }
    // everyone else bends into their travel as before
    for (const m of moved) {
      if (swapped.has(m.key)) continue
      const dx = m.to.x + m.to.w / 2 - (m.from.x + m.from.w / 2)
      const dy = m.to.y + m.to.h / 2 - (m.from.y + m.from.h / 2)
      const dist = Math.abs(dx) + Math.abs(dy)
      const mag = Math.min(0.06, dist / 500)
      const horiz = Math.abs(dx) >= Math.abs(dy)
      const sx = horiz ? 1 + mag : 1 - mag * 0.55
      const sy = horiz ? 1 - mag * 0.55 : 1 + mag
      bends.current.set(m.key, `scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`)
    }
    prevRects.current = next
  }
  useEffect(() => {
    if (bends.current.size === 0 && zaps.current.size === 0) return
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        bends.current.clear()
        zaps.current.clear()
        bumpRelax((n) => n + 1)
      }),
    )
    return () => cancelAnimationFrame(raf)
  }, [rects])

  const byAddr = useMemo(() => new Map(items.map((i) => [keyOf(i), i])), [items])
  // Weight rank (0 = largest) drives the staggered reveal order.
  const rankByAddr = useMemo(() => {
    const m = new Map<string, number>()
    ;[...items]
      .filter((i) => i.weightPct > 0)
      .sort((a, b) => b.weightPct - a.weightPct)
      .forEach((it, i) => m.set(keyOf(it), i))
    return m
  }, [items])

  if (rects.length === 0) {
    return fill ? (
      <div className={`h-full w-full rounded-xl bg-white/[0.02] ${className}`} />
    ) : (
      <div className={`w-full rounded-xl bg-white/[0.02] ${className}`} style={{ aspectRatio: String(boxAspect) }} />
    )
  }

  const cW = width || 320
  const cH = fill && height > 0 ? height : cW * (VH / VW)

  // Expanded preview placement: center the card on the hovered tile, then clamp
  // so it never spills outside the bento box. Dimensions track AssetHoverCard.
  const HOVER_W = 208
  const HOVER_H = 150
  const hoveredItem = expandable && hovered ? byAddr.get(hovered) : null
  const hoveredRect = expandable && hovered ? rects.find((rr) => rr.ticker.toLowerCase() === hovered) : null
  // THE CARD NEVER COVERS THE TICKER ROW (the owner 2026-08-06 14:24: hovering a
  // small tile "covers the entire tile, so you can't actually press on the
  // dexscreener button… it never goes over the ticker and the dexscreener
  // button"). Centring on the tile did exactly that: on a tile shorter than the
  // card, the preview swallowed the very control it was previewing — a hover
  // affordance that eats a click target is worse than no affordance.
  //
  // So the card hangs BELOW the tile's ticker band. If there is no room below
  // inside the box, it goes fully ABOVE the tile instead — either way the top
  // strip of the tile, where the ticker and its chart link live, stays clear.
  const hoverPos = (() => {
    if (!hoveredRect || cW <= 0) return null
    const tileTop = (hoveredRect.y / VH) * cH
    const tileH = (hoveredRect.h / VH) * cH
    const left = clamp(((hoveredRect.x + hoveredRect.w / 2) / VW) * cW - HOVER_W / 2, 4, Math.max(4, cW - HOVER_W - 4))
    // the ticker band scales with the tile but never below a tappable strip
    const band = clamp(tileH * 0.3, 26, 40)
    const maxTop = Math.max(4, cH - HOVER_H - 4)
    const below = tileTop + band
    if (below <= maxTop) return { left, top: below }
    const above = tileTop - HOVER_H - 6
    return { left, top: above >= 4 ? above : maxTop }
  })()

  // the roving stop: the last-focused tile if it still exists, else the map's
  // first (largest) tile — a spotlight regroup must never strand the tab stop
  const rovingActual =
    rovingKey && rects.some((r) => r.ticker.toLowerCase() === rovingKey) ? rovingKey : rects[0]?.ticker.toLowerCase()
  const focusByArrow = (fromKey: string, arrow: string) => {
    const dir = arrow === 'ArrowLeft' ? 'left' : arrow === 'ArrowRight' ? 'right' : arrow === 'ArrowUp' ? 'up' : 'down'
    const from = rects.find((r) => r.ticker.toLowerCase() === fromKey)
    if (!from) return
    const fx = from.x + from.w / 2
    const fy = from.y + from.h / 2
    let best: { k: string; d: number } | null = null
    for (const r of rects) {
      const k = r.ticker.toLowerCase()
      if (k === fromKey) continue
      const cx = r.x + r.w / 2
      const cy = r.y + r.h / 2
      const forward = dir === 'left' ? fx - cx : dir === 'right' ? cx - fx : dir === 'up' ? fy - cy : cy - fy
      if (forward <= 0.5) continue
      const lateral = Math.abs(dir === 'left' || dir === 'right' ? cy - fy : cx - fx)
      const d = forward + lateral * 2
      if (!best || d < best.d) best = { k, d }
    }
    if (best) {
      setRovingKey(best.k)
      tileEls.current.get(best.k)?.focus()
    }
  }

  return (
    <div
      ref={measure}
      className={`relative w-full ${fill ? 'h-full' : ''} ${className}`}
      style={fill ? undefined : { aspectRatio: String(boxAspect) }}
    >
      {rects.map((r) => {
        const it = byAddr.get(r.ticker.toLowerCase())
        if (!it) return null
        const bW = (r.w / VW) * cW
        const bH = (r.h / VH) * cH
        const minDim = Math.min(bW, bH)
        // THE TICKER READS AT TILE SCALE (the owner 2026-08-06: "the tickers are
        // tiny, fix them"). The ceilings were 13px and 14px, set back when a
        // dense 25-tile book was the worst case — but a ceiling is a CAP, so a
        // 300px tile got the same 13px ticker as a 90px one and the name simply
        // stopped growing with the thing it names. On a lean 8-position book,
        // where every tile is large, that is every tile.
        //
        // Only the HEADROOM moves. The floors (6.5 / 8) and the ramp are
        // untouched, so the dense case renders byte-identically — this widens
        // what a big tile is allowed to be, it does not resize small ones.
        // FLOORS RAISED, not just ceilings (the owner 2026-08-06: "the tickers are
        // tiny, fix them"). Measuring the live lean book showed tickers pinned
        // at the 6.5px FLOOR on tiles the DOM renders at 222x110 — so the
        // computed minDim is far smaller than the painted box. That mismatch is
        // real and not yet root-caused; raising the floor makes the name legible
        // at every size regardless of which end of the clamp wins, which is what
        // he actually asked for. 11px is the smallest a ticker stays readable.
        // TYPE RAMPS RESCALED FOR A CORRECT minDim.
        //
        // Every coefficient here (0.15 ticker, 0.17 weight, 0.42 logo) was
        // tuned by eye against the BROKEN measurement above, where minDim came
        // back ~4x too small. Fixing the box made the same coefficients fire at
        // true scale and the type went from tiny to enormous — the numbers were
        // never right, they were compensating. So they are re-derived against
        // the real range this bento actually produces (minDim ~110 on a small
        // tile, ~270 on a large one, ~440 on the tallest):
        //
        //   ticker  110 -> 11    270 -> 16    440 -> 17 (cap)
        //   weight  110 -> 10    270 -> 15    440 -> 16 (cap)
        //   logo    110 -> 20    270 -> 35    440 -> 40 (cap)
        //
        // Tight floors and ceilings on purpose: across a 4x spread of tile
        // sizes the type should move a little, not a lot — a bento reads as one
        // object, and a ticker that quadruples with its tile stops looking like
        // the same UI element.
        const tickerFont = clamp(minDim * 0.06, 11, 17)
        const weightFont = clamp(minDim * 0.055, 10, 16)
        const logoSize = Math.round(clamp(minDim * 0.13, 20, 40))
        const showTicker = minDim > 19
        // THE IDENTITY MARK HOLDS ON LONGER (the owner 2026-08-06: a small
        // position must still show "the ticker, logo and how much you have").
        // 46 dropped the logo off any tile shorter than that, so a wide-but-
        // short tile lost its face while keeping its name. The mark scales
        // with the box (logoSize clamps to 14 at the bottom), and
        // showLogoFinal below still yields to a genuine stacking collision —
        // so this widens WHO gets a logo without letting one overlap text.
        const showLogo = !compact && minDim > 32 && bW > 50
        // the item's colour override (the cash tile's green) wins over the
        // token visual; overridden tiles are deep tones, so ink goes white
        const visBase = tokenVisual(it.symbol, it.address)
        const vis = it.color ? { ...visBase, color: it.color, ink: '#fff' } : visBase
        // ── THE CLASS SIGNAL (owner 2026-08-05, option A): geometry with
        //    meaning, never hue — cash rounds to a pill (liquid), stock
        //    sharpens (the certificate), a basket wears a double border (the
        //    container, drawn literally), crypto carries a 1–3 bar cap meter
        //    beside its %. Absent signal = the exact tile this always was.
        const signal = it.classSignal
        const tileRadius = signal?.kind === 'cash' ? Math.min(24, bH / 2) : signal?.kind === 'stock' ? 3 : 12
        const capBars = signal?.kind === 'crypto' ? signal.capBars : undefined
        // ── THE NESTED BENTO (owner 2026-08-05): a big-enough basket tile
        //    shows its own legs as a mini-treemap. The band sits under the
        //    ticker row and above the footer; if the leftover band is too
        //    short to be legible, it simply does not draw — never a squint.
        const innerLegs =
          signal?.kind === 'basket' && it.innerLegs && !compact && innerLegsFit(bW, bH, it.innerLegs.length)
            ? it.innerLegs
            : null
        const innerMap = (() => {
          if (!innerLegs) return null
          const padX = 8
          // the top band clears the ticker; the 24h moved to the FOOTER
          // stack (the owner 2026-08-06), so the bottom band grows instead —
          // a mini-map under a money line, never through it
          const top = Math.max(28, tickerFont + 16)
          const bottom = it.footer ? (bH >= 96 ? 48 : bH >= 74 ? 36 : 8) : 8
          const w = bW - padX * 2
          const h = bH - top - bottom
          if (w < 72 || h < 44) return null
          // index-keyed tickers: two legs may share a SYMBOL (the dup-target
          // class) but the map must never merge or drop one
          const cells = squarify(
            innerLegs.map((l, i) => ({ ticker: String(i), weight: Math.max(0.0001, l.weightPct) })),
            w,
            h,
          )
          return { padX, top, w, h, cells }
        })()
        // Per-tile sheen: bigger tiles get a broader band; each tile is phase-
        // and speed-offset by a hash of its address so glints don't march in sync.
        const seed = hashUnit(it.address)
        const sheenBand = clamp(4 + ((minDim - 30) / 170) * 6, 4, 10)
        const sheenDur = 9 + seed * 5
        // % normally sits inline to the right of the ticker; if the box is too
        // narrow to fit both side-by-side (and there's vertical room for it),
        // drop the % BELOW the ticker so the ticker keeps its full width instead
        // of being truncated by the percentage.
        const pctText = `${Math.round(it.labelPct ?? it.weightPct)}%`
        const innerW = bW - 12
        // The venue mark rides INSIDE the ticker pill (owner: "right next to
        // the ticker, in line with it") — so it widens the pill's budget too.
        const hasInlineMark = !!(it.footer?.href && it.footer.markSrc) && bW >= 104
        // Approx rendered pill width (Chakra Petch bold uppercase + tracking is wide).
        const tickerW = it.symbol.length * tickerFont * 0.78 + 12 + (hasInlineMark ? tickerFont + 4 : 0) + (it.chainMark ? tickerFont + 4 : 0)
        // THE TICKER NEVER CLIPS FOR THE SAKE OF THE % (owner 2026-08-02: "if
        // the % removes the ticker / clips it then the % should go below it so
        // the ticker shows"). Measure the real inline budget — inner width less
        // the %'s own width and the gap — instead of a fudged fraction: stack
        // whenever the ticker wouldn't fit beside it and two lines have room.
        // THE CAP METER IS PART OF THE RIGHT-HAND CLUSTER (the owner 2026-08-06:
        // "the smallest shown assets, their tickers are clipped off, so you
        // need to move the % and the icon for small/med/high cap to below the
        // ticker"). pctW measured the % ALONE, so on a tile carrying a meter
        // the budget was over-stated by the meter's width and the ticker
        // clipped while the code believed it fitted.
        const meterW = capBars ? weightFont + 6 : 0
        const pctW = pctText.length * weightFont * 0.62 + meterW
        const inlineBudget = innerW - pctW - 6
        const tickerFitsInline = tickerW <= inlineBudget
        // Two lines need less room than the old guard demanded: the ticker and
        // the % ROW, not the ticker plus a full second line of chrome.
        const roomToStack = bH - 8 >= tickerFont + weightFont + 2
        const stackPct = showTicker && !tickerFitsInline && roomToStack
        // LAST RESORT, and the point of the whole block: if the ticker does not
        // fit inline AND there is no room to stack, DROP the % and the meter
        // rather than clip the name. A clipped ticker is an unidentifiable
        // position; a missing % is a number that is still on the tile's own
        // footer and in its tooltip. Losing the smaller fact beats losing the
        // identity — the same ruling as the risk curve's band labels.
        const dropPctForTicker = showTicker && !tickerFitsInline && !roomToStack
        // When stacked, only keep the logo if it ALSO fits below the ticker + %;
        // otherwise drop it so the now-full-width ticker stays readable. A
        // tile whose middle band carries the nested legs drops it too — the
        // mini-map IS the tile's picture now.
        const showLogoFinal = showLogo && !innerMap && (!stackPct || bH - 12 >= tickerFont + weightFont + logoSize + 14)
        // Footer vignette: ONE deep tone of the tile's own hue, alpha rising on
        // an eased curve. A transparent→colour two-stop ramp interpolates
        // through grey and shows a visible onset band (owner: "too harsh");
        // same-tone alpha stops fade with no edge at all.
        // the fade's GROUND rides a plane var: void-black on the dark styles
        // (default), white on paper — a 64%-black wash under every tile read
        // as mud on light mode (owner 2026-08-19)
        const vignTone = `color-mix(in srgb, ${vis.color} var(--bento-vign-mix, 36%), var(--bento-vign-base, #000))`
        const vignette = it.footer
          ? `linear-gradient(180deg, ${(
              [
                [0, 0],
                [5, 20],
                [14, 36],
                [28, 52],
                [47, 68],
                [70, 84],
                [94, 100],
              ] as const
            )
              .map(([a, at]) => `color-mix(in srgb, ${vignTone} ${a}%, transparent) ${at}%`)
              .join(', ')})`
          : undefined
        // Optional pop-in, sequenced by weight rank.
        const tileKey = keyOf(it)
        // keyboard-openable: the double-click door, reachable without a mouse
        const openable = !!onOpen && !it.muted && !it.excluded
        const rank = rankByAddr.get(tileKey) ?? 0
        // Layout animation: position/size move to their new treemap slot so a
        // dialed allocation visibly grows or shrinks the structure. 'glide'
        // (discrete change) eases; 'live' (mid-drag) is DIRECT MANIPULATION —
        // no box transition at all, every frame paints one complete
        // consistent treemap, so tiles CANNOT overlap while dragging (his
        // 08:55 stacking: re-targeted transitions were permanently mid-
        // flight between disagreeing layouts; measured 180-240px sustained
        // overlap under a fast sweep, zero once boxes snap). The fluid feel
        // lives in the bend (below) and the glide settle on release.
        const layoutTiming = layoutMotion === 'live' ? null : '0.45s cubic-bezier(0.32,0.72,0,1)'
        const layoutTrans =
          animateLayout && layoutTiming
            ? ['left', 'top', 'width', 'height'].map((prop) => `${prop} ${layoutTiming}`).join(', ')
            : null
        // The entrance stagger delays ONLY the entrance (opacity/transform,
        // per-property delays in the shorthand) — NEVER the layout motion.
        // A single transitionDelay used to ride every property, so during
        // live dialing the late-rank tiles started each glide ~330ms after
        // the layout had already reflowed: the smallest tiles sat stacked on
        // stale rects through every fast drag (his 08:55 "they all stack on
        // each other… cash disappears"). Reproduced, then fixed here.
        const enterDelay = reveal ? `${reveal.delayMs + rank * reveal.stepMs}ms` : '0ms'
        // a zapped tile SNAPS its box (no layout transition this render) —
        // the identities exchange in place while the pulse below sells it
        const zapped = animateLayout && zaps.current.has(r.ticker)
        const tileLayoutTrans = zapped ? null : layoutTrans
        const revealStyle = reveal
          ? {
              opacity: show ? 1 : 0,
              transform: show ? 'scale(1)' : 'scale(0.82)',
              transition: `opacity 0.4s ease ${enterDelay}, transform 0.5s cubic-bezier(0.16,1,0.3,1) ${enterDelay}${tileLayoutTrans ? `, ${tileLayoutTrans}` : ''}`,
            }
          : tileLayoutTrans
            ? { transition: tileLayoutTrans }
            : zapped
              ? { transition: 'none' }
              : undefined
        // When a tile is hovered (expandable mode), fade the others back so the
        // expanded preview reads clearly; lift the active tile above its siblings.
        const isHovered = hovered === tileKey
        const dimStyle =
          expandable && hovered
            ? { opacity: isHovered ? 1 : 0.35, transition: 'opacity 0.2s ease', zIndex: isHovered ? 30 : undefined }
            : undefined
        const selectable = !!onSelect && !it.muted && !it.excluded
        const isSelected = (selectedId != null && tileKey === selectedId.toLowerCase()) || !!selectedIds?.has(tileKey)
        // Text tracks the tile: font sizes ease only when the BOX eases —
        // during live snapping both move together per frame.
        const textTrans = animateLayout && layoutTiming ? { transition: `font-size ${layoutTiming}` } : undefined
        // The fluid bend (see above): applied instantly on the render that
        // moves the tile, relaxed with its own constant timing so it works
        // in both motion modes. The zap pulse rides the same two-phase
        // machinery on the FILTER channel: bright on the swap render,
        // relaxing over the settle — the energy transfer he described.
        const bend = animateLayout ? bends.current.get(r.ticker) : undefined
        // Brightness states, darkest last: full (pickable/at rest) → muted
        // 0.72 (quiet context, stays readable) → dim 0.5 (dark until picked)
        // → excluded 0.36 (out of the running — must sit UNDER dim, or the
        // unpickable tiles outshine the pickable ones they sit beside).
        const baseFilter = it.excluded
          ? 'saturate(0.32) brightness(0.36)'
          : it.muted
            ? 'saturate(0.5) brightness(0.72)'
            : it.dim && !isSelected
              ? 'saturate(0.55) brightness(0.5)'
              : ''
        const zapFilter = zapped ? `${baseFilter} brightness(1.85) saturate(1.4)`.trim() : baseFilter
        const innerTransition = [
          animateLayout ? (bend ? 'transform 0s' : 'transform 0.22s cubic-bezier(0.25,0.46,0.45,0.94)') : null,
          zapped ? 'filter 0s' : animateLayout || (it.dim && !it.muted) ? 'filter 0.45s ease' : null,
        ]
          .filter(Boolean)
          .join(', ')
        return (
          <div
            key={r.ticker}
            ref={(el) => {
              if (el) tileEls.current.set(tileKey, el)
              else tileEls.current.delete(tileKey)
            }}
            className="absolute p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-cyan/80"
            onMouseEnter={expandable ? () => setHovered(tileKey) : undefined}
            onMouseLeave={expandable ? () => setHovered((h) => (h === tileKey ? null : h)) : undefined}
            /* TAP OPENS THE PREVIEW ON TOUCH (owner 2026-08-06 23:13: "if you
               tap on one of the bento assets, can you actually see the popup
               like you do when you hover with the mouse? That'd be good").
               The card was hover-only, so on a phone the 7d preview simply did
               not exist. Tap TOGGLES (a second tap dismisses — a touch device
               has no mouseleave), and `selectable` still wins the click where a
               host uses tiles as controls, so no picker changes behaviour. */
            onClick={
              selectable
                ? () => onSelect(tileKey)
                : expandable
                  ? () => setHovered((h) => (h === tileKey ? null : tileKey))
                  : undefined
            }
            onDoubleClick={openable ? () => onOpen(tileKey) : undefined}
            onKeyDown={
              selectable || openable
                ? (e) => {
                    if (e.key.startsWith('Arrow')) {
                      // the map owns its arrows (roving pattern); the page
                      // must not scroll under a focus move
                      e.preventDefault()
                      focusByArrow(tileKey, e.key)
                      return
                    }
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      if (selectable) onSelect(tileKey)
                      else if (openable) onOpen(tileKey)
                    }
                  }
                : undefined
            }
            onFocus={selectable || openable ? () => setRovingKey(tileKey) : undefined}
            role={selectable || openable ? 'button' : undefined}
            tabIndex={selectable ? 0 : openable ? (tileKey === rovingActual ? 0 : -1) : undefined}
            aria-pressed={selectable ? (ariaPressedIds ? ariaPressedIds.has(tileKey) : isSelected) : undefined}
            aria-label={
              selectable
                ? `$${showSymbol(it.symbol)}, ${pctText} — adjust`
                : openable
                  ? `$${showSymbol(it.symbol)}, ${pctText} — open positions at this asset`
                  : undefined
            }
            style={{
              left: `${(r.x / VW) * 100}%`,
              top: `${(r.y / VH) * 100}%`,
              width: `${(r.w / VW) * 100}%`,
              height: `${(r.h / VH) * 100}%`,
              // the focus ring follows the tile's own geometry (a ring is a
              // box-shadow; box-shadows follow border-radius) — a pill tile
              // wears a pill ring, never a mismatched rectangle
              borderRadius: tileRadius + 2,
              ...revealStyle,
              ...dimStyle,
              ...(isSelected ? { zIndex: 20 } : {}),
              ...(it.transitionName ? { viewTransitionName: it.transitionName } : {}),
            }}
          >
            <div
              className={`bento-tile-plate relative h-full w-full overflow-hidden ${selectable ? 'cursor-pointer' : ''} ${entrance === 'fill' ? 'bento-fill-host' : ''}`}
              style={{
                ['--tile-color' as never]: vis.color,
                // the signal's geometry: pill for cash, sharp for stock, the
                // house radius otherwise (signal-less tiles keep exactly 12)
                borderRadius: tileRadius,
                // entrance='fill': the color arrives on the rising overlay
                // below; the plate starts as dark glass so the liquid reads
                background: entrance === 'fill' ? 'rgba(255,255,255,0.04)' : vis.color,
                // raised tile: bright top edge + soft inner bottom shade;
                // the selected tile wears a cyan ring OUTSIDE that
                // JUST ARRIVED wears a breathing ring in its OWN hue, so the
                // tile still says which asset it is — selection's cyan ring
                // beats it, because that one answers a question you just asked
                boxShadow: `inset 0 1px 0 rgba(255,255,255,0.30), inset 0 -3px 7px rgba(0,0,0,0.22)${
                  isSelected
                    ? ', 0 0 0 2px var(--color-cyan), 0 8px 28px -8px rgba(0,0,0,0.7)'
                    : it.isNew
                      ? `, 0 0 0 2px ${vis.color}, 0 0 18px -2px ${vis.color}`
                      : ''
                }`,
                // A STILL GLOW, not a pulse: the keyframe would have to live in
                // index.css, which is the shared shell UIGuy owns — a ring in
                // the tile's own hue already says "look here", and a breathing
                // version is one line behind his word on that file.
                // the fluid bend rides the move and relaxes with it
                ...(animateLayout ? { transform: bend ?? 'scale(1, 1)' } : {}),
                ...(innerTransition ? { transition: innerTransition } : {}),
                // the cash pile is context, not a control — drawn quieter; a
                // dim tile (publish picker, unpicked) is darker still but
                // stays live; a ZAPPED tile pulses bright over either base
                ...(zapFilter ? { filter: zapFilter } : {}),
              }}
              title={`${showSymbol(it.symbol)} · ${(it.labelPct ?? it.weightPct).toFixed(1)}%`}
            >
              {entrance === 'fill' && (
                /* THE LIQUID (owner 15:3x: "a wave at the top so it feels like
                   liquid"): a color block RISES (translateY — its top edge is
                   a real moving surface) and TWO undulating SVG waves ride
                   that surface, drifting at different speeds and phases, in
                   the tile's own color — the front one solid, the back one
                   translucent for depth. They drift past the tile's top and
                   clip away as the liquid settles. The HOST staggers mounts,
                   one tile at a time. */
                <div aria-hidden className="bento-fill absolute inset-0">
                  <div className="bento-fill-liquid" style={{ background: vis.color }}>
                    <svg className="bento-fill-wave bento-fill-wave-back" viewBox="0 0 480 40" preserveAspectRatio="none" style={{ color: vis.color }}>
                      <path fill="currentColor" opacity="0.5" d="M0,20 C20,36 40,36 60,20 S100,4 120,20 S160,36 180,20 S220,4 240,20 S280,36 300,20 S340,4 360,20 S400,36 420,20 S460,4 480,20 L480,40 L0,40 Z" />
                    </svg>
                    <svg className="bento-fill-wave bento-fill-wave-front" viewBox="0 0 480 40" preserveAspectRatio="none" style={{ color: vis.color }}>
                      <path fill="currentColor" d="M0,20 C20,4 40,4 60,20 S100,36 120,20 S160,4 180,20 S220,36 240,20 S280,4 300,20 S340,36 360,20 S400,4 420,20 S460,36 480,20 L480,40 L0,40 Z" />
                    </svg>
                    <span className="bento-fill-crest" />
                  </div>
                </div>
              )}
              {/* the top vignette is RETIRED (the owner 2026-08-06, superseding
                  his 2026-08-05 ask that added it): the 24h line it existed
                  to carry moved to the footer stack, so the top cluster is
                  just the white-pill ticker + the meter — legible bare. */}
              {/* vertical light → shade gives the block dimension (3D tile) */}
              <div
                aria-hidden
                className="absolute inset-0"
                style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.14), rgba(255,255,255,0) 34%, rgba(0,0,0,0.16))' }}
              />
              {/* diagonal sheen — slowly sweeps across, staggered by x so the
                  highlight travels over the whole card */}
              <div
                aria-hidden
                className="bento-sheen absolute inset-0"
                style={{
                  backgroundImage: `linear-gradient(115deg, transparent ${(50 - sheenBand).toFixed(1)}%, rgba(255,255,255,0.14) 50%, transparent ${(50 + sheenBand).toFixed(1)}%)`,
                  animationDuration: `${sheenDur.toFixed(1)}s`,
                  animationDelay: `${(-seed * sheenDur).toFixed(2)}s`,
                }}
              />
              {/* basket: the DOUBLE BORDER — the container drawn literally
                  (tile edge = outer wall, this inset ring = inner wall) */}
              {signal?.kind === 'basket' && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-1 ring-1 ring-white/35"
                  style={{ borderRadius: Math.max(4, tileRadius - 4) }}
                />
              )}
              {/* THE NESTED BENTO: the basket's legs as a mini-treemap in the
                  middle band — exposure on display inside the position */}
              {innerMap && innerLegs && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute"
                  style={{ left: innerMap.padX, top: innerMap.top, width: innerMap.w, height: innerMap.h }}
                >
                  {innerMap.cells.map((c) => {
                    const leg = innerLegs[Number(c.ticker)]
                    if (!leg) return null
                    const legVis = tokenVisual(leg.symbol, leg.address ?? leg.symbol)
                    const cw = c.w - 2
                    const ch = c.h - 2
                    if (cw < 6 || ch < 6) return null
                    const showLegLabel = cw >= 34 && ch >= 15
                    return (
                      <div
                        key={c.ticker}
                        className="absolute overflow-hidden"
                        style={{
                          left: c.x + 1,
                          top: c.y + 1,
                          width: cw,
                          height: ch,
                          borderRadius: 3,
                          background: legVis.color,
                          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -2px 4px rgba(0,0,0,0.18)',
                        }}
                      >
                        {showLegLabel && (
                          <span
                            className="absolute left-1 top-0.5 font-display font-bold uppercase leading-none text-white/90"
                            style={{ fontSize: 8, textShadow: '0 1px 3px rgba(0,0,0,0.55)' }}
                          >
                            {leg.symbol}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              {/* THE FOOTER — a vignette carrying what the tile is WORTH.
                  Only when the caller supplies one AND the tile is tall enough
                  to seat it: on a small tile it would cover the ticker, and a
                  label that hides the thing it labels is worse than absent.
                  Text sits on the dark end of a gradient, never on the tile's
                  own colour, which is the contrast rule this codebase keeps. */}
              {/* HOW MUCH YOU HAVE IS NEVER DROPPED (the owner 2026-08-06: even a
                  1%-or-less asset must "always make space to show the ticker,
                  logo and how much you have").
                  This gate was bH>=74 && bW>=96, which is a CLIFF: a tile at
                  92px wide showed no money at all, while one 4px wider showed
                  it in full. Measured on the live book — CRV sat at 92×135 and
                  silently lost its amount. A money fact must DEGRADE (smaller
                  type), never vanish, so the container now opens as soon as the
                  tile can hold a line of text; the richer lines below keep
                  their own, higher thresholds and drop out first. */}
              {!compact && it.footer && bH >= 40 && bW >= 54 && (
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 px-2 pb-1.5"
                  style={{
                    // Deepened form of the tile's own hue (owner: "complement
                    // the colour it sits on — light blue goes dark blue — a
                    // bit larger, still a gradual fade"); the run scales with
                    // the tile so big tiles carry a properly larger fade.
                    // Never taller than the tile itself — on a short tile a
                    // 48px minimum was a wash over the whole box.
                    paddingTop: Math.round(Math.min(clamp(bH * 0.5, 48, 96), bH * 0.7)),
                    background: vignette,
                  }}
                >
                  <span className="min-w-0 flex-1">
                    {/* share-less breakdown rows (other callers) keep the old
                        presentation; share-carrying rows moved to the TOP
                        cluster (owner 2026-08-05: the 24h and the where-held
                        line live under the ticker now — the foot was
                        colliding with the bottom-right logo) */}
                    {(() => {
                      const rows = it.footer.breakdown
                      const asBar = !!rows && rows.length >= 2 && rows.every((r) => typeof r.share === 'number' && r.share > 0)
                      if (!rows || asBar || bH < 110) return null
                      const cap = bH >= 150 ? 3 : 2
                      return (
                        <>
                          {rows.slice(0, cap).map((row) => (
                            <span
                              key={row.label}
                              className="mb-0.5 block truncate font-mono uppercase leading-none tracking-[0.08em] text-white/75"
                              style={{ fontSize: clamp(minDim * 0.11, 8, 10) }}
                            >
                              {row.label}
                              {row.amount ? <span className="font-num tabular-nums text-white/90"> {row.amount}</span> : null}
                            </span>
                          ))}
                          {rows.length > cap && (
                            <span className="mb-0.5 block font-mono uppercase leading-none tracking-[0.08em] text-white/60" style={{ fontSize: clamp(minDim * 0.11, 8, 10) }}>
                              +{rows.length - cap} more
                            </span>
                          )}
                        </>
                      )
                    })()}
                    {/* the money scales down on a small tile but never below
                        9px — shrinking is a degradation, disappearing is a
                        different fact */}
                    {/* the HOLDING leads the stack (the owner live 2026-08-13:
                        "holding val can be bigger" + more air before the
                        price) — a step up in scale and ceiling; the price
                        below gains a beat of separation */}
                    <span className="block truncate font-num font-semibold leading-none tabular-nums text-white" style={{ fontSize: clamp(minDim * 0.08, 12, 20), ...textTrans }}>
                      {it.footer.amount}
                    </span>
                    {/* THE PER-ASSET PRICE LINE IS GONE (the owner 2026-08-18:
                        "remove the price for each asset on its bento asset
                        card as its redundant since you see the price anyways
                        when you hover" — reversing his own 2026-08-06 12:18
                        price-on-the-tile call). The hover card (expandable)
                        stays the price's one home: price + 24h + sparkline;
                        touch keeps the tap-to-unfold bar. The tile states the
                        HOLDING only — one fact, one place. */}
                  </span>
                </div>
              )}
              {compact
                ? minDim > 30 && (
                    <span
                      className="absolute left-1.5 top-1 font-display font-bold uppercase leading-none text-white/95"
                      style={{ fontSize: clamp(minDim * 0.14, 7, 11) }}
                    >
                      {it.symbol}
                    </span>
                  )
                : (showTicker || showLogoFinal) && (
                    /* pill-cornered tiles (cash) inset their overlay so the
                       ticker pill never clips the rounded corner (the owner
                       2026-08-06: "the USDC tag… needs to be moved in") —
                       the inset follows the radius, so only curved tiles pay it */
                    <div
                      className="absolute inset-0 flex flex-col justify-between"
                      style={{ padding: signal?.kind === 'cash' ? Math.max(6, Math.round(tileRadius * 0.42)) : 6 }}
                    >
                      <div className="min-w-0">
                      <div
                        className={`flex ${
                          stackPct ? 'flex-col items-start gap-0.5' : 'items-start justify-between gap-1'
                        }`}
                      >
                        {showTicker ? (
                          <span
                            className={`${
                              stackPct ? 'max-w-full' : 'max-w-[76%]'
                            } flex min-w-0 items-center gap-1 rounded-md bg-white/90 px-1.5 py-0.5 shadow-[0_2px_8px_rgba(0,0,0,0.45)]`}
                          >
                            <span
                              className="truncate font-display font-bold uppercase leading-none tracking-wide text-black"
                              style={{ fontSize: tickerFont, ...textTrans }}
                            >
                              {it.symbol}
                            </span>
                            {/* the chain's mark, in line with the type — the
                                same seat and height as the venue mark below,
                                so marked and unmarked pills stay one height */}
                            {it.chainMark && (
                              <span title={undefined} className="grid shrink-0 place-items-center">
                                <ChainLogo chainId={it.chainId} size={tickerFont} />
                              </span>
                            )}
                            {/* the badge moved OFF this white pill (owner
                                2026-08-16: "impossible to read on the white
                                card") — it renders on the tile itself, below */}
                            {/* the venue's OWN mark, IN LINE with the ticker
                                text (owner: it read as a separate chip beside
                                the pill) — same height as the type so pills
                                with and without a mark stay one height */}
                            {hasInlineMark && it.footer?.href && (
                              <a
                                href={it.footer.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                aria-label={it.footer.hrefLabel ?? `Chart for ${showSymbol(it.symbol)}`}
                                title={it.footer.hrefLabel ?? `Chart for ${showSymbol(it.symbol)}`}
                                className="press grid shrink-0 place-items-center opacity-75 transition-opacity hover:opacity-100"
                              >
                                <img src={it.footer.markSrc} alt="" className="rounded-[2px]" style={{ width: tickerFont, height: tickerFont }} />
                              </a>
                            )}
                          </span>
                        ) : (
                          <span />
                        )}
                        {/* dropPctForTicker: on a tile too small to fit the
                            name beside the % AND too short to stack them, the
                            % and its meter yield so the ticker can be read.
                            Both facts survive elsewhere — the footer states
                            the amount and the tile's own title carries the
                            percentage — so nothing is actually lost. */}
                        {showTicker && !dropPctForTicker && (
                          <span className="inline-flex items-center gap-1">
                            {/* the CAP METER — 1–3 ascending bars beside the %,
                                same ink, empty slots stay visible so one bar
                                reads as "one of three" (no meter = unranked:
                                absence is honest, a guessed bar is a claim) */}
                            {capBars != null && (
                              <span
                                aria-hidden
                                className="inline-flex items-end gap-[2px]"
                                // the thresholds teach themselves (touch
                                // round 2): the tooltip names the band
                                // DERIVED, never restated: this tooltip claimed
                                // "$1-10B" for months after the mid floor moved
                                // to $100M, and would have gone wrong again on
                                // the owner's 2026-08-06 re-calibration to 50-200M.
                                title={capMeterLabel(capBars)}
                              >
                                {([1, 2, 3] as const).map((slot) => (
                                  <span
                                    key={slot}
                                    className="w-[3px] rounded-[1px]"
                                    style={{ height: 2 + slot * 2, background: vis.ink, opacity: slot <= capBars ? 0.9 : 0.28 }}
                                  />
                                ))}
                              </span>
                            )}
                            <span
                              className="font-num font-semibold leading-none tabular-nums"
                              style={{ fontSize: weightFont, color: vis.ink, ...textTrans }}
                            >
                              {pctText}
                            </span>
                          </span>
                        )}
                      </div>
                      {/* THE NEW-VERSION BADGE, on the TILE not the pill
                          (owner 2026-08-16: teal-on-white inside the ticker
                          pill was "impossible to read") — its own dark chip
                          under the ticker, the same black-backdrop grammar
                          every colored-ground chip in the app wears, so it
                          reads on any tile color. */}
                      {it.badge && bW >= 96 && (
                        <span
                          title={it.badge.title}
                          className="mt-1 inline-flex w-fit items-center rounded-full border border-teal/60 bg-black/60 px-1.5 py-0.5 font-display text-[9px] font-bold uppercase tracking-wide text-teal backdrop-blur-sm"
                        >
                          {it.badge.label}
                        </span>
                      )}
                      {/* THE TOP CLUSTER carries only the where-held bar now
                          (the owner 2026-08-06: the % on the bento "feels very
                          messy" — price + 24h moved to the FOOTER STACK,
                          bottom-left, where the vignette gives ink real
                          ground). */}
                      {showTicker && it.footer && bH >= 72 && (() => {
                        const rows = it.footer.breakdown
                        const asBar = !!rows && rows.length >= 2 && rows.every((x) => typeof x.share === 'number' && x.share > 0)
                        const showBar = asBar && rows && bW >= 180 && bH >= 96
                        if (!showBar) return null
                        const total = rows!.reduce((t, x) => t + (x.share as number), 0)
                        const shown = rows!.slice(0, 3)
                        return (
                          <span className="mt-1.5 flex items-center gap-3">
                            {showBar && (() => {
                              const tileId = it.id ?? it.symbol
                              const isUnfolded = unfoldedIds.has(tileId)
                              const toggle = () =>
                                setUnfoldedIds((s) => {
                                  const n = new Set(s)
                                  if (n.has(tileId)) n.delete(tileId)
                                  else n.add(tileId)
                                  return n
                                })
                              return (
                                /* tap → the exact per-chain rows, tap → fold
                                   (touch round 3). stopPropagation both ways:
                                   the tile above owns click/double-click, and
                                   a fold-tap must never open the mode. */
                                <span
                                  role="button"
                                  tabIndex={0}
                                  aria-expanded={isUnfolded}
                                  aria-label={isUnfolded ? 'Fold the per-chain rows' : 'Show the exact per-chain rows'}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    toggle()
                                  }}
                                  onDoubleClick={(e) => e.stopPropagation()}
                                  onKeyDown={(e) => {
                                    if (e.key !== 'Enter' && e.key !== ' ') return
                                    e.preventDefault()
                                    e.stopPropagation()
                                    toggle()
                                  }}
                                  className="min-w-0 max-w-[280px] flex-1 cursor-pointer"
                                >
                                  {isUnfolded ? (
                                    <span className="block max-h-16 overflow-y-auto pr-1">
                                      {rows!.map((row) => (
                                        <span key={row.label} className="flex items-baseline justify-between gap-2">
                                          <span
                                            className="min-w-0 truncate font-mono uppercase leading-none tracking-[0.06em] text-white/80"
                                            style={{ fontSize: clamp(minDim * 0.12, 9, 11), textShadow: '0 1px 3px rgba(0,0,0,0.45)' }}
                                          >
                                            {row.label}
                                          </span>
                                          {row.amount && (
                                            <span
                                              className="shrink-0 font-num tabular-nums text-white"
                                              style={{ fontSize: clamp(minDim * 0.14, 10, 13), textShadow: '0 1px 3px rgba(0,0,0,0.45)' }}
                                            >
                                              {row.amount}
                                            </span>
                                          )}
                                        </span>
                                      ))}
                                    </span>
                                  ) : (
                                    <>
                                      <span className="flex h-1 w-full overflow-hidden rounded-full">
                                        {shown.map((row, i) => (
                                          <span
                                            key={row.label}
                                            className="h-full"
                                            style={{ width: `${((row.share as number) / total) * 100}%`, background: 'rgba(255,255,255,0.9)', opacity: 0.95 - i * 0.35 }}
                                          />
                                        ))}
                                      </span>
                                      <span className="mt-1 flex justify-between gap-2">
                                        {shown.map((row) => (
                                          <span
                                            key={row.label}
                                            className="min-w-0 truncate font-mono uppercase leading-none tracking-[0.06em] text-white/80"
                                            style={{ fontSize: clamp(minDim * 0.12, 9, 11), textShadow: '0 1px 3px rgba(0,0,0,0.45)' }}
                                          >
                                            {row.label}
                                            {row.amount ? (
                                              <>
                                                {' '}
                                                <CountUpUsd
                                                  usd={row.amountUsd ?? 0}
                                                  formatted={row.amount}
                                                  className="font-num normal-case tabular-nums text-white"
                                                  style={{ fontSize: clamp(minDim * 0.14, 10, 13) }}
                                                />
                                              </>
                                            ) : null}
                                          </span>
                                        ))}
                                      </span>
                                    </>
                                  )}
                                </span>
                              )
                            })()}
                          </span>
                        )
                      })()}
                      </div>
                      {showLogoFinal && (
                        <div className="mb-1 mr-1 self-end">
                          {it.logoCluster && it.logoCluster.length > 0 ? (
                            /* AN AGGREGATE WEARS EVERY FACE IT STANDS FOR: the
                               marks overlap by a third, biggest holding on top
                               and in front, so the stack reads as one object
                               while still naming its parts. Four is the cap —
                               past that the discs stop being distinguishable at
                               tile scale, and the breakdown rows already carry
                               the full list in words. */
                            <span className="flex items-center">
                              {it.logoCluster.slice(0, 4).map((c, ci) => (
                                <span
                                  key={`${c.chainId}:${c.address}:${c.symbol}`}
                                  className="block"
                                  style={{
                                    marginLeft: ci === 0 ? 0 : -Math.round(logoSize * 0.34),
                                    zIndex: it.logoCluster!.length - ci,
                                  }}
                                >
                                  <AssetLogo
                                    address={c.address}
                                    symbol={c.symbol}
                                    chainId={c.chainId}
                                    size={logoSize}
                                    discColor={`color-mix(in srgb, ${vis.color} 55%, #000)`}
                                  />
                                </span>
                              ))}
                            </span>
                          ) : (
                            <AssetLogo
                              address={it.address}
                              symbol={it.symbol}
                              chainId={it.chainId}
                              size={logoSize}
                              discColor={`color-mix(in srgb, ${vis.color} 55%, #000)`}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )}
            </div>
          </div>
        )
      })}

      {expandable && hoveredRect && hoveredItem && hoverPos && (
        <div
          key={hoveredItem.address}
          className="pointer-events-none absolute z-50"
          style={{ left: hoverPos.left, top: hoverPos.top, width: HOVER_W }}
        >
          <AssetHoverCard
            chainId={hoveredItem.chainId}
            address={hoveredItem.address}
            symbol={hoveredItem.symbol}
            /* the TRUE share when the layout weight is floored — the card
               must never repeat the geometry's white lie */
            weightPct={hoveredItem.labelPct ?? hoveredItem.weightPct}
            shareLabel={hoverShareLabel}
          />
        </div>
      )}
    </div>
  )
}

/** The class-signal KEY (owner 2026-08-05) — a caller-mounted sibling, never
 *  drawn inside the map (an overlay legend would cover tiles; a layout-
 *  changing one would surprise every existing mount). Swatches are drawn with
 *  the SAME treatments the tiles wear, so the key teaches the real grammar. */
export type LegendClass = 'basket' | 'cash' | 'stock' | 'high' | 'mid' | 'low'

/** ONE GLYPH, EVERY SURFACE (touch round 2: "list-view signal parity — both
 *  views speak one language"). The legend's swatches extracted so the list
 *  rows wear the identical drawing: basket = double border · cash = pill ·
 *  stock = sharp corners · crypto = the 1–3 bar cap meter. Unranked crypto
 *  renders NOTHING — absence is honest, a guessed bar is a claimed fact.
 *  Color rides `currentColor`, so the mount's ink decides the weight. */
export function ClassSignalGlyph({ signal, className = '' }: { signal: TileClassSignal; className?: string }) {
  if (signal.kind === 'basket')
    return (
      <span aria-hidden className={`relative inline-block h-3.5 w-5 rounded-[4px] ring-1 ring-current opacity-70 ${className}`}>
        <span className="absolute inset-1 rounded-[2px] ring-1 ring-current" />
      </span>
    )
  if (signal.kind === 'cash') return <span aria-hidden className={`inline-block h-3.5 w-5 rounded-full bg-current opacity-30 ${className}`} />
  if (signal.kind === 'stock') return <span aria-hidden className={`inline-block h-3.5 w-5 rounded-[1px] bg-current opacity-30 ${className}`} />
  if (!signal.capBars) return null
  return (
    <span aria-hidden className={`inline-flex items-end gap-[2px] ${className}`}>
      {([1, 2, 3] as const).map((slot) => (
        <span
          key={slot}
          className="w-[3px] rounded-[1px] bg-current"
          style={{ height: 2 + slot * 2, opacity: slot <= (signal.capBars as number) ? 0.9 : 0.28 }}
        />
      ))}
    </span>
  )
}

export function BentoClassLegend({
  className = '',
  onHover,
  counts,
}: {
  className?: string
  /** THE LEGEND ASKS THE PICTURE QUESTIONS (touch round, 2026-08-05): hover a
   *  key item and the caller spotlights that class in the map. Optional —
   *  without it the legend stays the static key it was. */
  onHover?: (k: LegendClass | null) => void
  /** CENSUS COUNTS (touch round 2): how many tiles of each class the picture
   *  currently shows — the key stops being grammar-only and answers "how many
   *  of these do I have?" at a glance. Counts describe the RENDERED tiles
   *  (the top-12 picture), never holdings the map didn't draw. A class at
   *  zero keeps its key item (the grammar is stable) and just shows no count. */
  counts?: Partial<Record<LegendClass, number>>
}) {
  const census = (k: LegendClass) => {
    const n = counts?.[k]
    return n != null && n > 0 ? <span className="text-ink-dim">·&nbsp;{n}</span> : null
  }
  const meter = (bars: 1 | 2 | 3) => <ClassSignalGlyph signal={{ kind: 'crypto', capBars: bars }} />
  const item = 'inline-flex items-center gap-1.5'
  const hoverable = onHover ? 'cursor-default transition-opacity hover:opacity-100' : ''
  const probe = (k: LegendClass) =>
    onHover ? { onMouseEnter: () => onHover(k), onMouseLeave: () => onHover(null), onFocus: () => onHover(k), onBlur: () => onHover(null), tabIndex: 0 } : {}
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint ${className}`}>
      <span className={`${item} ${hoverable}`} {...probe('basket')}>
        <ClassSignalGlyph signal={{ kind: 'basket' }} />
        Basket{census('basket')}
      </span>
      <span className={`${item} ${hoverable}`} {...probe('cash')}>
        <ClassSignalGlyph signal={{ kind: 'cash' }} />
        Cash{census('cash')}
      </span>
      <span className={`${item} ${hoverable}`} {...probe('stock')}>
        <ClassSignalGlyph signal={{ kind: 'stock' }} />
        Stock{census('stock')}
      </span>
      <span className={`${item} ${hoverable}`} {...probe('high')}>
        {meter(3)}
        High cap{census('high')}
      </span>
      <span className={`${item} ${hoverable}`} {...probe('mid')}>
        {meter(2)}
        Mid{census('mid')}
      </span>
      <span className={`${item} ${hoverable}`} {...probe('low')}>
        {meter(1)}
        Low{census('low')}
      </span>
    </div>
  )
}
