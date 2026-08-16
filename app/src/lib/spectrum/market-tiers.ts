// ─────────────────────────────────────────────────────────────────────────────
// MARKET TIERS — pure classification (recording 13:57: positions grouped so
// "you can get a much better idea of how much money is in safer assets versus
// riskier assets"). React-free; the mcap fetch lives in use-market-tiers.ts.
//
// FACTS-ONLY law (00:49, standing): tier names are market-value FACTS ("large
// caps"), never advice ("safe"); the per-tier share is a fact; a single
// "total risk %" is a SCORE and stays out until the owner overrules the red line
// (flagged in the 13:57 filing). Thresholds are stated in the UI's ⓘ.
// Unreadable mcap → 'unranked', never guessed into a tier.
// ─────────────────────────────────────────────────────────────────────────────

export type MarketTier = 'cash' | 'majors' | 'large' | 'mid' | 'small' | 'micro' | 'ultra' | 'stocks' | 'unranked'

/** Display order — his "safer at the top… launch stuff at the bottom".
 *  STOCKS sit immediately after cash (owner 2026-08-02 ~19:1x: "stocks should
 *  be literally the safest option after cash, so to the right of cash"): an
 *  equity tracker is not a crypto market cap and does not belong in the middle
 *  of one. Everything downstream reads this order — the spectrum axis, the tier
 *  bar and the grouped list — so it is changed HERE and nowhere else. */
export const TIER_ORDER: MarketTier[] = ['cash', 'stocks', 'majors', 'large', 'mid', 'small', 'micro', 'ultra', 'unranked']

export const TIER_LABELS: Record<MarketTier, string> = {
  cash: 'Cash',
  majors: 'ETH & BTC',
  stocks: 'Stocks',
  large: 'Large caps',
  mid: 'Mid caps',
  small: 'Small caps',
  micro: 'New & micro',
  ultra: 'Ultra small caps',
  unranked: 'Unranked',
}

/**
 * The spectrum's palette, cool → warm along TIER_ORDER (owner 2026-08-02 17:53:
 * "it doesn't give you a bad enough idea of how much risk you're taking down
 * the market cap spectrum").
 *
 * This is SEQUENTIAL data — an ordered walk from cash to the launch bucket — so
 * it takes a sequential ramp. The categorical identity palette that used to
 * draw the bar put magenta on stocks and teal on small caps: it looked like a
 * heat scale while being in no order at all, so the bar fought the very
 * ordering it exists to show. The ramp encodes the ORDERING, which is a
 * market-value fact, not a verdict about it — tier names stay facts and nothing
 * here scores the portfolio. `unranked` sits OUTSIDE the ramp, in neutral grey,
 * because an unreadable market cap has no place on the spectrum at all.
 */
export const TIER_RAMP: Record<MarketTier, string> = {
  cash: 'var(--color-teal)',
  stocks: 'var(--color-cyan)',
  majors: '#7aa2f7',
  large: 'var(--color-violet-bright)',
  mid: '#b06ae8',
  small: 'var(--color-magenta)',
  micro: 'var(--color-amber)',
  // the ramp's far end — hotter than amber, because this band IS the end of
  // the walk. Still a position on a stated scale, never a verdict.
  ultra: 'var(--color-alert)',
  unranked: 'rgba(255,255,255,0.22)',
}

/** Market-value thresholds (USD) — stated verbatim in the UI's ⓘ. */
// small/micro boundary $20M per the owner (live note 2026-08-02 ~14:1x: "small
// and new caps should be under 20m mcap imo" — read as: the launch bucket is
// sub-$20M; interpretation flagged in the 1357 filing).
//
// MID FLOOR $100M, set from real market caps rather than a guess (owner
// ~19:1x: "syrup and aero I'd class as midcaps not small caps, look at their
// mcaps"). Looked them up on the same DexScreener read this file's tiers use:
// SYRUP $194M, AERO $767M. Both sat under the old $1B mid floor and so fell
// into 'small'. $100M is the round boundary that puts both in mid while
// leaving 'small' a real band above his $20M launch line.
// RE-CALIBRATED BY THE OWNER, 2026-08-06: "mid cap should be 50-200m, high cap
// above that." The old large floor was $10B and mid $100M — numbers borrowed
// from a general-market view, not from the book this product is actually for.
// For an audience trading low caps, a $250M token IS the large end, and a scale
// whose middle band starts at $100M puts almost everything they hold in one
// bucket, which is the opposite of what the meter is for.
//
// SUPERSEDES the $100M mid floor set on 2026-08-02 (the SYRUP/AERO ruling);
// both still land mid under the new bands, so that decision survives its own
// threshold moving. The $20M small line and the $2M ultra line are unchanged.
export const TIER_THRESHOLDS = { large: 200_000_000, mid: 50_000_000, small: 20_000_000, ultra: 2_000_000 } as const

