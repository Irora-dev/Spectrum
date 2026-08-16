import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { showName, showSymbol } from '../../lib/spectrum/safe-copy'
import { SUPPORTED_CHAIN_IDS, chainCfg } from '../../lib/chain/chains'
import { starterSuggestionsFor } from '../../lib/chain/starter-suggestions'
import { isKnownStock, stocksForChain } from '../../lib/chain/stocks'
import { mergeCrossChainHits, searchTokens, type TokenHit } from '../../lib/spectrum/token-search'
import { resolveAsset } from '../../lib/spectrum/version-seed'
import { isRetryableDetection } from '../../lib/pools'
import { useAllBaskets } from '../../lib/spectrum/hooks'
import { formatPrice, formatUsdCompact } from '../../lib/spectrum/format'
import { tokenVisual } from '../../lib/spectrum/token-meta'
import { useMinWidth } from '../../lib/motion'
import { AssetLogo } from '../AssetLogo'
import { ChainBadge, ChainLogo, chainMeta } from '../ChainBadge'
import { MIN_HIGHLIGHT_MCAP, fetchLiquidity, type LiqLite } from './PopularAssets'

// ─────────────────────────────────────────────────────────────────────────────
// THE CREATE FACE'S PICKER (owner 2026-08-12 round 2: "shouldnt we show the
// assets in that nice larger select flow where you see different assets across
// chain rather than the small little search bar with recommended tickers?") —
// the /manager choose station's selection experience, composed for the
// composer's create face:
//
//   · ONE search across EVERY network at once — the launch builder's own
//     searchTokens per chain, folded by the shared cross-chain law
//     (mergeCrossChainHits: exact match pins, verified wins its symbol, then
//     credible mcap). The winning row wears its home chain's badge; the other
//     networks that carry the ticker ride as colored dots. Picking lands the
//     asset ON THE HIT'S OWN CHAIN — never the header toggle's — which is what
//     lets a bundle compose naturally from the picker.
//   · A pasted address resolves against every network and the deepest routable
//     market wins (the flow's paste law, PortfolioFlow choose station); a
//     detection that merely FAILED stays a retry, never a verdict.
//   · Below the search, a BROWSE grid of NORMAL cards, each carrying a mini
//     BENTO TILE (the asset's colour, its ticker pill, its logo disc) beside the
//     name · 24h move · chain mark — the compact rail's own sources widened
//     across the supported chains: live-basket constituents per chain
//     (usage-ranked) backstopped by starterSuggestionsFor, re-ranked by the
//     rail's own large-cap-gainers-first law, deduped by ticker with chain dots.
//   · The grid never scrolls and never jumps while you pick (the owner: "the card
//     should always be at a fixed length"). Under `fill` it is handed the
//     viewport's leftover height and STRETCHES three rows across it (the owner
//     2026-08-13: "this whole thing should use more height whilst staying on
//     the one viewport") — the card is still a fixed length, that length is
//     just measured rather than declared. On a phone the same cards ride a
//     two-row snap RAIL instead (same ruling: "a beautiful mobile optimized
//     version with a carousel and search etc").
//
// Add-time refusal law is untouched: every tap hands (chain, address, symbol)
// to the composer's own addAssetOn → resolveAsset — the on-chain probe stays
// the eligibility authority. /compose keeps the compact rail (research face).
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

interface PickedRef {
  chainId: number
  address: string
  /** The add path resolves every pick (composer addAssetOn → resolveAsset);
   *  where the owner hands those facts down, the CHOSEN card says them. All
   *  optional — the picker never re-resolves and never invents a fact. */
  venueLabel?: string
  depthUsd?: number | null
  route?: { v3Fee: number; ethPool?: { fee: number } | null } | null
}

interface BrowseTile {
  chainId: number
  address: string
  symbol: string
  /** live-basket usage count on its home chain (0 = curated starter) */
  n: number
  /** every network whose pool carries this ticker (the dots) */
  chains: number[]
}

interface SearchRow {
  chainId: number
  address: string
  symbol: string
  name: string
  depthUsd: number
  /** networks other than the winner's that returned this ticker */
  otherChains: number[]
}

interface FoundAsset {
  chainId: number
  address: string
  symbol: string
  venueLabel: string
  depthUsd: number | null
}

const keyOf = (a: { chainId: number; address: string }) => `${a.chainId}:${a.address.toLowerCase()}`

/** True at or below the given CSS max-height, live across resizes — the
 *  vertical twin of lib/motion's useMinWidth, for the one prop CSS cannot
 *  decide here (how many browse ROWS the JS slice keeps). */
function useMaxHeight(px: number): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(`(max-height: ${px}px)`)
    const fn = () => setOn(mq.matches)
    fn()
    mq.addEventListener?.('change', fn)
    return () => mq.removeEventListener?.('change', fn)
  }, [px])
  return on
}

/** The +/✓ affordance disc — the choose station AssetCard's own. The BROWSE
 *  cards no longer wear it (the owner 2026-08-12: "remove the tick logo since the
 *  blue highlight for selected is fine"); the search hit ROWS still do, because
 *  a full-width row has the space and no coloured tile to carry the state. */
function AddDisc({ chosen }: { chosen: boolean }) {
  return (
    <span
      aria-hidden
      className={`relative grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full border font-mono text-[13px] transition-colors ${
        chosen
          ? 'border-transparent text-void'
          : 'border-white/15 text-ink-faint group-hover:border-cyan/50 group-hover:text-cyan'
      }`}
    >
      {chosen && <span aria-hidden className="absolute inset-0" style={{ background: SPECTRAL }} />}
      <span className="relative">{chosen ? '✓' : '+'}</span>
    </span>
  )
}

/** The other networks carrying a ticker, as the chains' house-color dots. */
function ChainDots({ chains }: { chains: number[] }) {
  if (chains.length === 0) return null
  return (
    <span
      className="flex items-center gap-1"
      title={`Also on ${chains.map((c) => chainMeta(c).short).join(', ')}`}
      aria-label={`Also on ${chains.map((c) => chainMeta(c).short).join(', ')}`}
    >
      {chains.map((c) => (
        <span key={c} className="h-1.5 w-1.5 rounded-full" style={{ background: chainMeta(c).color }} />
      ))}
    </span>
  )
}

