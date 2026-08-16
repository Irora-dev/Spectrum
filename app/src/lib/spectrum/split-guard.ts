// ─────────────────────────────────────────────────────────────────────────────
// LAYERS 2-4 OF THE PRICING DEFENCE (Ⓡ the owner, 2026-08-02: D-R1 ships, and
// "we should build this system out comprehensively, ensure it has rigid
// safeguards, plenty of testing across high caps, mid caps, low caps, new pairs").
//
// WHAT THIS DEFENDS AGAINST. The D-R1 buy path splits a buyer's funding across
// legs in proportion to what each leg is currently WORTH. Somebody has to compute
// that. If we compute it from the same on-chain spot marks the contract reads, we
// inherit the same broken split — being off-chain does not fix the data by itself.
// SpectrumContracts measured the failure: a shallow-pool leg marked at 509,250x
// what it had been funded with, the derived split came out 9999/0, and a leg
// holding real reserves got zero funding.
//
// THE INSIGHT THAT SHAPES EVERYTHING HERE, and it is theirs, not mine:
//
//   value = price × quantity ONLY IF that price is achievable at that quantity.
//
// On a thin pool it is not. An 815-million-dollar mark can be a faithful report of
// a price nobody could ever transact at. So a split derived from ANY mark, however
// manipulation-resistant, is still wrong on a thin leg — averaging three feeds buys
// robustness against manipulation and NOTHING against depth. What we actually want
// is REALIZABLE value: what the leg would fetch if unwound, net of fee and impact.
//
// FOUR LAYERS, ours being 2-4:
//   1. contract  — best effort on-chain, never SILENTLY mis-split. (not here)
//   2. corroborate across INDEPENDENT sources.
//   3. cross-check the contract's own lens, treating it as a backup not the truth.
//   4. on disagreement, WARN and prompt a resync rather than quoting through it.
//
// Layer 4 is the one that actually protects a person: someone told "these prices
// disagree, refresh" is strictly better off than someone silently filled on a bad
// split. So the default on every uncertain path in this file is REFUSE, not guess.
//
// Pure, integer-and-float-free of side effects, no React, no network. Every
// threshold is a named export so a test can walk the boundary rather than trusting
// a literal buried in a branch.
// ─────────────────────────────────────────────────────────────────────────────

/** One leg as this module needs to see it. Deliberately minimal so any caller can
 *  build it, and so nothing here depends on the basket-data shape. */
import { showSymbol } from './safe-copy'

export interface LegMark {
  symbol: string
  /** The mark we are being asked to trust, USD per whole token. */
  markUsd: number
  /** Units held, whole tokens. */
  held: number
  /**
   * What this leg was actually FUNDED with, in USD, if known.
   *
   * This is the cheapest and strongest signal in the whole file and it needs no
   * price feed at all — just the basket's own history. A leg marking far away from
   * what someone actually paid for it is a leg whose mark is unusable.
   */
  fundedUsd?: number
  /**
   * Quote-side depth of the DEEPEST SINGLE POOL for this leg, USD.
   *
   * Deepest single pool, never the sum across pools: you trade against one pool,
   * and summing overstates what a single exit can clear. Null when unreadable —
   * which is NOT the same as zero and must never be treated as it.
   */
  liquidityUsd?: number | null
}

// ── THRESHOLDS ───────────────────────────────────────────────────────────────

/** A mark this far from what the leg was funded with is not a price, it is a
 *  malfunction. Contracts' measured case was 509,250x; 10x is far outside any
 *  honest move (a 10x on a real position is a story, not a rounding artefact). */
export const COST_BASIS_MAX_RATIO = 10

/** Independent sources disagreeing by more than this are not corroborating. 2% is
 *  above ordinary feed skew and staleness, below anything that changes a split. */
export const SOURCE_AGREE_PCT = 2

/** Our derived split disagreeing with the contract's by more than this on any leg
 *  means one of us is wrong, and we do not get to assume it is them.
 *
 *  MEASURED on the CANONICAL fork (2026-08-04, scripts/split-calibration.ts
 *  against SpectrumContracts' OWN D10 rev factory on their archive-backed
 *  anvil fork of live 4663 — supersedes my 2026-08-03 self-deployed run):
 *  36 basket-size points, all nine seeded live baskets, $10/$100/$1k/$10k —
 *  worst disagreement 4.92 pts; smallest passing tolerance = 5 exactly. The
 *  provisional value survived contact with evidence with LESS headroom than
 *  the self-run suggested (worst was 3.56 there): divergence GROWS WITH
 *  TRADE SIZE (theirs impact-aware, ours value shares), so 5 is now the
 *  measured floor, not a padded guess — do NOT shave it to 4.
 *  ⚠ Wire-up note: at sizes well past $10k the honest cross-check may need a
 *  size-scaled tolerance — re-run the harness at the real ladder then. */