/** ULTRA SMALL CAPS (the owner 2026-08-06 12:58: "newly launched in like the last
 *  week that's below… 2 mil market cap — I think 2 mil market cap's good for
 *  the ultra small caps"). BOTH conditions, never either: a $1M token that has
 *  traded for two years is small, not new, and a week-old token at $40M is new
 *  but not ultra. The band exists because the two together are the shape a
 *  trencher is actually carrying risk in.
 *
 *  AGE IS A FACT WE OFTEN DO NOT HAVE. A token whose first pair date will not
 *  read is NOT treated as old — it simply fails the age test and stays in
 *  whatever cap band its market value earns, because inventing an age would
 *  put a token in this band (or keep it out) on a guess. */
export const ULTRA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** A threshold rendered for humans. Exists so no surface hardcodes the UNIT:
 *  "$10B" written as `${T.large / 1e9}B` silently became "$0B" the moment the
 *  large floor moved to $200M, which is the same restate-don't-derive drift
 *  that had the cap meter claiming a $1B mid floor months after it changed. */
export function capLabel(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '—'
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(usd % 1e9 === 0 ? 0 : 1)}B`
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(0)}M`
  return `$${(usd / 1e3).toFixed(0)}K`
}

/** The cap meter's three bands, in words, DERIVED from the thresholds above.
 *  The meter's tooltip is the one place the scale teaches itself, so it must
 *  never be able to disagree with the scale. */
export function capMeterLabel(bars: 1 | 2 | 3): string {
  if (bars === 3) return `high cap · ${capLabel(TIER_THRESHOLDS.large)}+ (majors included)`
  if (bars === 2) return `mid cap · ${capLabel(TIER_THRESHOLDS.mid)}–${capLabel(TIER_THRESHOLDS.large)}`
  return `low cap · under ${capLabel(TIER_THRESHOLDS.mid)}`
}

/** The cash registry — single source (Yours, the mode, and the composer all
 *  read THIS set; three drifting copies died here). */
export const CASH_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDG', 'USDS', 'PYUSD', 'FDUSD', 'GHO', 'LUSD'])

/** The cash tile's special green (owner ~09:5x: "a special background colour /
 *  effect that's cash green") — a deep dollar green, a CONCRETE HEX because the
 *  bento paints to canvas-adjacent systems that cannot resolve var(). It lives
 *  beside the registry it belongs to: TWO surfaces draw the pile now (the
 *  reshape picture and the portfolio bento), and a second copy of this hex
 *  would be a drift waiting to happen. */
export const CASH_GREEN = '#159a4f'
const STABLES = CASH_SYMBOLS
const MAJORS = new Set(['ETH', 'WETH', 'BTC', 'WBTC', 'CBBTC'])

export function classifyTier(
  symbol: string,
  marketCapUsd: number | null | undefined,
  opts: {
    isStock?: boolean
    /** When the token's first pair started trading (ms epoch). Null/absent =
     *  unknown, which is NOT the same as old — see ULTRA_MAX_AGE_MS. */
    firstSeenMs?: number | null
    /** Injectable clock so the classifier stays pure under test. */
    nowMs?: number
  } = {},
): MarketTier {
  const sym = symbol.toUpperCase()
  if (STABLES.has(sym)) return 'cash'
  if (MAJORS.has(sym)) return 'majors'
  if (opts.isStock) return 'stocks'
  if (marketCapUsd == null || !(marketCapUsd > 0)) return 'unranked'
  if (marketCapUsd >= TIER_THRESHOLDS.large) return 'large'
  if (marketCapUsd >= TIER_THRESHOLDS.mid) return 'mid'
  if (marketCapUsd >= TIER_THRESHOLDS.small) return 'small'
  if (marketCapUsd < TIER_THRESHOLDS.ultra && isFreshlyLaunched(opts.firstSeenMs, opts.nowMs)) return 'ultra'
  return 'micro'
}

/** Launched inside the ultra window. False on an unreadable or nonsensical
 *  date — including one in the FUTURE, which a bad feed does produce and which
 *  would otherwise read as "launched moments ago" forever. */
export function isFreshlyLaunched(firstSeenMs: number | null | undefined, nowMs = Date.now()): boolean {
  if (firstSeenMs == null || !Number.isFinite(firstSeenMs) || firstSeenMs <= 0) return false
  const age = nowMs - firstSeenMs
  return age >= 0 && age <= ULTRA_MAX_AGE_MS
}

/** The volatility-tier share — a FACT for the insights line: how much of the
 *  weighted value sits in small caps and new/micro tokens. */
export function volatileSharePct(rows: { tier: MarketTier; pct: number }[]): number {
  return rows.filter((r) => r.tier === 'small' || r.tier === 'micro' || r.tier === 'ultra').reduce((s, r) => s + r.pct, 0)
}