/** THE BENTO ASSET TILE at chip scale — BasketBento's single-tile face lifted
 *  verbatim onto a square: the brand-color plate, the vertical light→shade
 *  block gradient, the raised inset edge (bright top / soft inner bottom), the
 *  white ticker pill and the logo disc inked from the tile's own hue. Its cyan
 *  ring is the bento's own isSelected treatment. Nothing here is invented. */
// THE PLATE IS MEASURED, NOT DECLARED, AND IT IS A PLATE — not a thumbnail
// square (the owner 2026-08-13, twice: "3 assets per row so they have more width to
// show bento with ticker and logo", then again on the 3-across grid: "again
// title and price can be moved over to right so the bento card can use more
// width"). Two changes, both aimed at the same complaint:
//   · it takes the CARD'S OWN HEIGHT — which the grid now stretches to the
//     viewport's leftover — instead of a hardcoded 56;
//   · it takes every horizontal pixel the card can spare once the figures have
//     the width they need (TEXT_MIN), so the plate reads as the card's anchor
//     and the name + price · mcap read as the caption beside it.
// A rectangle is the FAITHFUL shape, not a compromise: BasketBento's own tiles
// are squarified-treemap rectangles, and the pill/logo corners are drawn for
// exactly that. Nothing here is invented; only the box is now measured.
const PLATE_MIN = 56
/** the plate never gets so tall that the card stops being a row */
const PLATE_H_MAX = 140
/** …nor so wide that it stops being a plate and becomes a band */
const PLATE_ASPECT_MAX = 2.4
/** THE FIGURES' FLOOR — what a full "$63,409.05 · $2.87B" plus the name line
 *  needs beside the plate. The plate is what's left after this, never before
 *  it: a truncated price is not a smaller number, it is no number at all. */
const TEXT_MIN = 152
/** the card's own padding (p-1.5) and the plate↔text gap (gap-4), in px —
 *  stated once because the plate arithmetic has to subtract them */
const CARD_PAD = 6
const PLATE_GAP = 16
/** the grid's own gap (gap-1.5), which the row arithmetic has to subtract */
const GRID_GAP = 6
/** the plate the picker draws before the grid has been measured once, and the
 *  PHONE's own plate: the rail's cards are 88% of the viewport, and 80x60 is
 *  what leaves the figures their TEXT_MIN there (measured 2026-08-13 — at 96
 *  wide a micro-cap's "$0.001189 · $43.22M" clipped on a 390px screen). */
const PLATE_BASE = { w: 80, h: 60 }