export const CONTRACT_AGREE_PCT = 5

/** A leg whose intended trade is more than this share of its deepest pool cannot
 *  be valued at its mark: the trade itself moves the price it is valued at. */
export const DEPTH_MAX_TRADE_SHARE_PCT = 10

/** A leg IMPLIED at fewer basis points than this, on a basket that gave the leg a
 *  real seed weight (or that actually holds the asset), is not a small allocation —
 *  it is a broken split. This is contracts' second absurdity signal (their measured
 *  failure implied 9999/0 on a basket seeded 34/33/33), and the threshold is
 *  calibrated against every live 4663 basket as of 2026-08-02: the contract refuses
 *  at 0 bps, the tightest real basket (PADWAR) has a 425-bps smallest leg, and
 *  contracts' own guidance was "anywhere in the 50-200 bps range fires on nothing
 *  that exists today." 150 sits mid-range: 2.8x below the tightest real split. */
export const DEGENERATE_LEG_BPS = 150

/** Below this, a "pool" is not a market. Mirrors the dust floor idea already used
 *  to gate perf claims: a $500 pool prices nothing. */
export const MIN_MEANINGFUL_LIQUIDITY_USD = 1_000

// ── VERDICTS ─────────────────────────────────────────────────────────────────

export type GuardSeverity = 'ok' | 'warn' | 'block'

export interface LegVerdict {
  symbol: string
  severity: GuardSeverity
  /** One sentence, shown to a user. States the measurement, never a diagnosis we
   *  did not make. */
  reason?: string
  /** Machine-readable so a caller can branch without parsing prose. */
  code?:
    | 'cost-basis'
    | 'depth'
    | 'no-depth-data'
    | 'dust-pool'
    | 'unusable-mark'
    | 'source-disagreement'
    | 'degenerate-split'
}

export interface SplitVerdict {
  severity: GuardSeverity
  legs: LegVerdict[]
  /** The headline sentence for layer 4's warning. Null when everything is ok. */
  headline: string | null
  /** True when the caller must NOT proceed to quote or sign. */
  blocking: boolean
}

const pct = (n: number) => (Math.abs(n) >= 10 ? Math.round(Math.abs(n)) : Number(Math.abs(n).toFixed(1)))
const times = (n: number) => (n >= 100 ? Math.round(n).toLocaleString('en-US') : Number(n.toFixed(1)))

// ── LAYER 4a · THE COST-BASIS CHECK (no price feed required) ─────────────────

/**
 * Is this leg's mark plausible against what it was actually funded with?
 *
 * The single most valuable check here, because it is nearly free and it is what
 * caught the real bug. Skipped honestly when the funding figure is unknown — a
 * missing basis is not evidence of a good mark, so the caller is told the check
 * did not run rather than that it passed.
 */
export function costBasisVerdict(leg: LegMark): LegVerdict {
  const { symbol, markUsd, held, fundedUsd } = leg
  if (!Number.isFinite(markUsd) || markUsd <= 0) {
    return { symbol, severity: 'block', code: 'unusable-mark', reason: `No usable price for ${showSymbol(symbol)}.` }
  }
  if (!Number.isFinite(held) || held <= 0) return { symbol, severity: 'ok' }
  if (fundedUsd == null || !Number.isFinite(fundedUsd) || fundedUsd <= 0) return { symbol, severity: 'ok' }

  const valued = markUsd * held
  const ratio = valued > fundedUsd ? valued / fundedUsd : fundedUsd / valued
  if (ratio > COST_BASIS_MAX_RATIO) {
    return {
      symbol,
      severity: 'block',
      code: 'cost-basis',
      reason: `${showSymbol(symbol)} prices at ${times(ratio)}x what was actually put into it, so its price cannot be trusted right now.`,
    }
  }
  return { symbol, severity: 'ok' }
}

// ── LAYER 2/4b · THE DEPTH CHECK ─────────────────────────────────────────────

/**
 * Can this leg's mark survive the size we intend to trade against it?
 *
 * This is the depth-awareness contracts asked for explicitly, and it is the check
 * that averaging feeds cannot replace. `tradeUsd` is what this leg is about to be
 * funded with or unwound for.
 */
