import { SUPPORTED_CHAIN_IDS } from '../chain/chains'

// ─────────────────────────────────────────────────────────────────────────────
// MONEY BY CHAIN (the owner 2026-08-06 12:53: "a breakdown of how much money I have
// on each chain… instead of saying the chain name, you have the logo").
//
// React-free on purpose: this sits on a money path, so it has to be drivable
// from outside a component (the lane's standing rule) and it carries the two
// honesty gates the hero's sentence depends on:
//
//   · A CHAIN THAT DID NOT ANSWER IS NOT A CHAIN WITH NOTHING ON IT. A failed
//     sweep renders as "couldn't read", never as $0 — the lie a bare zero tells
//     here is "you hold nothing on Base", which is the one sentence a portfolio
//     must never invent. (The read-failed law, applied per lie: only the failed
//     chain's own figure is withheld; the chains that answered still show.)
//   · AN UNPRICED HOLDING MAKES ITS CHAIN'S FIGURE A FLOOR, not a total. The
//     exposure rows only carry priced value, so a chain holding something with
//     no readable price is understated by exactly that much — the row says so
//     rather than presenting a short number as the whole.
//
// The universe is the SAME one the hero's total and the tier bar count (the
// combined exposure rows), so the parts add up to the whole by construction.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChainTotalRow {
  chainId: number
  /** Priced value on this chain. 0 when the chain failed — read `state` first. */
  usd: number
  /** ok = fully read · partial = read, but something on it has no price ·
   *  failed = the sweep for this chain did not answer at all. */
  state: 'ok' | 'partial' | 'failed'
}

interface ValuedAsset {
  chainId: number
  valueUsd: number
}

/** Money per chain, biggest first, failed chains last.
 *
 *  A chain appears when it holds readable value OR when its read failed (the
 *  second is the whole point — silence has to be visible). A chain that simply
 *  holds nothing is left out: a row of $0 for a network the owner has never
 *  touched is noise, not a fact worth the width. */
export function chainTotals(
  assets: readonly ValuedAsset[],
  opts: { failedChainIds?: readonly number[]; unpricedChainIds?: readonly number[] } = {},
): ChainTotalRow[] {
  const failed = new Set(opts.failedChainIds ?? [])
  const unpriced = new Set(opts.unpricedChainIds ?? [])
  const sums = new Map<number, number>()
  for (const a of assets) {
    // Finite-gate at the boundary: one NaN or Infinity valueUsd would otherwise
    // poison its chain's whole figure (and every share derived from it). A
    // clamp guards range, not readability — so this gate is the readability one.
    if (!Number.isFinite(a.valueUsd) || a.valueUsd <= 0) continue
    if (!Number.isFinite(a.chainId)) continue
    // A chain that failed contributes nothing readable, even if a stale row for
    // it survived into this list — its figure is withheld, not half-built.
    if (failed.has(a.chainId)) continue
    sums.set(a.chainId, (sums.get(a.chainId) ?? 0) + a.valueUsd)
  }

  const rows: ChainTotalRow[] = []
  for (const [chainId, usd] of sums) {
    if (usd <= 0.005) continue
    rows.push({ chainId, usd, state: unpriced.has(chainId) ? 'partial' : 'ok' })
  }
  for (const chainId of failed) {
    if (!Number.isFinite(chainId)) continue
    rows.push({ chainId, usd: 0, state: 'failed' })
  }

  // Biggest money first; failed chains sink to the end (they carry no figure to
  // rank on, and the eye should reach the real numbers first). Ties settle on
  // the app's own chain order so the row never reshuffles between reads.
  const order = (id: number) => {
    const i = SUPPORTED_CHAIN_IDS.indexOf(id)
    return i === -1 ? SUPPORTED_CHAIN_IDS.length : i
  }
  return rows.sort((a, b) => {
    if (a.state === 'failed' !== (b.state === 'failed')) return a.state === 'failed' ? 1 : -1
    if (b.usd !== a.usd) return b.usd - a.usd
    return order(a.chainId) - order(b.chainId)
  })
}

/** The chains holding something the price feed could not answer for — the
 *  `partial` input above. Derived from the raw book (which keeps unpriced rows)
 *  rather than the exposure rows (which drop them by design). */
export function unpricedChainIds(holdings: readonly { chainId: number; usd: number | null }[]): number[] {
  const out = new Set<number>()
  for (const h of holdings) if (h.usd == null && Number.isFinite(h.chainId)) out.add(h.chainId)
  return [...out]
}