function BentoChip({ t, chosen, plate }: { t: BrowseTile; chosen: boolean; plate: { w: number; h: number } }) {
  const vis = tokenVisual(t.symbol, t.address)
  // the two inhabitants scale WITH the plate — a 120px plate wearing a 22px
  // logo and an 11px pill reads as a big empty rectangle, which is the opposite
  // of what the extra size was bought for. The ticker keys off the WIDTH it now
  // has, the disc off the height. Both keep their own floors.
  const logo = Math.max(22, Math.round(plate.h * 0.4))
  const pill = plate.w >= 150 ? 15 : plate.w >= 118 ? 14 : plate.w >= 96 ? 13 : plate.w >= 80 ? 12 : 11
  return (
    <span
      aria-hidden
      className="relative block shrink-0 self-center overflow-hidden"
      style={{
        width: plate.w,
        height: plate.h,
        // the bento's house radius for a signal-less tile
        borderRadius: Math.min(plate.w, plate.h) >= 88 ? 16 : 12,
        background: vis.color,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.30), inset 0 -3px 7px rgba(0,0,0,0.22)${
          chosen ? ', 0 0 0 2px var(--color-cyan), 0 6px 20px -8px rgba(0,0,0,0.7)' : ''
        }`,
      }}
    >
      {/* the block's dimension: vertical light → shade */}
      <span
        className="absolute inset-0"
        style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.14), rgba(255,255,255,0) 34%, rgba(0,0,0,0.16))' }}
      />
      {/* the white ticker pill — the bento's label idiom, at its 11px floor */}
      <span className="absolute left-1 top-1 flex max-w-[calc(100%-0.5rem)] items-center rounded-md bg-white/90 px-1 py-px shadow-[0_2px_8px_rgba(0,0,0,0.45)]">
        <span className="truncate font-display font-bold uppercase leading-none tracking-wide text-black" style={{ fontSize: pill }}>
          {showSymbol(t.symbol)}
        </span>
      </span>
      {/* the logo disc, bottom-right — the bento's own recipe */}
      <span className="absolute bottom-1 right-1 block">
        <AssetLogo address={t.address} symbol={t.symbol} chainId={t.chainId} size={logo} discColor={`color-mix(in srgb, ${vis.color} 55%, #000)`} />
      </span>
    </span>
  )
}

/** One browsable asset — a NORMAL card that CARRIES a bento tile.
 *
 *  Owner 2026-08-12, on the bare /create grid: "the cards look ugly instead of
 *  the bg colour i meant having the bento asset on the card so showing colour,
 *  logo and ticker on it." So the brand color is confined to the chip: the CARD
 *  keeps the picker's own panel ground — the exact border/background the search
 *  hit rows below wear — and the name and the figures live in that uncolored
 *  area beside the tile. Chosen reads twice, both borrowed: the card takes the
 *  hit rows' cyan wash, the chip takes the bento's own ring.
 *
 *  THE FIGURES ARE PRICE AND MARKET CAP (the owner, same sitting: "should be price
 *  / mcap of each asset rather than 24hr %"), through the house formatters, and
 *  an unknown one prints "—" rather than a zero that reads like a fact. The +/✓
 *  is an 18px mark in the top-right corner rather than a column of its own —
 *  the width it used to eat now belongs to the tile and the figures. */
function BrowseCard({
  t,
  liq,
  chosen,
  disabled,
  index,
  plate,
  pool,
  onToggle,
}: {
  t: BrowseTile
  liq: LiqLite | undefined
  chosen: boolean
  disabled: boolean
  index: number
  /** the measured plate box — the card's own height by what it can spare */
  plate: { w: number; h: number }
  /** the CHOSEN card's pool facts (venue · fee tier · depth) from the add
   *  path's own resolution — null until the pick has resolved, and for every
   *  un-chosen card, whose face stays clean */
  pool: { line: string; title: string } | null
  onToggle: () => void
}) {
  const price = formatPrice(liq?.priceUsd ?? null)
  const mcap = liq?.marketCapUsd != null && liq.marketCapUsd > 0 ? formatUsdCompact(liq.marketCapUsd) : '—'
  // the text steps up with the plate — same reason the pill and the disc do.
  // ITS OWN THRESHOLD, 72 not the tile's 88 (the owner 2026-08-13: "a bit bigger
  // title … could use more of the card height"): at 1440x900 the fill grid's
  // rows measure ~95px — plate 83 — and the type must step up THERE, where
  // the height it was asked to spend actually is. The phone rail's 60px base
  // plate keeps the base step; the pill and disc keep their own boundaries.
  const big = plate.h >= 72
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled && !chosen}
      aria-pressed={chosen}
      aria-label={chosen ? `Remove ${showSymbol(t.symbol)} from your mix` : `Add ${showSymbol(t.symbol)} to your mix`}
      className={`press enter group relative flex h-full w-full items-center gap-4 overflow-hidden rounded-xl border p-1.5 text-left transition-all duration-300 hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 ${
        // THE HIGHLIGHT IS THE WHOLE ANSWER now the tick is gone: a cyan edge,
        // a lifted ground and a soft glow, plus the tile's own bento ring —
        // three signals on one card, none of them a glyph in a corner.
        chosen
          ? 'border-cyan/60 bg-cyan/[0.10] shadow-[0_0_18px_-6px_var(--color-cyan)]'
          : 'border-white/10 bg-white/[0.02] hover:border-white/25'
      }`}
      style={
        {
          transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)',
          '--enter-i': Math.min(index, 12),
        } as CSSProperties
      }
    >
      <BentoChip t={t} chosen={chosen} plate={plate} />
      {/* the card's own uncolored area — what the tile cannot say. The chain
          marks ride the NAME line and the figures get the row to themselves:
          sharing one line, the badge squeezed "$2,135.20 · $350.71M" down to
          "$2,…" at four columns (measured 2026-08-12), and a truncated price is
          not a smaller number, it is no number at all. THREE COLUMNS (the owner
          2026-08-13) hand this area ~160px instead of ~139 — the figures gained
          the room the fourth column was eating.

          THE COLUMN SPENDS THE CARD'S HEIGHT (the owner 2026-08-13, on the live
          grid: "this info the title and price mcap could use more of the card
          height and a bit bigger title") — the title takes a full type step
          (13→15 bold on tall cards, 12→13 semibold on the base card), the
          figures a half-step (12→13 / 11→12), and the stack stays centered
          against the tile with real gap instead of a cramped mt-1. Taller TEXT
          in the same card — the three-rows-one-viewport law is untouched. The
          title truncates before a NUMBER ever does: names are decorative,
          figures are facts. */}
      <span className={`flex min-w-0 flex-1 flex-col justify-center self-stretch ${big ? 'gap-2' : 'gap-1'}`}>
        <span className="flex items-center gap-1.5">
          <span className={`min-w-0 flex-1 truncate font-display text-ink ${big ? 'text-[15px] font-bold' : 'text-[13px] font-semibold'}`}>
            {liq?.name ? showName(liq.name) : showSymbol(t.symbol)}
          </span>
          {/* THE CHAIN AS ITS MARK, not its letters (the owner 2026-08-12: "the
              eth/base/rh can be just the logo to give more space") — the app's
              own ChainLogo, the same drawing ChainBadge's logo size wears, with
              the network's name on title/aria so nothing is lost to a reader */}
          <span title={chainCfg(t.chainId).name} aria-label={chainCfg(t.chainId).name} className="grid shrink-0 place-items-center">
            <ChainLogo chainId={t.chainId} size={big ? 16 : 14} />
          </span>
          <ChainDots chains={t.chains.filter((c) => c !== t.chainId)} />
        </span>
        <span
          className={`block truncate font-num tabular-nums text-ink-dim ${big ? 'text-[13px]' : 'text-[12px]'}`}
          title={`${price} · ${mcap} market cap`}
        >
          <span className="font-semibold text-ink">{price}</span> · {mcap}
        </span>
        {/* THE POOL LINE (the owner 2026-08-13: "take V3 · 0.3% fee and surface it
            … on the main card when its highlighted") — the route the add
            actually resolved, said on the chosen card's own face. No inspect
            step, no extra control: the highlight is where the fact appears. */}
        {pool && (
          <span className="block truncate font-mono text-[10px] uppercase text-cyan/90" title={pool.title}>
            {pool.line}
          </span>
        )}
      </span>
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TOKENIZED STOCKS (the owner 2026-08-13: "for stocks on robinhood there needs to
// be an easier way to search/find them on create and see they're the correct
// weth/stock pools").
//
// FINDING THEM. The registry already existed — lib/chain/stocks' official
// listing, captured from docs.robinhood.com/chain/contracts because impostor
// tokens with the same names exist. What did not exist was a way to BROWSE it
// here: the picker's pool is live-basket constituents plus starter suggestions,
// and a stock only appeared if it happened to rank. So the header gets a LENS —
// one chip that swaps the grid to the registry — and the search gets the
// registry as a rung of its own, so "NVDA", "nvidia" or "apple" surface the
// canonical token even when the chain's explorer index does not return it.
//
// PROVING IT. A tokenized stock is precisely the shape a scam token imitates:
// same ticker, same name, different address (this lane has an incident on
// record — a symbol-fold with no address check let a scam token wear the real
// tile). The proof rides the PICK itself (the owner 2026-08-13, killing this
// round's first cut, a per-card ⓘ inspector: "why is there an i button on the
// add asset? that's pointless. we could just take V3 · 0.3% fee and surface it
// when you do click and add an asset to the basket and we surface it on the
// main card when its highlighted"). So there is NO inspect step anywhere:
// selecting a card IS the add, the add path resolves the route (composer
// addAssetOn → resolveAsset — the same one the deploy carries), and the
// resolved facts ride the picked ref back down. The HIGHLIGHTED card grows a
// pool line (venue · fee tier · routable depth), the picked rail and the shape
// rows wear the same venue words (Composer's VenueChip), and the shape row
// links the token's own address to its chain's explorer.
//
// THE MARK MEANS ONE THING. "RH registry" is shown only where isKnownStock
// says the ADDRESS is on the official listing, and it claims nothing beyond
// it — not that the pool is deep, not that the price is right, not that the
// issuer is solvent. Everything else shown is a fact with a source (the route
// the add actually resolved). No badge is invented.
// ─────────────────────────────────────────────────────────────────────────────

/** The whole registry as browse tiles — every chain that ships stocks. */
function stockTilesFor(): BrowseTile[] {
  return SUPPORTED_CHAIN_IDS.flatMap((chainId) =>
    stocksForChain(chainId).map((st) => ({ chainId, address: st.address, symbol: st.symbol, n: 0, chains: [chainId] })),
  )
}

/** Registry rows matching a typed query — ticker OR company name, so "nvidia"
 *  and "apple" work as well as "NVDA". Never a fuzzy guess: substring only. */
function stockMatches(needle: string): SearchRow[] {
  const q = needle.trim().toLowerCase()
  if (q.length < 1) return []
  return SUPPORTED_CHAIN_IDS.flatMap((chainId) =>
    stocksForChain(chainId)
      .filter((st) => st.symbol.toLowerCase().includes(q) || st.name.toLowerCase().includes(q))
      .map((st) => ({ chainId, address: st.address, symbol: st.symbol, name: st.name, depthUsd: 0, otherChains: [] })),
  )
}

/** The fee a route STATES, as a percent — V3 carries its tier, V4 its pool
 *  key's. Null where the struct says nothing (a V2 pair's fee lives outside
 *  it) and where V4's dynamic-fee flag makes the number a sentinel — never a
 *  guess. Exported so the composer's venue chips say the same fee. */
export function routeFeePct(route: { v3Fee: number; ethPool?: { fee: number } | null } | null | undefined): number | null {
  if (!route) return null
  const raw = route.v3Fee || route.ethPool?.fee || 0
  return raw > 0 && raw <= 100_000 ? raw / 10_000 : null
}

/** The chosen card's pool line — "V3 · 0.3% · $57K pool" — built ONLY from
 *  the add path's own resolution riding the picked ref. Sized for the fill
 *  grid's 152px text column (worst honest case "V3 · 0.05% · $999.9M pool"
 *  ≈ 150px at 10px mono); the registry fact goes to the title, where the
 *  words can afford to say exactly what it means. No fact, no line. */
function poolFactsFor(p: PickedRef | undefined): { line: string; title: string } | null {
  if (!p?.venueLabel) return null
  const venue = p.venueLabel.replace('Uniswap ', '').trim()
  if (!venue) return null
  const fee = routeFeePct(p.route)
  const depth = p.depthUsd != null && p.depthUsd > 0 ? formatUsdCompact(p.depthUsd) : null
  const line = [fee != null ? `${venue} · ${fee}%` : venue, depth ? `${depth} pool` : null].filter(Boolean).join(' · ')
  const title =
    `Routes through ${p.venueLabel}` +
    (fee != null ? ` at the ${fee}% fee tier` : '') +
    (depth ? ` · ${depth} routable depth` : '') +
    (isKnownStock(p.chainId, p.address)
      ? '. This address is on the official Robinhood stock registry (docs.robinhood.com/chain/contracts) — that mark means list membership, nothing more.'
      : '.')
  return { line, title }
}

export function CreateAssetPicker({
  picked,
  full,
  busy,
  onPick,
  onRemove,
  searchOnly = false,
  fill = false,
}: {
  /** the composer's current picks — chosen tiles render selected */
  picked: readonly PickedRef[]
  /** the mix is at MAX_ASSETS — every un-chosen tile disables */
  full: boolean
  /** a resolve is in flight — taps disable rather than queue */
  busy: boolean
  /** hands the pick to the composer's own add flow (its refusal law) — the
   *  chainId is the HIT'S, never the header toggle's */
  onPick: (chainId: number, address: string, symbol?: string) => void
  /** tap-to-toggle (owner addendum #5): tapping a CHOSEN tile removes the
   *  pick again — the composer owns the removal (weights relaw there) */
  onRemove?: (chainId: number, address: string) => void
  /** The shape page's add bar (staged create, owner 2026-08-12): just the
   *  cross-chain search — no browse grid, no label until results show. */
  searchOnly?: boolean
  /** THE PICKER FILLS ITS BOX (owner 2026-08-13: "this whole thing should use
   *  more height whilst staying on the one viewport"). On the choose page the
   *  picker is handed a measured height and lays itself out as a column —
   *  search fixed, grid flex-1 — so three rows SPEND the viewport instead of
   *  squeezing under it. Off (the shape page's add bar) it flows as before. */
  fill?: boolean
}) {
  // THREE VISIBLE ROWS, NO SCROLLING (the owner 2026-08-12: "this needs to be
  // visible three rows no scrolling") — the browse cap is column-aware
  // (3 × the live column count) so the grid always lands exactly three full
  // rows, never a clipped fourth peeking. A JS slice, not a CSS max-h crop:
  // the cut drops whole tail tiles instead of half-rendering one. The search
  // bar above is the show-more — no affordance. On SHORT viewports the grid
  // drops to two rows instead of letting page one grow past the viewport
  // (the one-page-never-scrolls law, same ruling).
  const sm = useMinWidth(640)
  const lg = useMinWidth(1024)
  const xl = useMinWidth(1280)
  // 720: at ~710px of real inner height (an 800px window under browser
  // chrome) three rows push the choose page's Continue below the fold; two
  // rows plus no label line keep every control visible. Measured live
  // against the page's own anatomy, 2026-08-12.
  const shortViewport = useMaxHeight(720)
  // COLUMN COUNTS ARE SET BY WHAT THE FIGURES NEED, not by how many tiles fit.
  // The price·mcap line must never ellipsis (owner 2026-08-12: it is the reason
  // the card exists), and a full "$63,409.05 · $2.87B" needs ~116px beside the
  // tile. Measured: four columns at lg/xl left 139px, two at sm leave 202.
  //
  // THREE at the top now, not four (the owner 2026-08-13: "i think have 3 assets
  // per row so they have more width to show bento with ticker and logo") — each
  // card grows from ~219px to ~300px, the tile takes the row's own height
  // instead of a hardcoded 56, and the text column goes from 139px to ~160.
  // Three visible rows is unchanged as a law; three columns simply makes a page
  // NINE tiles instead of twelve, and the pager below counts that honestly.
  const cols = lg || xl ? 3 : sm ? 2 : 1
  const phone = !sm
  // A PHONE IS NOT A NARROW DESKTOP (the owner 2026-08-13: "ensure mobile has a
  // beautiful mobile optimized version with a carousel and search etc") — the
  // suggestions become a two-row snap RAIL you swipe, so a phone page shows a
  // deep slice at a readable size instead of three lonely stacked cards. The
  // arrows still page the pool beyond the rail's own slice.
  const rows = phone ? 2 : shortViewport ? 2 : 3
  // the rail carries more than it shows — swiping is the pager inside a page
  const PHONE_RAIL = 12
  // FILL IS A DESKTOP/TABLET POSTURE. A phone's page-one is taller than its
  // viewport by nature (masthead, footer, the shell's own tab bar), so the
  // phone face flows and docks its CTA instead of pretending to a height it
  // does not have — see the Composer's choose page.
  const filling = fill && !phone
  // THE SEARCH TAKES FOCUS ON ARRIVAL (owner 2026-08-12) — but only on the
  // browse face and only off phones: autofocus on a phone throws the keyboard
  // up over the very grid the page exists to show, which is the opposite of
  // helping. The add bar on page two must not steal focus from the weights.
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (searchOnly || phone) return
    inputRef.current?.focus({ preventScroll: true })
  }, [searchOnly, phone])
  const { data: allBaskets } = useAllBaskets()
  // one map, two reads: membership (the highlight) and the resolved facts the
  // chosen card's pool line says (venueLabel/route/depth ride the picked ref)
  const pickedByKey = useMemo(() => new Map(picked.map((p) => [keyOf(p), p] as const)), [picked])
  const pickedKeys = useMemo(() => new Set(pickedByKey.keys()), [pickedByKey])

  // THE LENS (the owner 2026-08-13) — one chip, one swap of the pool. It only
  // exists where the shipped chains actually list stocks, so a build without
  // them never grows a control with nothing behind it.
  const [lens, setLens] = useState<'all' | 'stocks'>('all')
  const stockPool = useMemo(() => stockTilesFor(), [])

  // ── the browse pool: the compact rail's recipe, run across EVERY chain ────
  const browseAll = useMemo<BrowseTile[]>(() => {
    const rows: (Omit<BrowseTile, 'chains'> & { chains?: number[] })[] = []
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      const cfg = chainCfg(chainId)
      const usdc = cfg.usdc?.toLowerCase()
      const weth = cfg.weth?.toLowerCase()
      const freq = new Map<string, { address: string; symbol: string; n: number }>()
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
      // 24, not 12: the arrows page THROUGH this pool (owner 2026-08-12), so it
      // has to be deeper than one screen — still under fetchLiquidity's own
      // 30-address batch ceiling, so the market read stays one call per chain.
      rows.push(...[...organic, ...starters].slice(0, 24).map((s) => ({ ...s, chainId })))
    }
    // fold by TICKER: one canonical face per symbol — the most-used chain wins
    // the tile, every network carrying it rides as dots
    const bySym = new Map<string, BrowseTile>()
    for (const r of rows) {
      const k = r.symbol.toUpperCase()
      const prev = bySym.get(k)
      if (!prev) {
        bySym.set(k, { chainId: r.chainId, address: r.address, symbol: r.symbol, n: r.n, chains: [r.chainId] })
      } else {
        if (!prev.chains.includes(r.chainId)) prev.chains.push(r.chainId)
        if (r.n > prev.n) {
          prev.chainId = r.chainId
          prev.address = r.address
          prev.symbol = r.symbol
          prev.n = r.n
        }
      }
    }
    return [...bySym.values()].sort((a, b) => b.n - a.n).slice(0, 60)
  }, [allBaskets])
  // the lens swaps the POOL, and everything downstream — the price read, the
  // ranking, the pager — runs on whichever pool is showing, unchanged
  const browse = lens === 'stocks' ? stockPool : browseAll

  // price · mcap · name per tile — the rail's own batch read, one call per chain
  const [liq, setLiq] = useState<Map<string, LiqLite>>(new Map())
  const browseKey = browse.map(keyOf).join(',')
  useEffect(() => {
    if (browse.length === 0) return
    let alive = true
    Promise.all(
      SUPPORTED_CHAIN_IDS.map(async (chainId) => {
        const addrs = browse.filter((b) => b.chainId === chainId).map((b) => b.address)
        if (addrs.length === 0) return [] as [string, LiqLite][]
        const m = await fetchLiquidity(addrs, chainId)
        return [...m.entries()].map(([a, l]) => [`${chainId}:${a}`, l] as [string, LiqLite])
      }),
    ).then((all) => {
      if (alive) setLiq(new Map(all.flat()))
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseKey])

  // the rail's ranking law, verbatim: large-cap gainers float, then 24h change
  // desc, unknown change trails (usage order break ties — the sort is stable)
  const rankedBrowse = useMemo(() => {
    // the REGISTRY keeps its own order — a curated shelf is a list someone
    // wrote, and re-sorting it by 24h move would make it look like a leaderboard
    if (lens === 'stocks') return browse
    const rows = browse.map((t) => {
      const l = liq.get(keyOf(t))
      return { t, marketCapUsd: l?.marketCapUsd ?? null, change: l?.priceChangeH24 ?? null }
    })
    const isBigGainer = (x: (typeof rows)[number]) =>
      x.marketCapUsd != null && x.marketCapUsd >= MIN_HIGHLIGHT_MCAP && (x.change ?? 0) > 0
    return rows
      .sort((a, b) => {
        const ga = isBigGainer(a)
        const gb = isBigGainer(b)
        if (ga !== gb) return ga ? -1 : 1
        if (a.change != null && b.change != null) return b.change - a.change
        if (a.change != null) return -1
        if (b.change != null) return 1
        return 0
      })
      .map((x) => x.t)
  }, [browse, liq, lens])

  // ── PAGING (owner 2026-08-12: "make arrows in top right") ─────────────────
  // The arrows turn a PAGE of the pool rather than growing the grid or letting
  // it scroll — three rows stay three rows, page one stays inside one viewport,
  // and the deeper pool above is what there now is to turn to. The page resets
  // whenever the page SIZE changes (a resize crossing a breakpoint), because a
  // page index means nothing once the shape it indexed is gone.
  const perPage = phone ? PHONE_RAIL : cols * rows
  const [page, setPage] = useState(0)
  useEffect(() => {
    setPage(0)
  }, [perPage])
  const pageCount = Math.max(1, Math.ceil(rankedBrowse.length / perPage))
  const safePage = Math.min(page, pageCount - 1)
  const pageTiles = rankedBrowse.slice(safePage * perPage, safePage * perPage + perPage)
  // a turned page starts at ITS beginning: the rail keeps its scroll position
  // across a re-render, so page 2 would otherwise open halfway through itself
  const railRef = useRef<HTMLDivElement>(null)
  const turn = (dir: 1 | -1) => {
    setPage((p) => (Math.min(p, pageCount - 1) + dir + pageCount) % pageCount)
    railRef.current?.scrollTo({ left: 0, behavior: 'smooth' })
  }


  // ── search: every network at once, folded by the shared cross-chain law ───
  const [q, setQ] = useState('')
  const needle = q.trim()
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(needle)
  const [hits, setHits] = useState<SearchRow[]>([])
  const [searching, setSearching] = useState(false)
  // could-not-read ≠ empty (the flow's pattern): every chain failing gets its
  // own face — a false negative tells a creator their asset does not exist
  const [unreachable, setUnreachable] = useState(false)
  useEffect(() => {
    if (isAddr || needle.length < 2) {
      setHits([])
      setSearching(false)
      setUnreachable(false)
      return
    }
    let stale = false
    setSearching(true)
    setUnreachable(false)
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
          setUnreachable(all.every((r) => r === null))
          const flat = all.filter((r) => r !== null).flat()
          // which networks carry each ticker — the dots beside the winning row
          const chainsOf = new Map<string, Set<number>>()
          for (const { h, chainId } of flat) {
            const k = h.symbol.toUpperCase()
            let set = chainsOf.get(k)
            if (!set) {
              set = new Set()
              chainsOf.set(k, set)
            }
            set.add(chainId)
          }
          const merged = mergeCrossChainHits(flat, needle, 12).map(({ h, chainId }) => ({
            chainId,
            address: h.address,
            symbol: h.symbol,
            name: h.name,
            depthUsd: h.liquidityUsd,
            otherChains: [...(chainsOf.get(h.symbol.toUpperCase()) ?? [])].filter((c) => c !== chainId),
          }))
          // THE REGISTRY IS A RUNG OF ITS OWN (the owner 2026-08-13: stocks must be
          // easy to FIND). The cross-chain search leans on DexScreener and, off
          // it, on the chain explorer's index — neither is guaranteed to return
          // a tokenized stock for "nvidia", and the one address that is
          // certainly right is the one the app already ships. So registry
          // matches are prepended by ADDRESS identity, and a hit the search
          // also found is dropped rather than shown twice.
          const registry = stockMatches(needle)
          const registryKeys = new Set(registry.map(keyOf))
          setHits([...registry, ...merged.filter((h) => !registryKeys.has(keyOf(h)))])
        })
        .finally(() => {
          if (!stale) setSearching(false)
        })
    }, 300)
    return () => {
      stale = true
      window.clearTimeout(t)
    }
  }, [needle, isAddr])

  // ── paste an address: resolve on every network, deepest routable wins ─────
  const [found, setFound] = useState<FoundAsset | null>(null)
  const [findBusy, setFindBusy] = useState(false)
  const [findError, setFindError] = useState<string | null>(null)
  useEffect(() => {
    if (!isAddr) {
      setFound(null)
      setFindError(null)
      setFindBusy(false)
      return
    }
    let stale = false
    setFindBusy(true)
    setFindError(null)
    Promise.all(
      SUPPORTED_CHAIN_IDS.map((chainId) =>
        resolveAsset(needle, chainId)
          .then((a) => ({ chainId, a }))
          .catch((e: unknown) => ({ chainId, err: e })),
      ),
    )
      .then((results) => {
        if (stale) return
        const ok = results.filter((r): r is { chainId: number; a: Awaited<ReturnType<typeof resolveAsset>> } => 'a' in r)
        if (ok.length > 0) {
          const best = ok.reduce((x, y) => ((y.a.depthUsd ?? 0) > (x.a.depthUsd ?? 0) ? y : x))
          setFound({
            chainId: best.chainId,
            address: best.a.address,
            symbol: best.a.symbol,
            venueLabel: best.a.venueLabel,
            depthUsd: best.a.depthUsd,
          })
          return
        }
        // a detection that merely FAILED is a retry, never a verdict
        const allRetryable = results.every((r) => 'err' in r && isRetryableDetection(r.err))
        setFound(null)
        setFindError(allRetryable ? 'Couldn’t check this asset right now; try again.' : 'No routable market found for this asset.')
      })
      .finally(() => {
        if (!stale) setFindBusy(false)
      })
    return () => {
      stale = true
    }
  }, [needle, isAddr])

  const commit = (chainId: number, address: string, symbol?: string) => {
    if (busy || pickedKeys.has(keyOf({ chainId, address }))) return
    onPick(chainId, address, symbol)
    setQ('')
  }

  /** tap-to-toggle (addendum #5): a chosen tile removes, the rest add. */
  const toggle = (chainId: number, address: string, symbol?: string) => {
    if (busy) return
    if (pickedKeys.has(keyOf({ chainId, address }))) onRemove?.(chainId, address)
    else commit(chainId, address, symbol)
  }

  const showingSearch = needle.length >= 2
  // the arrows belong to the BROWSE grid; a search is its own result set
  const showArrows = !showingSearch && pageCount > 1

  // ── THE TILE IS WHAT A ROW TURNED OUT TO BE ───────────────────────────────
  // The grid is handed the viewport's leftover height (fill), so a row's height
  // is a measured fact, not a constant — and the bento plate takes it, bounded.
  // One ResizeObserver on the grid box; nothing is hardcoded here but the two
  // bounds, the card's own padding, and the 8px gap the grid is drawn with.
  const gridRef = useRef<HTMLDivElement>(null)
  const [gridBox, setGridBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const read = () => {
      const r = el.getBoundingClientRect()
      setGridBox((prev) => (Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5 ? prev : { w: r.width, h: r.height }))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [showingSearch, filling])
  const plate = (() => {
    if (!filling || gridBox.h <= 0) return PLATE_BASE
    const rowH = (gridBox.h - GRID_GAP * (rows - 1)) / rows
    const cardW = (gridBox.w - GRID_GAP * (cols - 1)) / cols
    const innerW = cardW - CARD_PAD * 2
    // WIDTH FIRST: every horizontal pixel left after the figures have their
    // floor. This is the binding constraint at every viewport the kit sees.
    const wBudget = innerW - PLATE_GAP - TEXT_MIN
    // HEIGHT: the card's own, which the grid stretches — capped so a very tall
    // viewport does not draw a column, but the cap RISES with the width the
    // plate got, so a 1200px viewport fills its card instead of leaving a 55px
    // band of air inside it (measured 2026-08-13: 195px rows, 140px plate).
    const h = Math.max(40, Math.min(rowH - CARD_PAD * 2, Math.max(PLATE_H_MAX, wBudget * 1.4)))
    // …and the width, bounded so a short row cannot stretch it into a band
    const w = Math.max(PLATE_MIN, Math.min(wBudget, h * PLATE_ASPECT_MAX))
    return { w: Math.round(w), h: Math.round(h) }
  })()
  const hasChange = rankedBrowse.some((t) => (liq.get(keyOf(t))?.priceChangeH24 ?? null) != null)
  const label = showingSearch
    ? 'Results · every network'
    : lens === 'stocks'
      ? 'Tokenized stocks'
      : hasChange
        ? 'Trending across networks'
        : 'Tokens to start from'

  return (
    <div className={filling ? 'flex h-full min-h-0 flex-col' : undefined}>
      {/* the choose station's own search bar — one field, every network. It is
          the column's FIXED head: it keeps its size at every viewport height,
          and the grid below is what spends what's left (owner 2026-08-13). */}
      <div className="relative shrink-0">
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && q.trim().length > 0) {
              e.stopPropagation()
              setQ('')
            }
            // ENTER ADDS THE PASTED ADDRESS (owner 2026-08-12): pasting a
            // contract and reaching for the mouse is a step the keyboard
            // already answered. Only ever fires on a RESOLVED address — the
            // add-time refusal law is untouched, this is just the Add button.
            if (e.key === 'Enter' && isAddr) {
              e.preventDefault()
              if (found && !busy && !full && !pickedKeys.has(keyOf(found))) commit(found.chainId, found.address, found.symbol)
            }
          }}
          placeholder={phone ? 'Ticker or address' : 'Search any asset on any network · AAVE, NVDA… or paste an address'}
          aria-label="Search assets across networks"
          spellCheck={false}
          className="h-12 w-full rounded-full border border-white/12 bg-white/[0.03] pl-12 pr-5 font-mono text-[13px] text-ink outline-none transition-all placeholder:text-ink-faint focus:border-cyan/50 focus:shadow-[0_0_24px_rgba(53,224,255,0.2)]"
        />
      </div>

      {(!searchOnly || showingSearch) && (
      <div className={`border-t border-white/8 ${filling ? 'mt-2.5 flex min-h-0 flex-1 flex-col pt-2.5' : 'mt-3 pt-3'}`}>
        {/* the label line yields its height on short viewports while browsing
            (the one-page law) — search states keep it, they name the results.
            THE ARROWS survive that yield: they're a control, not a caption, and
            the header row holds them at its top-right (the trending rail's own
            ‹ › idiom, PopularAssets — same disc, same stroke, same hover). */}
        {/* the stocks lens keeps the header ALIVE on short viewports: the row
            holds the only way back to All — a yielded header must never
            strand the lens (the chips are the escape as well as the entry) */}
        {(showingSearch || !shortViewport || showArrows || lens === 'stocks') && (
        <div className="mb-1.5 flex shrink-0 items-center justify-between gap-2">
          {showingSearch || !shortViewport ? (
            <div className="flex min-w-0 items-center gap-2 font-mono text-xs uppercase tracking-wide text-ink-dim">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan" />
              <span className="truncate">{label}</span>
              {/* the shelf says what it is, once — the registry's own standing
                  caveat, lifted verbatim from the launch bar's stock strip */}
              {lens === 'stocks' && !showingSearch && (
                <span className="hidden shrink-0 font-mono text-[9px] normal-case tracking-normal text-ink-faint lg:inline">
                  issuer-backed tracking tokens · pools trade 24/7, markets do not
                </span>
              )}
            </div>
          ) : (
            <span />
          )}
          {/* THE LENS — only where the shipped chains actually list stocks */}
          {!showingSearch && stockPool.length > 0 && (
            <div className="ml-auto mr-1 flex shrink-0 items-center gap-1">
              {(['all', 'stocks'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={lens === k}
                  onClick={() => setLens(k)}
                  className={`press inline-flex min-h-[36px] items-center rounded-full border px-3 font-mono text-[10px] uppercase tracking-[0.12em] sm:min-h-[28px] ${
                    lens === k ? 'border-cyan/50 bg-cyan/[0.08] text-cyan' : 'border-white/12 text-ink-dim hover:border-white/30'
                  }`}
                >
                  {k === 'all' ? 'All' : 'Stocks'}
                </button>
              ))}
            </div>
          )}
          {showArrows && (
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] tabular-nums text-ink-faint">
                {safePage + 1}/{pageCount}
              </span>
              <button
                type="button"
                onClick={() => turn(-1)}
                aria-label="Previous suggestions"
                className="press grid h-9 w-9 place-items-center rounded-full border border-white/12 text-ink-dim hover:border-cyan/60 hover:text-cyan sm:h-7 sm:w-7"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => turn(1)}
                aria-label="More suggestions"
                className="press grid h-9 w-9 place-items-center rounded-full border border-white/12 text-ink-dim hover:border-cyan/60 hover:text-cyan sm:h-7 sm:w-7"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </div>
          )}
        </div>
        )}

        {/* SEARCH states keep the choose station's scroll box (hits can run
            long) — under `fill` that box is simply the column's leftover
            height. The BROWSE grid renders free: exactly three rows, no
            scrolling (the addendum-2 law above), now STRETCHED to fill. */}
        <div
          className={
            showingSearch
              ? filling
                ? 'scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 pt-1'
                : 'scrollbar-none h-[336px] overflow-y-auto overscroll-contain pr-1 pt-1 sm:h-[264px]'
              : filling
                ? 'flex min-h-0 flex-1 flex-col pt-1'
                : 'pt-1'
          }
        >
          {(searching || findBusy) && (
            <p className="mb-3 flex items-center gap-2 font-mono text-[11px] text-ink-faint">
              <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-cyan shadow-[0_0_10px_var(--color-cyan)]" />
              Checking markets…
            </p>
          )}
          {findError && isAddr && (
            <p className="mb-3 rounded-xl border border-magenta/30 bg-magenta/[0.06] p-3 font-mono text-[11px] text-ink-dim">{findError}</p>
          )}

          {/* a pasted address, resolved — deepest routable market across chains */}
          {found && isAddr && (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-cyan/40 bg-cyan/[0.06] p-4">
              <div className="flex items-center gap-3">
                <AssetLogo address={found.address} symbol={found.symbol} chainId={found.chainId} size={32} />
                <div>
                  <div className="flex items-center gap-2 font-display text-lg font-bold text-ink">
                    ${showSymbol(found.symbol)}
                    <ChainBadge chainId={found.chainId} />
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-ink-dim">
                    {found.venueLabel}
                    {found.depthUsd != null && found.depthUsd > 0 ? ` · ${formatUsdCompact(found.depthUsd)} routable` : ''}
                  </div>
                </div>
              </div>
              <button
                type="button"
                disabled={busy || full || pickedKeys.has(keyOf(found))}
                onClick={() => commit(found.chainId, found.address, found.symbol)}
                className="press h-10 shrink-0 rounded-full border border-cyan/50 bg-cyan/15 px-5 font-mono text-[11px] uppercase tracking-wide text-cyan hover:border-cyan disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pickedKeys.has(keyOf(found)) ? 'Added ✓' : 'Add'}
              </button>
            </div>
          )}

          {/* search hits — the winning chain wears the badge, the rest are dots */}
          {showingSearch && !isAddr && (
            <div className="grid content-start gap-2 sm:grid-cols-2">
              {hits.map((h) => {
                const chosen = pickedKeys.has(keyOf(h))
                const pool = chosen ? poolFactsFor(pickedByKey.get(keyOf(h))) : null
                // the impostor check belongs HERE above all: a search result is
                // where a scam token wearing a real ticker meets you. The mark
                // is words with one meaning — this ADDRESS is on the official
                // list — and it rides the row itself, no extra step.
                const registry = isKnownStock(h.chainId, h.address)
                return (
                  <button
                    key={keyOf(h)}
                    type="button"
                    disabled={busy || (full && !chosen)}
                    aria-pressed={chosen}
                    onClick={() => toggle(h.chainId, h.address, h.symbol)}
                    className={`press group flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      chosen ? 'border-cyan/50 bg-cyan/[0.08]' : 'border-white/10 bg-white/[0.02] hover:border-white/25'
                    }`}
                  >
                    <AssetLogo address={h.address} symbol={h.symbol} chainId={h.chainId} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-display text-sm font-bold text-ink">${showSymbol(h.symbol)}</span>
                        <ChainBadge chainId={h.chainId} />
                        <ChainDots chains={h.otherChains} />
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-ink-faint">
                        {showName(h.name)}
                        {registry && (
                          <span
                            className="text-teal"
                            title="This address is on the official Robinhood stock registry (docs.robinhood.com/chain/contracts) — list membership, nothing more."
                          >
                            {' · RH registry'}
                          </span>
                        )}
                        {/* chosen rows say the RESOLVED route (the add path's
                            own read) in place of the search index's depth */}
                        {pool ? ` · ${pool.line}` : h.depthUsd > 0 ? ` · ${formatUsdCompact(h.depthUsd)} routable` : ''}
                      </span>
                    </span>
                    <AddDisc chosen={chosen} />
                  </button>
                )
              })}
              {hits.length === 0 && !searching && (
                <p className="col-span-full py-6 font-mono text-[11px] text-ink-faint">
                  {unreachable
                    ? 'The search couldn’t reach any network just now — try again in a moment.'
                    : `Nothing matches “${needle}”. Paste its contract address and we’ll find its market.`}
                </p>
              )}
            </div>
          )}

          {/* THE BROWSE SURFACE — one card component, two shapes.
              · phone: a two-row SNAP RAIL you swipe (the owner 2026-08-13) — the
                kit's own carousel idiom, lifted from the explore/thesis bands
                (`-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4`),
                bled to the card's edges so a card is visibly cut off and the
                rail reads as swipeable. The RAIL scrolls; the page never does.
              · sm and up: the grid. Three columns at lg (the owner 2026-08-13),
                stretched over the column's leftover height under `fill`, so
                three rows spend the viewport instead of squeezing under it. */}
          {!showingSearch &&
            (phone ? (
              <div
                ref={railRef}
                className="scrollbar-none -mx-4 grid snap-x snap-mandatory auto-cols-[88%] grid-flow-col grid-rows-2 gap-3 overflow-x-auto overscroll-x-contain scroll-pl-4 px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {pageTiles.map((t, i) => (
                  <div key={keyOf(t)} className="snap-start">
                    <BrowseCard
                      t={t}
                      liq={liq.get(keyOf(t))}
                      chosen={pickedKeys.has(keyOf(t))}
                      disabled={busy || full}
                      index={i}
                      plate={plate}
                      pool={poolFactsFor(pickedByKey.get(keyOf(t)))}
                      onToggle={() => toggle(t.chainId, t.address, t.symbol)}
                    />
                  </div>
                ))}
                {rankedBrowse.length === 0 && (
                  <p className="py-6 font-mono text-[11px] text-ink-faint">
                    Type a ticker above — the search asks every network at once.
                  </p>
                )}
              </div>
            ) : (
              <div
                ref={gridRef}
                className={`grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3 ${filling ? 'min-h-0 flex-1' : 'content-start'}`}
                style={filling ? { gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` } : undefined}
              >
                {pageTiles.map((t, i) => (
                  <BrowseCard
                    key={keyOf(t)}
                    t={t}
                    liq={liq.get(keyOf(t))}
                    chosen={pickedKeys.has(keyOf(t))}
                    disabled={busy || full}
                    index={i}
                    plate={plate}
                    pool={poolFactsFor(pickedByKey.get(keyOf(t)))}
                    onToggle={() => toggle(t.chainId, t.address, t.symbol)}
                  />
                ))}
                {rankedBrowse.length === 0 && (
                  <p className="col-span-full py-6 font-mono text-[11px] text-ink-faint">
                    Type a ticker above — the search asks every network at once.
                  </p>
                )}
              </div>
            ))}
        </div>
      </div>
      )}
    </div>
  )
}
