// ─────────────────────────────────────────────────────────────────────────────
// ASSET UNIFICATION for the PICTURE surfaces (owner 2026-08-03 ~15:0x): "it
// should detect if you have the same asset like eth/weth on multiple chains
// and show it as ONE bento asset on both onboarding and the live portfolio —
// then on the portfolio it shows the breakdown of where it's held / which
// chain and the eth/weth split."
//
// DISPLAY-LAYER ONLY, by law. The positions mode, search, insights, tiers and
// every trading surface keep per-chain per-form rows: trades are per-chain
// ("trade what the chain lets you trade"), and this module must never feed
// anything that composes an intent. It merges what the two bento PICTURES
// draw, nothing else.
//
// WHAT COUNTS AS THE SAME ASSET (tightened in audit round 2): folding is
// CURATED — the wrap families (FORM_CANON: ETH≡WETH, BTC≡WBTC≡cbBTC) and
// the stable set, the owner's own examples. An arbitrary symbol match does
// NOT fold: symbols are attacker-controlled on-chain data, and a scam token
// sharing a real ticker would otherwise merge into the real tile and wear
// its identity. Same-symbol strangers stay separate tiles, breakdowns stay
// honest, and the wallet's own holdings (not open search) are the input.
// ─────────────────────────────────────────────────────────────────────────────

export interface UnifiablePart {
  /** chain-qualified key, `${chainId}:${address}` */
  key: string
  chainId: number
  address: string
  symbol: string
  valueUsd: number
  /** share of the surface's own universe, 0–100 (summed on merge) */
  pct?: number
  change24hPct?: number | null
  /** A held BASKET row (found-book 2.2). A basket is NEVER the same asset as
   *  a token — see the folding law below. */
  basket?: boolean
  /** FALSE = this row's identity rests on nothing but its own symbol() (a
   *  DISCOVERED token). The fold families are symbol-keyed, so an unverified
   *  "USDT"/"WETH" must NEVER fold into the curated tile — it would wear the
   *  real asset's identity and add its value to the real total (audit
   *  2026-08-06 #4). Absent = address-picked/curated rows, fold as always. */
  verified?: boolean
}

export interface UnifiedAsset<P extends UnifiablePart = UnifiablePart> {
  /** Display symbol — the canonical form (ETH, BTC, or the shared ticker). */
  canon: string
  /** Stable tile id: the single part's key, or `canon:<symbol>` when merged. */
  id: string
  /** Every row this asset folds, largest value first. */
  parts: P[]
  /** The identity donor (logo / chain badge / chart link): the largest part. */
  dominant: P
  valueUsd: number
  pct: number
  /** Value-weighted over the parts that HAVE a reading; null when none do —
   *  a missing change is not a flat one, merged or not. */
  change24hPct: number | null
  /** True when more than one row folded — the only case a breakdown shows. */
  merged: boolean
}

/** Wrap-forms that read as one asset. Symbol-keyed, like MAJORS/CASH_SYMBOLS
 *  in market-tiers — the house's existing recognition grain. */
const FORM_CANON: Record<string, string> = {
  ETH: 'ETH',
  WETH: 'ETH',
  BTC: 'BTC',
  WBTC: 'BTC',
  CBBTC: 'BTC',
}

export function canonSymbol(symbol: string): string {
  const up = symbol.toUpperCase()
  return FORM_CANON[up] ?? up
}

/** Symbols allowed to FOLD across chains/addresses (audit round 2): the wrap
 *  families + the curated stables — the owner's own examples. An ARBITRARY
 *  symbol match must NOT fold: symbols are attacker-controlled on-chain data,
 *  and a scam token named "PEPE" on another chain would otherwise merge into
 *  the real PEPE's tile and wear its identity (value inflated, logo trusted).
 *  Same-symbol strangers stay separate tiles. */
const CASH_FOLDABLE = new Set(['USDC', 'USDT', 'DAI', 'USDG', 'USDS', 'PYUSD', 'FDUSD', 'GHO', 'LUSD'])
export function foldable(symbol: string): boolean {
  const up = symbol.toUpperCase()
  return up in FORM_CANON || CASH_FOLDABLE.has(up)
}

/** Fold same-asset rows into one per canonical symbol. Order of the result
 *  follows total value, largest first — the same ordering both pictures use. */