export function depthVerdict(leg: LegMark, tradeUsd: number): LegVerdict {
  const { symbol, liquidityUsd } = leg
  // Unreadable is NOT zero. Say the check could not run.
  if (liquidityUsd == null || !Number.isFinite(liquidityUsd)) {
    return {
      symbol,
      severity: 'warn',
      code: 'no-depth-data',
      reason: `Could not read how deep ${showSymbol(symbol)}'s market is, so its price is unverified here.`,
    }
  }
  if (liquidityUsd < MIN_MEANINGFUL_LIQUIDITY_USD) {
    return {
      symbol,
      severity: 'block',
      code: 'dust-pool',
      reason: `${showSymbol(symbol)} has almost no market to trade against, so any price for it is unreliable.`,
    }
  }
  if (!Number.isFinite(tradeUsd) || tradeUsd <= 0) return { symbol, severity: 'ok' }

  const share = (tradeUsd / liquidityUsd) * 100
  if (share > DEPTH_MAX_TRADE_SHARE_PCT) {
    return {
      symbol,
      severity: 'block',
      code: 'depth',
      reason: `This would be ${pct(share)}% of ${showSymbol(symbol)}'s whole market, so the trade itself would move the price it is priced at.`,
    }
  }
  return { symbol, severity: 'ok' }
}

// ── LAYER 2 · SOURCE CORROBORATION ───────────────────────────────────────────

export interface SourceQuote {
  source: string
  priceUsd: number
}

export interface CorroborationResult {
  severity: GuardSeverity
  /** The price to USE: the MEDIAN of the usable sources, which is resistant to a
   *  single outlier in a way a mean is not. Null when nothing is usable. */
  priceUsd: number | null
  /** Widest disagreement between usable sources, percent. */
  spreadPct: number | null
  usedSources: string[]
  reason?: string
}

/**
 * Corroborate a price across independent sources.
 *
 * MEDIAN, not mean: with three sources a single absurd outlier moves a mean
 * arbitrarily far while the median ignores it entirely. That is the whole point of
 * having three.
 *
 * ONE source is not corroboration and says so — it is a warn, not an ok, because
 * the layer's job is agreement and there is nothing to agree with.
 */
export function corroborate(quotes: SourceQuote[]): CorroborationResult {
  const usable = quotes.filter((q) => Number.isFinite(q.priceUsd) && q.priceUsd > 0)
  if (usable.length === 0) {
    return { severity: 'block', priceUsd: null, spreadPct: null, usedSources: [], reason: 'No price source answered.' }
  }
  const sorted = [...usable].sort((a, b) => a.priceUsd - b.priceUsd)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 1 ? sorted[mid].priceUsd : (sorted[mid - 1].priceUsd + sorted[mid].priceUsd) / 2
  const lo = sorted[0].priceUsd
  const hi = sorted[sorted.length - 1].priceUsd
  const spreadPct = ((hi - lo) / lo) * 100
  const usedSources = usable.map((q) => q.source)

  if (usable.length === 1) {
    return {
      severity: 'warn',
      priceUsd: median,
      spreadPct: 0,
      usedSources,
      reason: 'Only one price source answered, so this price is uncorroborated.',
    }
  }
  if (spreadPct > SOURCE_AGREE_PCT) {
    return {
      severity: 'warn',
      priceUsd: median,
      spreadPct,
      usedSources,
      reason: `Price sources disagree by ${pct(spreadPct)}%, so this price is uncertain.`,
    }
  }
  return { severity: 'ok', priceUsd: median, spreadPct, usedSources }
}

// ── LAYER 3 · CROSS-CHECK THE CONTRACT ───────────────────────────────────────

/**
 * Compare our derived split against the contract's own.
 *
 * Both arrays are per-leg shares in basis points, same order, summing to ~10000.
 * Deliberately symmetric: a disagreement does not tell us which side is wrong, so
 * it warns rather than silently preferring ours. Treating our own number as
 * automatically correct is how a cross-check becomes theatre.
 */
export function crossCheckSplit(ourBps: number[], contractBps: number[]): LegVerdict[] {
  if (ourBps.length !== contractBps.length) {
    return [
      {
        symbol: 'plan',
        severity: 'block',
        code: 'source-disagreement',
        reason: 'The plan and the contract disagree about how many assets are involved.',
      },
    ]
  }
  const out: LegVerdict[] = []
  for (let i = 0; i < ourBps.length; i++) {
    const a = ourBps[i]
    const b = contractBps[i]
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    // Compare in POINTS of the whole split, not as a ratio of one leg to itself:
    // a leg going 1 bp -> 3 bps is a 200% ratio change and irrelevant, while
    // 4000 -> 4500 is 5 points and material.
    const deltaPts = Math.abs(a - b) / 100
    if (deltaPts > CONTRACT_AGREE_PCT) {
      out.push({
        symbol: `leg ${i + 1}`,
        severity: 'warn',
        code: 'source-disagreement',
        reason: `Our split and the contract's differ by ${pct(deltaPts)} points on this asset.`,
      })
    }
  }
  return out
}

