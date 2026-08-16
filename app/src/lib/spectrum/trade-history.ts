import { foldFlows, type PnlPosition, type SwapFlow } from './pnl'

// ─────────────────────────────────────────────────────────────────────────────
// TRADE HISTORY — the accountant's artifact (the owner 2026-08-11).
//
// pnl.ts answers "what is this position worth against what I paid". It answers
// it with a FOLD: one running {cost, shares, realized} per basket. That is the
// right shape for a card and the wrong shape for anything an accountant reads,
// because a fold discards the individual disposals — and a gains report IS a
// list of disposals: on this date, this many shares left, for these proceeds,
// against this much basis.
//
// So this module REPLAYS the same flows the fold consumes and records each
// step. It deliberately reuses pnl.ts's own arithmetic rather than
// reimplementing it: `replay` steps one flow at a time through foldFlows, so
// the totals in the export and the totals on the page come from ONE
// implementation. If they ever disagree, they disagree because the data
// differs — never because two copies of the maths drifted. (The invariant is
// pinned in the tests: replaying N flows one-at-a-time ends exactly where
// folding them in one call ends.)
//
// ⚠ WHAT THIS IS NOT. Average-cost pooling, over trades through THIS
// protocol's router only. That is Section-104-shaped (UK) and is NOT the US
// FIFO/specific-identification method; holding periods cannot be derived from
// a pool at all. Coverage gaps are structural, not bugs — see EXPORT_CAVEATS,
// which the CSV prints on the document itself rather than hiding in a tooltip.
// This is raw material for a human who knows the rules, never a filing.
// ─────────────────────────────────────────────────────────────────────────────

/** Settlement units are 6dp — the protocol's dollar. */
const USD6 = 1_000_000
/** Basket shares are 18dp. */
const SHARE_DECIMALS = 18

/** raw 6dp settlement → dollars, as a NUMBER only at the display boundary. */
export const usd6ToNumber = (raw: bigint): number => Number(raw) / USD6

/** raw 18dp shares → a decimal string, never a float: 18 significant digits do
 *  not survive Number, and a share count in an accounting document must be
 *  exact. */
