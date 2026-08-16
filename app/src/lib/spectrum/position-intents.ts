import { assetKey, MAX_ALLOCATION_ASSETS, type AllocAsset, type AllocTarget } from './allocation'
import { CASH_SYMBOLS } from './market-tiers'

// ─────────────────────────────────────────────────────────────────────────────
// POSITIONS MODE — the pure intent composer (recording 13:00: the viewport-
// takeover where you see your positions and queue per-position actions).
// React-free per the purity law; the UI lives in components/PositionsMode.tsx.
//
// The mode composes INTENTS (sell $X of A · buy $Y of B) and folds them into
// the ONE pipeline (blend law): a target mix + deployed amount handed to the
// flow's review, where the channel checkout already lives. No databases —
// intents exist only in memory until they become the flow's device-local
// draft.
//
// SIMULATED-phase honesty: the resulting weights describe the mix AFTER the
// queued changes as a share of resulting value. Real sell-funds-buy settlement
// is Phase 3's batchRebalance (sells settle buys, one tx per chain); nothing
// here claims funds move.
// ─────────────────────────────────────────────────────────────────────────────

export interface PositionRow {
  asset: AllocAsset
  /** Current readable value (USD). Unpriced positions never enter the mode's
   *  math — they are visible on the page, never traded blind. */
  valueUsd: number
  /** Share of the readable total, 0–100 (display only). */
  pct: number
  /** WHAT THIS POSITION IS (the owner's ruling 2026-08-02: "a basket is a position
   *  you hold; its contents are exposure you carry"). A basket trades as ONE
   *  unit — trimming it sells shares through the redeem path, never its legs.
   *  Absent = a directly-held token. */
  kind?: 'token' | 'basket'
  /** A basket's legs — shown when the row expands (the LINK layer). Display
   *  only: they are exposure, never draggable. */
  contents?: { symbol: string; address: string; chainId: number; weightPct: number }[]
  /** Invested cost basis for this position where KNOWN (baskets via the pnl
   *  index). Feeds the trim receipt (feature 4); absent = no receipt, never
   *  a guessed basis. */
  investedUsd?: number
  /** Token decimals and the whole-token amount actually held, straight from the
   *  chain read. Carried so a SELL can be expressed as an EXACT raw amount — a
   *  proportion of a known holding — rather than reconstructed from a USD figure
   *  and a price, which would round money. Absent on anything unpriced. */
  decimals?: number
  amount?: number
  /** WHO HOLDS IT, per linked-group member, biggest first (recording 1205 —
   *  the execution flow names each asset's wallet). Display + run-splitting;
   *  absent = single wallet or unattributable, today's behavior exactly. */
  heldBy?: { owner: string; usd: number }[]
}

export type PositionIntentKind = 'sell' | 'buy'

export interface PositionIntent {
  kind: PositionIntentKind
  asset: AllocAsset
  /** USD size of the action. Sells are clamped to the position's value at
   *  compose time — never oversold. */
  usd: number
}

export interface ComposedRebalance {
  /** The mix AFTER the queued changes, as integer weights summing 100. */
  targets: AllocTarget[]
  /** Gross buys — what the flow's plan deploys as legs (its amountUsd). */
  amountUsd: number
  /** Sells total — carried into the draft as funding.soldUsd (PM audit 2:
   *  the sell side must survive the handoff, never discarded). */
  soldUsd: number
  /** Buys total. */
  boughtUsd: number
  /** Buys beyond what sells AND drawn cash cover — the money the review asks
   *  the user to bring (PM proof-audit K2: cash coverage is COMPOSED now, not
   *  surface-display math). */
  newMoneyUsd: number
  /** Cash the buys drew out of held stables (composed as cash sells). */
  cashDrawUsd: number
  /** Unspent trim proceeds credited to the largest held stable. */
  cashCreditUsd: number
  /** Trim proceeds had no held stable to land in — the UI words it; the
   *  funding record still carries the sells for real wiring. */
  cashless: boolean
  /** Whether the flow can execute this composition, with the honest reason
   *  when it can't (PM audit 3: >12 legs silently truncated at load; 2c:
   *  all-sell dead-ended silently). Refusals get WORDS, never dead buttons. */
  executable: boolean
  reason?: 'too-many-legs' | 'full-exit' | 'empty'
}

