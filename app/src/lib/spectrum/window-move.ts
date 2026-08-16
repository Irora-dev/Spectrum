import type { NavPoint } from './basket-data'

// ─────────────────────────────────────────────────────────────────────────────
// WINDOW MOVE — the movers strip following the chart's time window (the 2106
// board's last named item: "pill-based winners/losers per 24h/7d/30d").
//
// React-free (house law). The 24h strip keeps its live market-change source;
// this module answers the 7D/30D case from the SAME per-asset history series
// the hero chart already fetched — constant-quantity semantics, the chart's
// own story: "past" is today's position valued at the window's open
// (valueUsd / ratio), so the strip and the curve can never disagree about
// what a window did.
//
// HONESTY: a series that cannot state a ratio (absent, one point, zero or
// unreadable first value, non-finite ratio) makes the position UNREADABLE —
// counted and named, never guessed. Every emitted number passes a finite
// gate (the clamp law: NaN/Infinity must never reach a pill).
// ─────────────────────────────────────────────────────────────────────────────

export interface WindowMoveRow {
  /** The key's dominant symbol — what the pill wears. */
  symbol: string
  /** Signed dollars this position moved over the window. */
  usd: number
}

export interface WindowMove {
  rows: WindowMoveRow[]
  totalUsd: number
  unreadable: number
  /** Who could not be read — the tooltip's honesty list. */
  unreadableSyms: string[]
}

/** One plan row as the caller assembled it: the fetch key's dollars and the
 *  symbol that speaks for it (the highest-value contributor, same rule the
 *  bento's merge uses). */
export interface WindowMoveInput {
  key: string
  symbol: string
  valueUsd: number
}

export function computeWindowMove(
  inputs: WindowMoveInput[],
  seriesByKey: Map<string, NavPoint[]>,
): WindowMove {
  const rows: WindowMoveRow[] = []
  let unreadable = 0
  const unreadableSyms: string[] = []
  for (const it of inputs) {
    if (!(it.valueUsd > 0.005)) continue
    const s = seriesByKey.get(it.key)
    const first = s && s.length >= 2 ? s[0].value : null
    const last = s && s.length >= 2 ? s[s.length - 1].value : null
    const ratio = first != null && last != null && first > 0 ? last / first : null
    if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) {
      unreadable++
      unreadableSyms.push(it.symbol)
      continue
    }
    const usd = it.valueUsd - it.valueUsd / ratio
    if (!Number.isFinite(usd)) {
      unreadable++
      unreadableSyms.push(it.symbol)
      continue
    }
    if (Math.abs(usd) > 0.005) rows.push({ symbol: it.symbol, usd })
  }
  rows.sort((x, y) => Math.abs(y.usd) - Math.abs(x.usd))
  return { rows, totalUsd: rows.reduce((t, r) => t + r.usd, 0), unreadable, unreadableSyms }
}
