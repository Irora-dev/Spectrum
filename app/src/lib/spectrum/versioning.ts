import type { Address } from 'viem'
import { resolveCreatorMeta } from './creator-metadata'
import type { BasketData } from './basket-data'

// ─────────────────────────────────────────────────────────────────────────────
// Basket versioning — lineage as a deployer-signed "social convention", NOT an
// on-chain pointer. The contracts reject any successor registry /
// canonical pointer (it reintroduces a controller). So a new version
// declares its predecessor inside the creator's deployer-signed metadata blob
// (`supersedes`, verified in creator-metadata.ts). We read those signed claims,
// require the SAME deployer signed the successor and owns the predecessor, and
// build the lineage graph client-side. No platform store, no curation — every
// link is a fact the deployer signed about their own baskets.
//
// The "diff" between two versions is derived purely from on-chain basket facts
// (constituents + target weights) — never from a curated note.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CHAIN = 50 // cap lineage length — guards against forged predecessor rings

export interface LineageGraph {
  /** Latest version in addr's lineage (lowercased). */
  headOf(addr: string): string
  /** Root→head ordered lowercased addresses. */
  lineageOf(addr: string): string[]
  hasSuccessor(addr: string): boolean
  successorOf(addr: string): string | null
  predecessorOf(addr: string): string | null
}

interface BasketRef {
  address: string
  chainId: number
  deployer: string | null
}

/**
 * Build the predecessor→successor graph for a set of baskets by reading each
 * one's verified `supersedes` claim. An edge counts only when the predecessor is
 * in the set AND both baskets share a deployer (same creator). 1:1, first-wins.
 */
export async function buildLineageGraph(baskets: BasketRef[]): Promise<LineageGraph> {
  const byAddr = new Map<string, BasketRef>()
  for (const b of baskets) byAddr.set(b.address.toLowerCase(), b)

  const predToSucc = new Map<string, string>()
  const succToPred = new Map<string, string>()

  const metas = await Promise.all(
    baskets.map((b) =>
      resolveCreatorMeta(b.address as Address, b.chainId)
        .then((m) => ({ b, m }))
        .catch(() => ({ b, m: null })),
    ),
  )

  for (const { b, m } of metas) {
    const pred = m?.supersedes?.toLowerCase()
    if (!pred) continue
    const predRef = byAddr.get(pred)
    if (!predRef) continue // predecessor not in this set / chain
    // Same-creator guard: the metadata is signed by the successor's deployer
    // (verified upstream); the predecessor must be by that same deployer.
    if (predRef.deployer && b.deployer && predRef.deployer.toLowerCase() !== b.deployer.toLowerCase()) continue
    const succ = b.address.toLowerCase()
    if (predToSucc.has(pred) || succToPred.has(succ)) continue // 1:1, first-wins
    predToSucc.set(pred, succ)
    succToPred.set(succ, pred)
  }

  const lc = (a: string) => a.toLowerCase()
  const walk = (start: string, edges: Map<string, string>): string => {
    let cur = lc(start)
    const seen = new Set<string>([cur])
    for (let i = 0; i < MAX_CHAIN; i++) {
      const next = edges.get(cur)
      if (!next || seen.has(next)) break
      seen.add(next)
      cur = next
    }
    return cur
  }

  return {
    headOf: (a) => walk(a, predToSucc),
    predecessorOf: (a) => succToPred.get(lc(a)) ?? null,
    successorOf: (a) => predToSucc.get(lc(a)) ?? null,
    hasSuccessor: (a) => predToSucc.has(lc(a)),
    lineageOf: (a) => {
      const root = walk(a, succToPred)
      const out = [root]
      const seen = new Set<string>([root])
      let cur = root
      for (let i = 0; i < MAX_CHAIN; i++) {
        const next = predToSucc.get(cur)
        if (!next || seen.has(next)) break
        seen.add(next)
        out.push(next)
        cur = next
      }
      return out
    },
  }
}