export function sharesToString(raw: bigint): string {
  const neg = raw < 0n
  const v = neg ? -raw : raw
  const base = 10n ** BigInt(SHARE_DECIMALS)
  const whole = v / base
  const frac = (v % base).toString().padStart(SHARE_DECIMALS, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

export type TradeKind = 'buy' | 'sell' | 'sell-eth'

export interface TradeRow {
  /** Block time, seconds. Null when the timestamp could not be resolved — the
   *  row still exports, dated 'unknown', because dropping a real disposal to
   *  hide a missing date would understate the gains. */
  ts: number | null
  chainId: number
  /** The basket traded, lowercase. */
  basket: string
  kind: TradeKind
  /** Shares acquired (buy) or disposed (sell), always positive, exact. */
  shares: string
  /** Buy: what was paid. Sell: the proceeds. Null when the sale's proceeds
   *  could not be priced (an ETH-out sale on a chain with no feed) — the
   *  disposal is real and is listed, with the price stated as unknown. */
  settlementUsd: number | null
  /** Sells only: the pooled basis this disposal consumed. */
  basisUsd: number | null
  /** Sells only: proceeds − basis. Null exactly when settlementUsd is. */
  realizedUsd: number | null
  /** True when the pool did NOT cover the whole disposal — shares that arrived
   *  by transfer or in-kind mint carry no basis here, so part of the sale
   *  books nothing. The single most important caveat on any individual row. */
  partiallyCovered: boolean
  /** Pool state AFTER this trade — the running position, so a reader can
   *  reconcile the list against the balance without re-deriving it. */
  sharesAfter: string
  basisAfterUsd: number
  txHash?: string
  blockNumber?: string
}

export interface TradeHistory {
  rows: TradeRow[]
  /** Realized totals over the rows in range — the number a reader came for. */
  realizedUsd: number
  /** Disposals whose proceeds could not be priced. Their realized figure is
   *  NOT in `realizedUsd`, and the document says how many are missing rather
   *  than quietly reporting a smaller number. */
  unpricedDisposals: number
  /** Disposals the pool only partly covered. */
  partiallyCoveredDisposals: number
}

/** The pool state this module reports, per basket. */
type Pools = Record<string, PnlPosition>

const ZERO: PnlPosition = { cost: '0', shares: '0', realized: '0' }

/**
 * Replay flows into dated rows, stepping the REAL fold one trade at a time.
 *
 * `flows` must be in chain order (the scan returns them so). `timeOf` resolves
 * a block to seconds; it may return null, and a null date never drops a row.
 */
export function buildTradeHistory(
  chainId: number,
  flows: readonly SwapFlow[],
  timeOf: (block: bigint) => number | null,
  opts: { fromMs?: number; toMs?: number } = {},
): TradeHistory {
  let pools: Pools = {}
  const rows: TradeRow[] = []

  for (const f of flows) {
    const key = f.basket.toLowerCase()
    const before = pools[key] ?? ZERO
    // ONE STEP OF THE REAL FOLD — never a second implementation of the maths.
    pools = foldFlows(pools, [f])
    const after = pools[key] ?? ZERO

    const ts = f.blockNumber != null ? timeOf(f.blockNumber) : null
    const kind: TradeKind = f.kind === 'sellEth' ? 'sell-eth' : f.kind

    let shares: bigint
    let settlementUsd: number | null
    let basisUsd: number | null = null
    let realizedUsd: number | null = null
    let partiallyCovered = false

    if (f.kind === 'buy') {
      shares = f.amountOut
      settlementUsd = usd6ToNumber(f.amountIn)
    } else {
      shares = f.amountIn
      // What the pool actually gave up is the difference the fold booked —
      // read it back rather than recomputing, so rounding cannot diverge.
      const basisRaw = BigInt(before.cost) - BigInt(after.cost)
      const realizedRaw = BigInt(after.realized) - BigInt(before.realized)
      const coveredRaw = BigInt(before.shares) - BigInt(after.shares)
      partiallyCovered = coveredRaw < f.amountIn
      basisUsd = usd6ToNumber(basisRaw)
      if (f.kind === 'sell') {
        settlementUsd = usd6ToNumber(f.amountOut)
        realizedUsd = usd6ToNumber(realizedRaw)
      } else if (f.proceedsUsd6 != null) {
        settlementUsd = usd6ToNumber(f.proceedsUsd6)
        realizedUsd = usd6ToNumber(realizedRaw)
      } else {
        // an ETH-out sale with no feed: the disposal HAPPENED and the basis
        // left with the shares, but no price exists to book against it
        settlementUsd = null
        realizedUsd = null
      }
    }

    rows.push({
      ts,
      chainId,
      basket: key,
      kind,
      shares: sharesToString(shares),
      settlementUsd,
      basisUsd,
      realizedUsd,
      partiallyCovered,
      sharesAfter: sharesToString(BigInt(after.shares)),
      basisAfterUsd: usd6ToNumber(BigInt(after.cost)),
      ...(f.txHash != null ? { txHash: f.txHash } : {}),
      ...(f.blockNumber != null ? { blockNumber: f.blockNumber.toString() } : {}),
    })
  }

  // The window filters the REPORT, never the replay: basis is cumulative, so a
  // disposal in range must consume the pool every earlier buy built. Filtering
  // the flows instead would price this year's sales against no basis at all.
  const inRange = rows.filter((r) => {
    if (opts.fromMs == null && opts.toMs == null) return true
    if (r.ts == null) return true // undated rows are never silently dropped
    const ms = r.ts * 1000
    return (opts.fromMs == null || ms >= opts.fromMs) && (opts.toMs == null || ms <= opts.toMs)
  })

  const disposals = inRange.filter((r) => r.kind !== 'buy')
  return {
    rows: inRange,
    realizedUsd: disposals.reduce((t, r) => t + (r.realizedUsd ?? 0), 0),
    unpricedDisposals: disposals.filter((r) => r.realizedUsd == null).length,
    partiallyCoveredDisposals: disposals.filter((r) => r.partiallyCovered).length,
  }
}

/** Merge a group's per-wallet flow lists (one chain) into the ONE stream the
 *  shared replay consumes — in CHAIN order, because the group shares one pool
 *  per basket. Wallet-after-wallet concatenation replayed A's whole history
 *  before B's first trade, booking each disposal against a pool missing every
 *  buy that chronologically preceded it (audit 2026-08-12). The sort is
 *  stable: a same-block tie keeps wallet order, and a flow with no block —
 *  undatable — replays after everything datable, matching where the display
 *  sends undated rows. */
export function mergeGroupFlows(perWallet: readonly (readonly SwapFlow[])[]): SwapFlow[] {
  return perWallet.flat().sort((a, b) => {
    if (a.blockNumber == null) return b.blockNumber == null ? 0 : 1
    if (b.blockNumber == null) return -1
    return a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0
  })
}

/** Merge per-chain histories into one dated timeline (newest last, the order a
 *  ledger reads in). Undated rows sort to the end rather than to 1970. */
export function mergeHistories(parts: readonly TradeHistory[]): TradeHistory {
  const rows = parts.flatMap((p) => p.rows).sort((a, b) => {
    if (a.ts == null) return 1
    if (b.ts == null) return -1
    return a.ts - b.ts
  })
  return {
    rows,
    realizedUsd: parts.reduce((t, p) => t + p.realizedUsd, 0),
    unpricedDisposals: parts.reduce((t, p) => t + p.unpricedDisposals, 0),
    partiallyCoveredDisposals: parts.reduce((t, p) => t + p.partiallyCoveredDisposals, 0),
  }
}

/**
 * THE CAVEATS, printed ON the document (never a tooltip).
 *
 * Every line here is a structural property of how the basis is derived, not a
 * defect list. A reader who files against this without knowing them would be
 * misled, so they travel with the numbers.
 */
export const EXPORT_CAVEATS: readonly string[] = [
  'METHOD: average cost. Each basket has ONE pool; a sale consumes basis in proportion to the shares sold. This resembles UK Section 104 pooling. It is NOT US FIFO or specific identification, and holding periods (long vs short term) CANNOT be derived from a pool.',
  'COVERAGE: only trades made through this protocol’s own router are here. Shares that arrived by wallet transfer, by an in-kind mint, or bought anywhere else carry no cost here and are excluded from the basis.',
  'A sale of shares the pool does not fully cover books gains only on the covered part. Those rows are marked "partial".',
  'Buys paid in ETH through the router’s ETH entrypoint are NOT recorded: the event carries wei, and the dollar cost of the shares is not knowable from it. Those shares hold no basis here.',
  'A sale paid out in ETH is priced at the block it happened in, using that chain’s ETH/USD feed. Where no feed exists the disposal is listed with its proceeds and gain stated as unknown — never guessed.',
  'Chains without a private RPC endpoint serve no history at all; this document covers only the networks listed above.',
  'When linked wallets are exported together, each basket keeps ONE pool across ALL of the group’s wallets: flows merge in block order and the average cost is taken over the merged history, not per wallet.',
  'Amounts are as recorded on chain. Nothing here is tax advice, and no figure is a filing — this is the raw material for someone who knows your jurisdiction’s rules.',
]