/** Largest-remainder rounding to integer weights summing exactly 100, every
 *  surviving leg ≥1 (the flow's own doctrine). */
function toWeights(values: { asset: AllocAsset; usd: number }[]): AllocTarget[] {
  const kept = values.filter((v) => v.usd > 0.005)
  const total = kept.reduce((s, v) => s + v.usd, 0)
  if (kept.length === 0 || total <= 0) return []
  const raw = kept.map((v) => ({ asset: v.asset, exact: (v.usd / total) * 100 }))
  const floored = raw.map((r) => ({ asset: r.asset, weight: Math.max(1, Math.floor(r.exact)), frac: r.exact - Math.floor(r.exact) }))
  let sum = floored.reduce((s, f) => s + f.weight, 0)
  const order = [...floored].sort((a, b) => b.frac - a.frac)
  let i = 0
  while (sum < 100 && order.length > 0) {
    order[i % order.length].weight += 1
    sum++
    i++
  }
  // Shave deterministically, smallest-fraction first; stop cleanly when no
  // candidate above the 1-floor remains (PM audit 3: the old i>1000 bailout
  // could exit with sum ≠ 100 — callers now also refuse >MAX legs upstream,
  // where min-1-each makes 100 impossible anyway).
  while (sum > 100) {
    const cand = [...order].reverse().find((f) => f.weight > 1)
    if (!cand) break
    cand.weight -= 1
    sum--
  }
  return floored.map(({ asset, weight }) => ({ asset, weight }))
}

/** Fold queued intents over current positions → the flow-ready result.
 *  CASH IS COMPOSED (PM proof-audit K2 — the pile was display-only and the
 *  output contradicted the mode's promise): buys beyond trim proceeds DRAW
 *  from held stables (a composed cash sell, proportional); unspent proceeds
 *  CREDIT the largest held stable. No stable held → `cashless` (worded by
 *  the UI, sells still recorded for real wiring). */
