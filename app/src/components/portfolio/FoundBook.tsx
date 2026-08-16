import { useEffect, useMemo, useRef, useState } from 'react'
import { chainCfg } from '../../lib/chain/chains'
import { BasketBento, type BentoItem } from '../BasketBento'
import { chartLinksFor } from '../../lib/spectrum/chart-links'
import { useMarketData } from '../../lib/spectrum/use-market-tiers'
import { formatUsdCompact } from '../../lib/spectrum/format'
import { unifyAssets } from '../../lib/spectrum/asset-unify'
import { vtName } from '../../lib/spectrum/view-transition'
import type { RawHolding } from '../../lib/spectrum/raw-holdings'

// ─────────────────────────────────────────────────────────────────────────────
// FOUND BOOK — the onboarding ceremony's "what you already hold", drawn by the
// REAL engine (owner ~12:4x via UIGuy's desk: the intro's minimal mount didn't
// display "as fluidly / seamlessly as on the portfolio system"; the ceremony
// SHELL stays UIGuy's — steps, latch, replay, reveal frame — and this
// visualization is specallocator's lane).
//
// What the engine brings that the minimal mount never passed:
//   · SAME-ASSET UNIFICATION (owner ~15:0x): ETH/WETH across chains reads as
//     ONE tile here, exactly as it will on the portfolio behind — the book
//     shows the merged asset clean; the where-held/which-form breakdown is
//     the portfolio's job, not the intro's.
//   · the market read — each tile carries its 24h move (value-weighted across
//     a merged asset's parts; null is OMITTED, not drawn flat) and a chart
//     link with the venue's real mark;
//   · the staggered build-in on first reveal and the glide on later changes
//     (linking a wallet mid-ceremony re-lays the same book, no remount).
//
// The plain treemap, deliberately: chain-clustered regions were built first,
// but a merged ETH tile holds value from SEVERAL chains — parking it in one
// chain's region makes the region sums lie, and a region that misstates per-
// chain totals is worse than no regions (superseded by the ~15:0x merge ask;
// per-tile chain identity stays visible on the venue mark).
//
// The display laws stay HERE, where the items are made (owner ~12:4x, the
// broken-looking grid): ids are stable and CHAIN-QUALIFIED via the unify
// layer (native ETH on two chains shares the 0xeee… sentinel address), and
// DUST does not tile — it belongs in the host's remainder rows. `inBook` is
// the single predicate the host filters against, so the split cannot drift.
// ─────────────────────────────────────────────────────────────────────────────

/** Below this a position stays in the rows, honestly — not in the picture. */
export const BOOK_DUST_USD = 1

/** The one predicate deciding picture vs rows — the host's remainder list
 *  filters with its negation, so no holding is dropped or drawn twice. */
export function inBook(h: RawHolding): boolean {
  return h.usd != null && h.usd >= BOOK_DUST_USD
}

/** Value-weighted unit price for a unified tile, or null when it cannot be
 *  read. Sums USD and token amount across the tile's own parts: a token held on
 *  three chains has one price, and the honest one is total value over total
 *  tokens rather than whichever leg happened to be first. */
