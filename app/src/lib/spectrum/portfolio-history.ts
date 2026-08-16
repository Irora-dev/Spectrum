import { chainCfg } from '../chain/chains'
import { combineNavHistory, type NavInput } from './history'
import type { NavPoint } from './basket-data'

// ─────────────────────────────────────────────────────────────────────────────
// Portfolio value history — pure planning + combination (React-free, same law
// as exposure.ts / raw-holdings.ts: the hook wrapper lives in
// use-portfolio-history.ts).
//
// The curve is the wallet's CURRENT combined mix valued through real per-asset
// price history: value(t) = totalNow · Σᵢ shareᵢ · priceᵢ(t)/priceᵢ(t₀),
// anchored so the final point equals today's readable total. It shows how the
// mix you hold now has moved — it is NOT flows-aware cost-basis PnL (that
// stays pnl.ts's job, and only for router-traded baskets). The chart's ⓘ says
// exactly this.
//
// Honesty rules carried through:
//   · an asset with no readable history contributes NO movement and is
//     EXCLUDED from coverage — never flattened in silently. The host shows
//     coveragePct when it is short of the whole.
//   · native ETH (the 0xeee… sentinel) has no feed identity; it is remapped
//     to the chain's canonical WETH for history only — same asset price-wise.
//   · keys are `${chainId}:${address}` so the same address on two chains
//     (OP-stack WETH, bridged USDC) can never collide in the series map.
// ─────────────────────────────────────────────────────────────────────────────

export interface PortfolioHistoryAsset {
  chainId: number
  address: string
  valueUsd: number
  /** Optional: lets the plan name each fetch key (window-move pills). */
  symbol?: string
}

export interface HistoryFetch {
  /** `${chainId}:${lowercased history address}` — series-map + NavInput key. */
  key: string
  chainId: number
  address: string
  /** The key's DOMINANT contributor's symbol (largest single valueUsd) —
   *  natives folded into WETH wear whichever side is bigger, the same rule
   *  the bento's merge speaks by. Absent when no caller supplied symbols. */
  symbol?: string
}

export interface PortfolioHistoryPlan {
  fetches: HistoryFetch[]
  /** combineNavHistory inputs — address carries the composite key. */
  inputs: NavInput[]
  /** USD the planned fetches represent (the cap can drop a small tail). */
  plannedUsd: number
  /** USD of every positively-valued asset handed in. */
  totalUsd: number
}

const NATIVE_KEY = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

/** Price-history calls are real API weight — track the top N by value and let
 *  coveragePct state what the curve leaves out. */
export const PORTFOLIO_HISTORY_CAP = 12

/** The chain's WETH identity for pricing native ETH — env-populated in the
 *  app; injectable so the planner stays pure under test. */
function defaultWethFor(chainId: number): string | undefined {
  try {
    return chainCfg(chainId)?.weth ?? undefined
  } catch {
    return undefined
  }
}

export function planPortfolioHistory(
  assets: PortfolioHistoryAsset[],
  cap = PORTFOLIO_HISTORY_CAP,
  wethFor: (chainId: number) => string | undefined = defaultWethFor,
): PortfolioHistoryPlan {
  const priced = assets.filter((a) => a.valueUsd > 0)
  const totalUsd = priced.reduce((s, a) => s + a.valueUsd, 0)
  const top = [...priced].sort((a, b) => b.valueUsd - a.valueUsd).slice(0, cap)

  const byKey = new Map<string, HistoryFetch & { usd: number; topUsd: number }>()
  for (const a of top) {
    let addr = a.address.toLowerCase()
    if (addr === NATIVE_KEY) {
      const weth = wethFor(a.chainId)
      if (!weth) continue // no WETH identity on this chain → honestly untracked
      addr = weth.toLowerCase()
    }
    const key = `${a.chainId}:${addr}`
    const cur = byKey.get(key)
    if (cur) {
      cur.usd += a.valueUsd
      // the dominant contributor names the key (window-move pills)
      if (a.valueUsd > cur.topUsd) {
        cur.topUsd = a.valueUsd
        cur.symbol = a.symbol
      }
    } else byKey.set(key, { key, chainId: a.chainId, address: addr, usd: a.valueUsd, topUsd: a.valueUsd, symbol: a.symbol })
  }

  const rows = [...byKey.values()]
  return {
    fetches: rows.map(({ key, chainId, address, symbol }) => ({ key, chainId, address, symbol })),
    inputs: rows.map((r) => ({ address: r.key, weight: r.usd })),
    plannedUsd: rows.reduce((s, r) => s + r.usd, 0),
    totalUsd,
  }
}

export interface PortfolioCurve {
  points: NavPoint[]
  /** Share (0–100) of the portfolio's USD the curve actually tracks — planned
   *  assets whose history came back usable, over the full priced total. */
  coveragePct: number
}

export function combinePortfolioHistory(
  plan: PortfolioHistoryPlan,
  seriesByKey: Map<string, NavPoint[]>,
  totalUsdNow: number,
): PortfolioCurve {
  const points = combineNavHistory(plan.inputs, seriesByKey, totalUsdNow)
  let covered = 0
  for (const inp of plan.inputs) {
    const s = seriesByKey.get(inp.address) ?? []
    if (s.length >= 2) covered += inp.weight
  }
  const coveragePct = plan.totalUsd > 0 ? (covered / plan.totalUsd) * 100 : 0
  return { points, coveragePct }
}
