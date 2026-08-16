import { useEffect, useMemo, useRef, useState } from 'react'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { AssetLogo } from '../AssetLogo'
import { tokenVisual } from '../../lib/spectrum/token-meta'
import { chainCfg } from '../../lib/chain/chains'
import { aggregatePairs, ethHubsFor, quoteSideUsd, type Agg, type DexPair } from '../../lib/spectrum/token-search'

interface Candidate {
  address: string
  symbol: string
}

export interface LiqLite {
  liquidityUsd: number
  marketCapUsd: number
  priceChangeH24: number | null
  /** USD price from the DEEPEST ETH/WETH-quoted pair — the same pair the 24h
   *  change is read from, so the two figures never describe different markets.
   *  null = no such pair quoted a price (the caller prints "—", never 0). */
  priceUsd: number | null
  name: string
}

// large-cap gate for the "highlight the gainers" ordering (owner 19:15: "tokens
// over say a 10 mil market cap ... good price appreciation").
// EXPORTED (with LiqLite + fetchLiquidity) for the create face's cross-chain
// picker (CreateAssetPicker, 2026-08-12): one home for the batch-depth read and
// the gainer law — copying them there would be the restated-number trap.
export const MIN_HIGHLIGHT_MCAP = 10_000_000

// Same ceiling aggregatePairs keeps on one response: a glitchy or hostile
// payload must degrade (a missing price prints "—"), never hang the picker.
const MAX_PRICE_PAIRS = 500