function unitPriceOf(
  u: { parts: { key: string }[] },
  holdings: readonly { chainId: number; address: string; amount?: number; usd?: number | null }[],
): string | null {
  const byKey = new Map(holdings.map((h) => [`${h.chainId}:${h.address.toLowerCase()}`, h]))
  let usd = 0
  let tokens = 0
  for (const part of u.parts) {
    const h = byKey.get(part.key)
    if (!h) continue
    const v = typeof h.usd === 'number' && Number.isFinite(h.usd) ? h.usd : 0
    const a = typeof h.amount === 'number' && Number.isFinite(h.amount) ? h.amount : 0
    usd += v
    tokens += a
  }
  if (!(tokens > 0) || !(usd > 0)) return null
  const price = usd / tokens
  if (!Number.isFinite(price) || price <= 0) return null
  // sub-cent assets need their real precision; ordinary ones read as money
  return price < 1 ? `$${price.toPrecision(4)}` : `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function FoundBook({
  holdings,
  pickable = false,
  onIncludedChange,
}: {
  holdings: RawHolding[]
  /** PICK WHAT TO BRING IN (the first-run ordering the owner ruled 2026-08-03
   *  ~15:5x): everything you hold starts IN; tapping a tile leaves it out —
   *  dark = staying out, the publish picker's own grammar. A selection layer
   *  only: the picture keeps showing every holding either way. */
  pickable?: boolean
  /** Reports the included HOLDING keys (`chainId:address`, every part of a
   *  merged tile) after each toggle and once per holdings change, so the
   *  host's seed CTA can honor the picks without owning the selection. */
  onIncludedChange?: (keys: Set<string>) => void
}) {
  const marketAssets = useMemo(
    () => holdings.map((h) => ({ chainId: h.chainId, address: h.address, symbol: h.symbol })),
    [holdings],
  )
  const market = useMarketData(marketAssets)

  // Warm the create-flow chunk while the user reads their book: the glide's
  // new-side snapshot is the weight station, and /create is a lazy route — a
  // cold chunk would put the Suspense fallback in the snapshot instead.
  useEffect(() => {
    void import('../../pages/Manager')
  }, [])

  // Exclusion is keyed by UNIFIED tile id (a merged ETH tile toggles all its
  // parts at once — you leave the ASSET out, not one chain's slice of it).
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set())

  const unified = useMemo(
    () =>
      unifyAssets(
        holdings.map((h) => {
          const key = `${h.chainId}:${h.address.toLowerCase()}`
          return {
            key,
            chainId: h.chainId,
            address: h.address,
            symbol: h.symbol,
            valueUsd: h.usd ?? 0,
            change24hPct: market.get(key)?.change24hPct ?? null,
            // a basket named "WETH" must stay its own tile (unify's basket law)
            basket: !!h.basket,
          }
        }),
      ),
    [holdings, market],
  )

  // Report the included holding keys — once per holdings change and on every
  // toggle. A ref keeps the callback out of the effect's dependency story,
  // and the effect keys on a holdings SIGNATURE (the useLiveExposure idiom):
  // `unified` re-memos every render because useMarketData returns a fresh
  // Map, and an effect writing host state off that identity would loop the
  // render forever. The included keys don't depend on market data at all.
  const reportRef = useRef(onIncludedChange)
  reportRef.current = onIncludedChange
  const holdingsSig = holdings.map((h) => `${h.chainId}:${h.address.toLowerCase()}`).join('|')
  useEffect(() => {
    if (!pickable) return
    const keys = new Set<string>()
    const groups = unifyAssets(
      holdings.map((h) => ({
        key: `${h.chainId}:${h.address.toLowerCase()}`,
        chainId: h.chainId,
        address: h.address,
        symbol: h.symbol,
        valueUsd: h.usd ?? 0,
        basket: !!h.basket,
      })),
    )
    for (const u of groups) if (!excluded.has(u.id)) for (const p of u.parts) keys.add(p.key)
    reportRef.current?.(keys)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickable, holdingsSig, excluded])

  // Accessibility-only truth for the toggles (UIGuy's ariaPressedIds seam):
  // included tiles read aria-pressed=true, a tapped-out tile finally reads
  // false — without un-dimming anything (the visual selection grammar stays).
  const includedIds = useMemo(
    () => new Set(unified.filter((u) => !excluded.has(u.id)).map((u) => u.id.toLowerCase())),
    [unified, excluded],
  )

  const items = useMemo(() => {
    const sum = holdings.reduce((s, h) => s + (h.usd ?? 0), 0)
    if (sum <= 0) return [] as BentoItem[]
    return unified.map((u): BentoItem => {
      const link = chartLinksFor(u.dominant.chainId, u.dominant.address)[0]
      return {
        id: u.id,
        symbol: u.canon,
        address: u.dominant.address,
        chainId: u.dominant.chainId,
        weightPct: (u.valueUsd / sum) * 100,
        // the glide's old-side handle — the station names its dominant leg
        // tile from the SAME unified id, and the browser pairs them up
        transitionName: vtName(u.id),
        // left out = dark (the publish picker's grammar, inverted default:
        // here everything starts IN and a tap darkens what stays out)
        dim: pickable && excluded.has(u.id),
        footer: {
          amount: formatUsdCompact(u.valueUsd),
          change24hPct: u.change24hPct,
          // THE UNIT PRICE, like the portfolio shows (the owner 2026-08-09: "on the
          // onboarding flow it needs to show the price of the assets too, just
          // like on the portfolio"). The bento already had a `price` slot in its
          // footer type and this surface simply never filled it.
          //
          // Derived from the RAW holdings rather than the unified tile, because
          // unifyAssets carries value but not token amount, and threading amount
          // through a shared function to reach one surface is a wider change
          // than the ask. Summing both sides across the tile's parts gives the
          // value-weighted price, which is the right number for one asset held
          // on several chains.
          //
          // Null when it cannot be computed — an unpriced or zero-balance
          // holding has no price, and inventing one (or printing $0.00) would
          // be worse than the absence the bento already handles.
          price: unitPriceOf(u, holdings) ?? undefined,
          href: link?.href,
          hrefLabel: link ? `${link.label}: $${u.canon}` : undefined,
          markSrc: link?.mark,
        },
      }
    })
  }, [holdings, unified, pickable, excluded])

  // The host gates on ≥2 pictured ROWS; unification may fold those into one
  // tile, and a single merged tile still tells the story ("everything you
  // hold is ETH, across chains") — only a truly empty book renders nothing.
  if (items.length === 0) return null

  const toggle = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div>
      <BasketBento
        items={items}
        aspect={2.2}
        animateLayout
        layoutMotion="glide"
        reveal={{ delayMs: 80, stepMs: 70 }}
        {...(pickable ? { onSelect: toggle, ariaPressedIds: includedIds } : {})}
      />
      {pickable &&
        (() => {
          // the seed CTA disables under two tradeable holdings — a disabled
          // button with no stated reason is the dead-confirm's quiet cousin,
          // so the hint says WHY the moment picks drop below it. The count
          // mirrors the SEEDER's laws exactly (both lanes fixed this the same
          // morning; UIGuy's shape kept — reviewed: it also refuses a native
          // on a chain with no known WETH, which my !basket count over-
          // promised): held BASKETS never ride (not a plain leg the picker
          // resolves), NATIVE rides wherever the chain knows its WETH (the
          // fold). Counting anything else contradicts the host CTA beside it.
          const seedsByKey = new Map(
            holdings.map((h) => {
              let rides = !h.basket
              if (rides && h.native) {
                try {
                  rides = !!chainCfg(h.chainId).weth
                } catch {
                  rides = false
                }
              }
              return [`${h.chainId}:${h.address.toLowerCase()}`, rides] as [string, boolean]
            }),
          )
          let tradeableIn = 0
          for (const u of unified)
            if (!excluded.has(u.id)) for (const part of u.parts) if (seedsByKey.get(part.key)) tradeableIn++
          return tradeableIn < 2 ? (
            <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300/85">
              keep at least two tradeable holdings in to shape them
            </p>
          ) : (
            <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              everything you hold is in · tap a tile to leave it out
            </p>
          )
        })()}
    </div>
  )
}