export function composeRebalance(
  positions: PositionRow[],
  intents: PositionIntent[],
  opts: { cashSymbols?: Set<string> } = {},
): ComposedRebalance {
  const cashSyms = opts.cashSymbols ?? CASH_SYMBOLS
  // NOTHING UNREADABLE ENTERS THE ARITHMETIC (audit round 5, 2026-08-04): a
  // NaN in one position value or one intent amount propagated through every
  // sum into `amountUsd` — the figure the review SHOWS and the confirm GATES
  // ON — and `NaN == null` is false, so the amount-set gate would have passed
  // it. A position whose value did not read is not tradeable and a NaN intent
  // is not an instruction; both are dropped here, where the money math starts.
  const num = (n: number) => (Number.isFinite(n) ? n : 0)
  const byKey = new Map<string, { asset: AllocAsset; usd: number }>()
  for (const p of positions) {
    if (!Number.isFinite(p.valueUsd)) continue // unreadable ≠ zero ≠ tradeable
    byKey.set(assetKey(p.asset), { asset: p.asset, usd: p.valueUsd })
  }

  let soldUsd = 0
  let boughtUsd = 0
  for (const it of intents) {
    const key = assetKey(it.asset)
    const cur = byKey.get(key)
    if (it.kind === 'sell') {
      if (!cur) continue // nothing held — an unfillable sell composes to nothing
      const take = Math.min(cur.usd, Math.max(0, num(it.usd)))
      cur.usd -= take
      soldUsd += take
    } else {
      const add = Math.max(0, num(it.usd))
      if (add === 0) continue
      if (cur) cur.usd += add
      else byKey.set(key, { asset: it.asset, usd: add })
      boughtUsd += add
    }
  }

  // ── the cash legs ──────────────────────────────────────────────────────────
  const cashRows = [...byKey.values()].filter((r) => cashSyms.has(r.asset.symbol.toUpperCase()))
  let cashDrawUsd = 0
  let cashCreditUsd = 0
  let cashless = false
  if (boughtUsd > soldUsd) {
    const need = boughtUsd - soldUsd
    const cashHeld = cashRows.reduce((s, r) => s + r.usd, 0)
    cashDrawUsd = Math.min(need, cashHeld)
    if (cashDrawUsd > 0) {
      // proportional draw across held stables — a composed SELL of cash
      for (const r of cashRows) {
        const share = (r.usd / cashHeld) * cashDrawUsd
        r.usd -= share
      }
      soldUsd += cashDrawUsd
    }
  } else if (soldUsd > boughtUsd) {
    const leftover = soldUsd - boughtUsd
    const biggest = cashRows.sort((a, b) => b.usd - a.usd)[0]
    if (biggest) {
      biggest.usd += leftover // trim proceeds land in the pile (composed BUY of cash)
      cashCreditUsd = leftover
    } else {
      cashless = true // no stable to receive it — the UI says so in words
    }
  }

  const targets = toWeights([...byKey.values()])
  const round2 = (n: number) => Math.round(n * 100) / 100
  let executable = true
  let reason: ComposedRebalance['reason']
  if (targets.length === 0) {
    executable = false
    reason = soldUsd > 0 ? 'full-exit' : 'empty'
  } else if (targets.length > MAX_ALLOCATION_ASSETS) {
    // the flow's loader hard-slices at MAX (sanitizeTargets) — composing more
    // would silently drop an asset and wedge the 100% gate (PM audit 3)
    executable = false
    reason = 'too-many-legs'
  }
  return {
    targets,
    // NET new money — what the review asks the user to bring (buys beyond
    // trims + drawn cash); the gross-buys figure rides funding.grossBuysUsd
    // for the fee line (fees charge the BUY side of the diff).
    amountUsd: round2(Math.max(0, boughtUsd - soldUsd)),
    soldUsd: round2(soldUsd),
    boughtUsd: round2(boughtUsd),
    newMoneyUsd: round2(Math.max(0, boughtUsd - soldUsd)),
    cashDrawUsd: round2(cashDrawUsd),
    cashCreditUsd: round2(cashCreditUsd),
    cashless,
    executable,
    reason,
  }
}

/**
 * ONE CARD PER ASSET — the reshape board's held book joined with the session's
 * fresh picks.
 *
 * THIS IS A MONEY GUARD, not a display one, which is how it was found. the owner
 * hit it live (2026-08-06): dialling a basket "makes a ton of bento asset tiles
 * for the one basket asset". The board concatenated two lists that can contain
 * the same asset, and every consumer downstream read it twice — including the
 * DELTAS, which is where it stops being cosmetic:
 *
 *   held copy   → delta = target − valueUsd   (a SELL)
 *   fresh copy  → delta = target − 0          (a BUY of the same asset)
 *
 * Both share one `assetKey`, so both read the same target and the plan composed
 * a sell AND a buy of the same position — inflating gross buys, which is the
 * base the fee is charged on. A duplicate here is not a repeated tile, it is a
 * repeated instruction.
 *
 * HELD WINS: a real position carries its true value, a fresh entry is a $0
 * placeholder for something not yet owned. Collapsing the other way would zero
 * a held position on the board.
 */
export function mergeBoardCards<A extends { chainId: number; address: string }>(
  positions: readonly { asset: A; valueUsd: number; pct: number }[],
  fresh: readonly A[],
  keyOf: (a: A) => string,
  skip: (a: A) => boolean = () => false,
): { p: { asset: A; valueUsd: number; pct: number }; isNew: boolean }[] {
  const byKey = new Map<string, { p: { asset: A; valueUsd: number; pct: number }; isNew: boolean }>()
  for (const p of positions) {
    if (skip(p.asset)) continue
    byKey.set(keyOf(p.asset), { p, isNew: false })
  }
  for (const asset of fresh) {
    const k = keyOf(asset)
    if (byKey.has(k)) continue
    byKey.set(k, { p: { asset, valueUsd: 0, pct: 0 }, isNew: true })
  }
  return [...byKey.values()]
}