// "Trending tokens" — candidate legs drawn from live baskets (previously-used /
// trending across ETH + Base), each shown with its 24h price move; large-cap
// gainers (≥$10M mcap, up over 24h) float to the front (owner 2026-07-07 19:15).
// Liquidity is no longer DISPLAYED — the strip is just token + 24h change.
//
// §9 NOTE: showing a % move on a tap-to-add card REVERSES the earlier "no perf
// badges — that's an inducement, not information" stance, at the owner's explicit
// direction; flagged for review. Depth is still computed under the hood (the
// same anti-impostor quote-side metric, token-search.ts) — just not shown.
//
// The candidate POOL is still the live baskets' constituents (a true cross-chain
// ">$10M mcap top-gainers" feed independent of baskets needs a data source —
// flagged upstream, not wired here).
export async function fetchLiquidity(addresses: string[], chainId: number): Promise<Map<string, LiqLite>> {
  const out = new Map<string, LiqLite>()
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()))].slice(0, 30)
  if (uniq.length === 0) return out
  const slug = chainCfg(chainId).dexscreenerSlug
  // '' = DexScreener doesn't index this chain (chains.ts contract): skip the
  // fetch instead of firing a guaranteed-404 `/tokens/v1//0x…` request — on
  // 4663 the starter set made that fire on every builder mount (audit).
  if (!slug) return out
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/${slug}/${uniq.join(',')}`, {
      headers: { Accept: 'application/json' },
    })
    if (!r.ok) return out
    const pairs = (await r.json()) as DexPair[]
    const rows = Array.isArray(pairs) ? pairs : []
    const hubs = ethHubsFor(chainId)
    const aggs = new Map<string, Agg>()
    aggregatePairs(rows, slug, hubs, aggs)
    // PRICE, from the deepest ETH/WETH-quoted pair (owner 2026-08-12: the
    // create cards should show "price / mcap of each asset rather than 24hr %").
    // Same quote-side depth rule the aggregate uses, so an impostor pool with a
    // fake price cannot outrank the real market on its own claim.
    const priceOf = new Map<string, { depth: number; price: number }>()
    for (const p of rows.slice(0, MAX_PRICE_PAIRS)) {
      if (p.chainId !== slug) continue
      const key = p.baseToken?.address?.toLowerCase()
      const quote = p.quoteToken?.address?.toLowerCase()
      if (!key || !quote || !hubs.has(quote)) continue
      const price = Number.parseFloat(p.priceUsd ?? '')
      if (!Number.isFinite(price) || price <= 0) continue
      const depth = quoteSideUsd(p)
      const cur = priceOf.get(key)
      if (!cur || depth > cur.depth) priceOf.set(key, { depth, price })
    }
    for (const [a, agg] of aggs)
      out.set(a, {
        liquidityUsd: agg.liquidityUsd,
        marketCapUsd: agg.marketCapUsd,
        priceChangeH24: agg.topPairUsd > 0 ? agg.priceChangeH24 : null,
        priceUsd: priceOf.get(a)?.price ?? null,
        name: agg.name,
      })
  } catch {
    /* leave empty → caller falls back to usage order */
  }
  return out
}

export function PopularAssets({
  chainId,
  chainName,
  candidates,
  excludeAddresses = [],
  onPick,
  busy = false,
  compact = false,
}: {
  chainId: number
  chainName: string
  candidates: Candidate[]
  excludeAddresses?: string[]
  onPick: (address: string, symbol?: string) => void
  busy?: boolean
  /** Shorter cards + tighter rail (the composer) — same data, same ranking. */
  compact?: boolean
}) {
  const [liq, setLiq] = useState<Map<string, LiqLite>>(new Map())
  const railRef = useRef<HTMLDivElement>(null)

  const exclude = useMemo(
    () => new Set(excludeAddresses.map((a) => a.toLowerCase())),
    [excludeAddresses],
  )
  // `candidates` arrive usage-frequency-sorted from the builder.
  const pool = useMemo(
    () => candidates.filter((c) => !exclude.has(c.address.toLowerCase())).slice(0, 24),
    [candidates, exclude],
  )
  const poolKey = pool.map((c) => c.address.toLowerCase()).join(',')

  useEffect(() => {
    if (pool.length === 0) return
    let alive = true
    fetchLiquidity(
      pool.map((c) => c.address),
      chainId,
    ).then((m) => {
      if (alive) setLiq(m)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolKey, chainId])

  const ranked = useMemo(() => {
    const rows = pool.map((c) => {
      const l = liq.get(c.address.toLowerCase())
      return {
        ...c,
        marketCapUsd: l?.marketCapUsd ?? null,
        change: l?.priceChangeH24 ?? null,
      }
    })
    const isBigGainer = (x: (typeof rows)[number]) =>
      x.marketCapUsd != null && x.marketCapUsd >= MIN_HIGHLIGHT_MCAP && (x.change ?? 0) > 0
    // large-cap gainers first, then by 24h change desc; unknown change trails.
    return rows.sort((a, b) => {
      const ga = isBigGainer(a)
      const gb = isBigGainer(b)
      if (ga !== gb) return ga ? -1 : 1
      if (a.change != null && b.change != null) return b.change - a.change
      if (a.change != null) return -1
      if (b.change != null) return 1
      return 0
    })
  }, [pool, liq])

  if (ranked.length === 0) return null

  const scroll = (dir: 1 | -1) => railRef.current?.scrollBy({ left: dir * 260, behavior: 'smooth' })

  return (
    <div className={compact ? 'mt-3.5 border-t border-white/8 pt-3.5' : 'mt-5 border-t border-white/8 pt-5'}>
      <div className={`flex items-center justify-between ${compact ? 'mb-2.5' : 'mb-3'}`}>
        {/* "Trending" is only true of the ORGANIC pool (constituents of live
            baskets, re-ranked by live market data). When the pool is only the
            curated starter seeds — a young chain, or one with no market data —
            calling them trending would be a claim nothing backs (kit audit). */}
        <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wide text-ink-dim">
          <span className="h-1.5 w-1.5 rounded-full bg-cyan" />
          {ranked.some((r) => r.change != null) ? 'Trending tokens' : 'Tokens to start from'} · {chainName}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => scroll(-1)}
            aria-label="Scroll left"
            className={`press grid place-items-center rounded-full border border-white/12 text-ink-dim hover:border-cyan/60 hover:text-cyan ${compact ? 'h-7 w-7' : 'h-8 w-8'}`}
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => scroll(1)}
            aria-label="Scroll right"
            className={`press grid place-items-center rounded-full border border-white/12 text-ink-dim hover:border-cyan/60 hover:text-cyan ${compact ? 'h-7 w-7' : 'h-8 w-8'}`}
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      </div>

      {/* -my-2/py-2 give slack so the hover glow isn't clipped by overflow-x-auto. */}
      <div ref={railRef} className={`no-scrollbar rail-fade -mx-2 flex overflow-x-auto scroll-smooth px-2 ${compact ? '-my-1.5 gap-2 py-1.5' : '-my-3 gap-3 py-3'}`}>
        {ranked.map((t) => {
          const color = tokenVisual(t.symbol, t.address).color
          const chg = t.change
          const chgText = chg == null ? null : `${chg >= 0 ? '+' : ''}${chg.toFixed(Math.abs(chg) >= 100 ? 0 : 1)}%`
          const chgCls = chg == null ? 'text-ink-faint' : chg >= 0 ? 'text-teal' : 'text-magenta'

          // compact = a thin pill (owner 19:15: "that strip should be a bit
          // thinner ... just the token and its price performance over 24h").
          if (compact) {
            return (
              <button
                key={t.address}
                type="button"
                disabled={busy}
                aria-label={`Add ${showSymbol(t.symbol)} to basket`}
                onClick={() => onPick(t.address, t.symbol)}
                className="press group flex shrink-0 items-center gap-2 rounded-full border border-white/10 py-1.5 pl-1.5 pr-3 transition-colors hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: `linear-gradient(100deg, ${color}22, rgba(255,255,255,0.02))` }}
              >
                <AssetLogo address={t.address} symbol={t.symbol} chainId={chainId} size={22} discColor={`color-mix(in srgb, ${color} 55%, #000)`} />
                <span className="font-display text-xs font-bold uppercase tracking-wide text-ink">{showSymbol(t.symbol)}</span>
                <span className={`font-num text-[11px] tabular-nums ${chgCls}`}>{chgText ?? '24h —'}</span>
              </button>
            )
          }

          return (
            <button
              key={t.address}
              type="button"
              disabled={busy}
              aria-label={`Add ${showSymbol(t.symbol)} to basket`}
              onClick={() => onPick(t.address, t.symbol)}
              className="group relative flex w-[156px] shrink-0 flex-col justify-between gap-3 overflow-hidden rounded-2xl border border-white/10 p-3 text-left transition-[border-color,translate,scale] duration-200 hover:-translate-y-0.5 hover:border-white/25 active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
              style={{ background: `linear-gradient(160deg, ${color}26, ${color}0a 44%, rgba(255,255,255,0.02))` }}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-2xl opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                style={{ boxShadow: `inset 0 0 0 1px ${color}55, 0 8px 18px -10px ${color}` }}
              />
              <div className="relative flex items-start justify-between">
                <AssetLogo address={t.address} symbol={t.symbol} chainId={chainId} size={36} discColor={`color-mix(in srgb, ${color} 55%, #000)`} />
                <span
                  aria-hidden
                  className="grid h-6 w-6 place-items-center rounded-full border border-white/15 font-num text-base leading-none text-ink-dim transition-colors group-hover:border-cyan group-hover:text-cyan"
                >
                  +
                </span>
              </div>
              <div className="relative min-w-0">
                <div className="truncate font-display text-sm font-bold uppercase tracking-wide text-ink">{showSymbol(t.symbol)}</div>
                <span className={`mt-1.5 inline-flex items-center gap-1 rounded-md bg-white/[0.06] px-1.5 py-0.5 font-num text-xs tabular-nums ${chgCls}`}>
                  {chgText ? `${chgText} 24h` : '24h —'}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