// ── On-chain diff between two basket versions (facts only) ───────────────────

export type DiffKind = 'added' | 'removed' | 'reweighted' | 'unchanged'

export interface ConstituentDiff {
  asset: string
  symbol: string
  kind: DiffKind
  fromWeightPct: number | null
  toWeightPct: number | null
}

export interface BasketDiff {
  constituents: ConstituentDiff[]
  addedCount: number
  removedCount: number
  reweightedCount: number
}

const WEIGHT_EPS = 0.001

/**
 * Compare two basket versions by their on-chain constituents + target weights.
 * Pure and factual — no performance/backtest framing (that would be an
 * inducement; the diff is "what changed", not "what would have happened").
 */
export function computeBasketDiff(prev: BasketData, next: BasketData): BasketDiff {
  const byPrev = new Map(prev.holdings.map((h) => [h.asset.toLowerCase(), h]))
  const byNext = new Map(next.holdings.map((h) => [h.asset.toLowerCase(), h]))
  const all = new Set<string>([...byPrev.keys(), ...byNext.keys()])

  const constituents: ConstituentDiff[] = []
  for (const a of all) {
    const p = byPrev.get(a)
    const n = byNext.get(a)
    const symbol = (n ?? p)!.symbol
    if (p && !n) {
      constituents.push({ asset: a, symbol, kind: 'removed', fromWeightPct: p.targetWeightPct, toWeightPct: null })
    } else if (!p && n) {
      constituents.push({ asset: a, symbol, kind: 'added', fromWeightPct: null, toWeightPct: n.targetWeightPct })
    } else if (p && n) {
      const kind: DiffKind = Math.abs(p.targetWeightPct - n.targetWeightPct) > WEIGHT_EPS ? 'reweighted' : 'unchanged'
      constituents.push({ asset: a, symbol, kind, fromWeightPct: p.targetWeightPct, toWeightPct: n.targetWeightPct })
    }
  }

  const rank: Record<DiffKind, number> = { added: 0, reweighted: 1, removed: 2, unchanged: 3 }
  constituents.sort(
    (x, y) =>
      rank[x.kind] - rank[y.kind] ||
      (y.toWeightPct ?? y.fromWeightPct ?? 0) - (x.toWeightPct ?? x.fromWeightPct ?? 0),
  )

  return {
    constituents,
    addedCount: constituents.filter((c) => c.kind === 'added').length,
    removedCount: constituents.filter((c) => c.kind === 'removed').length,
    reweightedCount: constituents.filter((c) => c.kind === 'reweighted').length,
  }
}

// ── the version-ticker nudge ──────────────────────────────────────────────────
// Same name + ticker on a new version is VALID (identity = contract address),
// but on wallets/DEX UIs/aggregators two live tokens under one ticker read as
// "which one do I buy?" (owner 2026-07-07 13:38). So the new-version flow
// PREFILLS an incremented ticker — a gentle default, freely editable, never
// enforced: BLUE → BLUEV2 · BLUEV1 → BLUEV2 · TBV2 → TBV3.

/** Max ERC-20-symbol length the builder accepts (mirrors its input cap). */
const MAX_SYMBOL_LEN = 11

/** Next versioned ticker for a successor basket. A trailing `V<digits>` suffix
 *  increments; anything else gets `V2` appended, trimming the base to fit the
 *  11-char cap. Input is expected uppercase-alphanumeric (the builder's rule);
 *  anything unparseable is returned untouched. */
export function bumpVersionTicker(symbol: string): string {
  const s = symbol.trim().toUpperCase()
  if (!/^[A-Z0-9]{1,11}$/.test(s)) return symbol
  const m = s.match(/^([A-Z0-9]*[A-Z])V(\d{1,3})$/)
  if (m) {
    const next = `${m[1]}V${Number(m[2]) + 1}`
    return next.length <= MAX_SYMBOL_LEN ? next : symbol
  }
  const base = s.slice(0, MAX_SYMBOL_LEN - 2)
  return `${base}V2`
}