export function unifyAssets<P extends UnifiablePart>(rows: P[]): UnifiedAsset<P>[] {
  const groups = new Map<string, P[]>()
  for (const r of rows) {
    // non-foldable symbols group by their OWN key — no cross-part merging.
    // A BASKET row never folds AT ALL (audit 2026-08-04, ruled here): basket
    // tickers are creator-chosen, so a basket named "WETH" would fold into
    // the real WETH tile — combined USD, one toggle, and the seeder then
    // riding only the token half. A basket is a different KIND of thing
    // from a token, not a wrap-form of it; same ticker is a coincidence.
    // …and an UNVERIFIED row (identity = its own symbol(), nothing more)
    // never folds either: symbol-keyed families are exactly what a scam
    // token impersonates. It stays its own tile, worth whatever it is.
    const c = !r.basket && r.verified !== false && foldable(r.symbol) ? canonSymbol(r.symbol) : `solo:${r.key}`
    const g = groups.get(c)
    if (g) g.push(r)
    else groups.set(c, [r])
  }
  const out: UnifiedAsset<P>[] = []
  for (const [canon, parts] of groups) {
    const sorted = [...parts].sort((a, b) => b.valueUsd - a.valueUsd)
    const valueUsd = sorted.reduce((s, p) => s + p.valueUsd, 0)
    const pct = sorted.reduce((s, p) => s + (p.pct ?? 0), 0)
    const priced = sorted.filter((p) => typeof p.change24hPct === 'number' && Number.isFinite(p.change24hPct) && p.valueUsd > 0)
    const pricedUsd = priced.reduce((s, p) => s + p.valueUsd, 0)
    const change24hPct =
      priced.length > 0 && pricedUsd > 0
        ? priced.reduce((s, p) => s + (p.change24hPct as number) * p.valueUsd, 0) / pricedUsd
        : null
    out.push({
      canon: canon.startsWith('solo:') ? sorted[0].symbol.toUpperCase() : canon,
      id: sorted.length > 1 ? `canon:${canon.toLowerCase()}` : sorted[0].key,
      parts: sorted,
      dominant: sorted[0],
      valueUsd,
      pct,
      change24hPct,
      merged: sorted.length > 1,
    })
  }
  return out.sort((a, b) => b.valueUsd - a.valueUsd)
}

/** THE CASH PILE IS ONE TILE (the owner 2026-08-06 12:49 #7: fold every cash row
 *  into a single green CASH tile with its stablecoin breakdown). `unifyAssets`
 *  already folds one stable across chains; this folds the DIFFERENT stables
 *  into each other, which the earlier pass deliberately does not — USDC and
 *  USDG are not the same asset, they are the same KIND of asset, and only a
 *  surface that says "cash" out loud may treat them as one.
 *
 *  Display-layer only, same law as the module: the parts survive intact so the
 *  tile can name every stable it stands for, and nothing here reaches a
 *  surface that composes an intent — you cannot trade "cash".
 *
 *  A held BASKET never folds in, even one tickered like a stable (the same
 *  attacker-controlled-symbol reasoning the fold law above is built on). */
export function foldCashPile<P extends UnifiablePart>(
  units: UnifiedAsset<P>[],
  isCash: (symbol: string) => boolean,
): UnifiedAsset<P>[] {
  const cash: UnifiedAsset<P>[] = []
  const rest: UnifiedAsset<P>[] = []
  for (const u of units) {
    const foldable = !u.parts.some((p) => p.basket) && isCash(u.canon)
    ;(foldable ? cash : rest).push(u)
  }
  if (cash.length === 0) return units

  const parts = cash.flatMap((u) => u.parts).sort((a, b) => b.valueUsd - a.valueUsd)
  // THE TOTAL COUNTS EXACTLY WHAT THE ROWS SHOW. Both gates matter and for the
  // same reason: an unreadable part would turn the pile's figure into NaN over
  // a wallet that genuinely holds money, and a non-positive one would be summed
  // here while `cashPileSplit` drops it — leaving a tile whose headline and its
  // own breakdown disagree. A display-only aggregate always gets caught, so the
  // aggregate and the legs are computed over one set. (Found by the hostile
  // sweep, not by hand: -1 is finite, so a finite-only gate walked straight
  // past it.)
  const counts = (n: number | undefined) => Number.isFinite(n ?? 0) && (n ?? 0) > 0
  const valueUsd = parts.reduce((s, p) => (counts(p.valueUsd) ? s + p.valueUsd : s), 0)
  const pct = parts.reduce((s, p) => (counts(p.valueUsd) && Number.isFinite(p.pct ?? 0) ? s + (p.pct ?? 0) : s), 0)
  const pile: UnifiedAsset<P> = {
    canon: 'CASH',
    id: 'canon:cash-pile',
    parts,
    dominant: parts[0],
    valueUsd,
    pct,
    // NO 24h ON THE PILE, deliberately — the reshape popup's cash tile has
    // never carried one, and a value-weighted day's move across stablecoins is
    // a rounding artefact dressed as a fact about someone's cash.
    change24hPct: null,
    merged: parts.length > 1,
  }
  return [...rest, pile].sort((a, b) => b.valueUsd - a.valueUsd)
}

/** The pile's stablecoins, largest first, one row per SYMBOL — the same stable
 *  held on three chains is one line of the breakdown, because the tile's
 *  question is "what is my cash made of", not "where does it sit". */
export function cashPileSplit<P extends UnifiablePart>(pile: UnifiedAsset<P>): { symbol: string; usd: number; part: P }[] {
  const bySymbol = new Map<string, { symbol: string; usd: number; part: P }>()
  for (const p of pile.parts) {
    if (!Number.isFinite(p.valueUsd) || p.valueUsd <= 0) continue
    const sym = p.symbol.toUpperCase()
    const hit = bySymbol.get(sym)
    if (hit) hit.usd += p.valueUsd
    else bySymbol.set(sym, { symbol: sym, usd: p.valueUsd, part: p })
  }
  return [...bySymbol.values()].sort((a, b) => b.usd - a.usd)
}