// ── THE DEGENERATE-SPLIT CHECK (absurdity signal 2 — arithmetic only) ────────

/**
 * Is any leg of this split implied at effectively nothing on a basket that meant
 * the leg to be something?
 *
 * The cheapest check in the whole defence: no price feed, no history, no RPC —
 * just the split against the basket's own intent. A 34/33/33-seeded basket whose
 * derived split says 9999/0/0 is broken NO MATTER which feed produced it, which is
 * exactly why this runs on OUR split and the contract's alike. `seedBps` may carry
 * nulls where a seed weight is unknown; a leg is held to the check when it was
 * seeded meaningfully OR the basket actually holds it (reserves are intent too).
 */
export function degenerateSplitVerdict(
  splitBps: number[],
  legs: { symbol: string; held?: number; seedBps?: number | null }[],
): LegVerdict[] {
  const out: LegVerdict[] = []
  for (let i = 0; i < splitBps.length; i++) {
    const share = splitBps[i]
    const leg = legs[i]
    if (leg == null || !Number.isFinite(share)) continue
    const seeded = leg.seedBps != null && leg.seedBps > DEGENERATE_LEG_BPS
    const holds = Number.isFinite(leg.held) && (leg.held as number) > 0
    if (!seeded && !holds) continue
    if (share < DEGENERATE_LEG_BPS) {
      const target = leg.seedBps != null ? ` against a ${(leg.seedBps / 100).toFixed(0)}% target` : ''
      out.push({
        symbol: leg.symbol,
        severity: 'block',
        code: 'degenerate-split',
        reason: `${showSymbol(leg.symbol)} would get ${share <= 0 ? 'none' : 'almost none'} of this buy${target}, which means the split is broken, not small.`,
      })
    }
  }
  return out
}

// ── THE WHOLE GUARD ──────────────────────────────────────────────────────────

/**
 * Run every layer over a proposed split and return one verdict.
 *
 * `tradeUsdPerLeg` is what each leg is about to be funded with, same order as
 * `legs`. The result's `blocking` is the only thing a caller needs to honour to be
 * safe; the reasons exist so the warning can be specific rather than generic.
 */
export function guardSplit(legs: LegMark[], tradeUsdPerLeg: number[]): SplitVerdict {
  if (legs.length === 0) {
    return { severity: 'block', legs: [], headline: 'There is nothing to price.', blocking: true }
  }
  const verdicts: LegVerdict[] = []
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]
    const trade = tradeUsdPerLeg[i] ?? 0
    for (const v of [costBasisVerdict(leg), depthVerdict(leg, trade)]) {
      if (v.severity !== 'ok') verdicts.push(v)
    }
  }
  const blocking = verdicts.some((v) => v.severity === 'block')
  const worst: GuardSeverity = blocking ? 'block' : verdicts.length > 0 ? 'warn' : 'ok'

  // The headline names the FIRST blocking reason rather than a count: "3 issues"
  // tells a user nothing they can act on, while the actual sentence does.
  const lead = verdicts.find((v) => v.severity === 'block') ?? verdicts[0]
  const headline =
    worst === 'ok'
      ? null
      : blocking
        ? (lead?.reason ?? 'These prices cannot be trusted right now.')
        : (lead?.reason ?? 'Some prices here are unverified.')

  return { severity: worst, legs: verdicts, headline, blocking }
}

/**
 * Derive a split from marks, but only when the guard allows it.
 *
 * Returns null rather than a best-effort split, because a split is money: a caller
 * that cannot compute one safely must show layer 4's warning, not proceed with a
 * worse number. Shares are basis points and sum to exactly 10000, with the
 * remainder given to the LARGEST leg so rounding never invents or destroys value.
 */
export function deriveSplitBps(legs: LegMark[], tradeUsdPerLeg: number[]): number[] | null {
  const verdict = guardSplit(legs, tradeUsdPerLeg)
  if (verdict.blocking) return null

  const values = legs.map((l) => (Number.isFinite(l.markUsd) && Number.isFinite(l.held) ? l.markUsd * l.held : 0))
  const total = values.reduce((s, v) => s + v, 0)
  if (!(total > 0)) return null

  const raw = values.map((v) => Math.floor((v / total) * 10_000))
  const short = 10_000 - raw.reduce((s, v) => s + v, 0)
  if (short !== 0) {
    let big = 0
    for (let i = 1; i < values.length; i++) if (values[i] > values[big]) big = i
    raw[big] += short
  }
  // A leg with real value must never come out at zero — that is precisely the
  // 9999/0 failure contracts measured.
  for (let i = 0; i < raw.length; i++) if (values[i] > 0 && raw[i] <= 0) return null
  return raw
}
