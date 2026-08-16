import {
  loadDraft,
  saveDraft,
  loadPortfolio,
  savePortfolio,
  MAX_ALLOCATION_ASSETS,
  type AllocationDraft,
} from './allocation'
import { chainCfg } from '../chain/chains'
import { DUST_CEILING_USD } from './insights'
import type { RawHolding } from './raw-holdings'

// ─────────────────────────────────────────────────────────────────────────────
// SEED FROM WHAT YOU HOLD (owner 2026-08-03, the second half of the morning's
// ask: detect their major assets "so we can help them build out their
// portfolio"). Turns the wallet's real priced holdings into a WEIGHTING DRAFT —
// deliberately the draft, never a SavedPortfolio: a saved portfolio claims an
// execution (`executedAt`, the simulated flag); what we actually know is what
// the wallet HOLDS, and that is intent-grade, not execution-grade.
//
// Honesty rules:
//  · priced holdings only — an unpriced position has no defensible weight.
//  · NEVER clobbers: an existing draft with targets wins, we return it
//    untouched. Seeding is for the first minute, not a reset button.
//  · weights are the real value shares of the priced set (≥1 per the
//    AllocTarget contract; display re-normalizes to 100 anyway).
// ─────────────────────────────────────────────────────────────────────────────

/** The SEEDABLE SET — one law, every writer (the draft seeder below and the
 *  sign-in book add): priced rows only, baskets excluded, native folded to
 *  its WETH form, merged by (chain, address), biggest first, capped.
 *
 *  NATIVE FOLDS TO ITS WETH FORM (the owner's connect-first ruling, 2026-08-03):
 *  the sentinel address (0xeee…) is still not a tradeable leg, but excluding
 *  the ROW made a mostly-ETH wallet seed a draft MISSING its biggest holding
 *  while the book showed ETH as the largest tile. The wrapped form IS the
 *  honest leg. A native row and a real WETH row on the same chain merge into
 *  ONE leg — usd summed BEFORE weights, never two legs with one key. A chain
 *  whose config carries no weth keeps the old exclusion.
 *
 *  A held BASKET is not a plain leg the picker can resolve, so it cannot
 *  seed (audit 2026-08-04). It still SHOWS in the book — the CTA says what
 *  rides and what doesn't rather than silently dropping it (and on the
 *  portfolio page baskets enter the book through their own read anyway).
 *
 *  DUST NEVER SEEDS (the owner 2026-08-13, on his own seeded book's reshape grid
 *  full of $0.01 tiles): rows under the HOUSE dust floor — DUST_CEILING_USD,
 *  the one constant the page's fold and the dust-sweep insight already share
 *  — are wallet lint, not intent. The book still SHOWS them (folded, the
 *  page's own law); they just never become targets. */
function seedableFromHoldings(
  holdings: RawHolding[],
): { chainId: number; address: string; symbol: string; usd: number }[] {
  const seedable = new Map<string, { chainId: number; address: string; symbol: string; usd: number }>()
  for (const h of holdings) {
    if (h.usd == null || !(h.usd > 0)) continue
    if (h.basket) continue
    let address = h.address
    let symbol = h.symbol
    if (h.native) {
      let weth: string | null = null
      try {
        weth = chainCfg(h.chainId).weth || null
      } catch {
        weth = null // unknown chain: no wrap form to fold into
      }
      if (!weth) continue
      address = weth
      symbol = 'WETH'
    }
    const key = `${h.chainId}:${address.toLowerCase()}`
    const prev = seedable.get(key)
    if (prev) prev.usd += h.usd
    else seedable.set(key, { chainId: h.chainId, address, symbol, usd: h.usd })
  }
  return (
    [...seedable.values()]
      // the dust floor binds on the MERGED leg (native + WETH summed first —
      // two $6 halves of one $12 position are not dust), never per raw row
      .filter((h) => h.usd >= DUST_CEILING_USD)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, MAX_ALLOCATION_ASSETS)
  )
}

export function seedDraftFromHoldings(
  addr: string,
  holdings: RawHolding[],
  now: number = Date.now(),
): { draft: AllocationDraft; seeded: boolean } | null {
  if (!addr) return null
  const existing = loadDraft(addr)
  if (existing && existing.targets.length > 0) return { draft: existing, seeded: false }

  const priced = seedableFromHoldings(holdings)
  const total = priced.reduce((s, h) => s + h.usd, 0)
  if (priced.length < 2 || !(total > 0)) return null

  const draft: AllocationDraft = {
    targets: priced.map((h) => ({
      asset: { chainId: h.chainId, address: h.address, symbol: h.symbol },
      weight: Math.max(1, Math.round((h.usd / total) * 100)),
    })),
    amountUsd: null,
    intent: 'keep',
    updatedAt: now,
  }
  saveDraft(addr, draft)
  return { draft, seeded: true }
}

/** THE SIGN-IN BOOK ADD (the owner 2026-08-13, the reveal≠add loop: onboarding
 *  REVEALED his book, /portfolio's outcome-keyed gate caught him again —
 *  nothing had ever ADDED it). Writes the revealed holdings as the SAVED
 *  ALLOCATION — the store the portfolio counts and the gate reads — so
 *  signing in lands on a book, not on "complete onboarding".
 *
 *  Laws, and where they differ from the draft seeder above:
 *   · same seedable set (one law — the shared fold above);
 *   · ≥1 leg suffices — a book of one asset is a legitimate BOOK; the ≥2
 *     floor above is a WEIGHTING law (a weighting of one asset is a tautology)
 *     and does not apply to adding what you hold;
 *   · NEVER clobbers: an existing saved allocation wins, whole (this is an
 *     add for the first minute, not a reset);
 *   · amountUsd is the priced total that rode in — loadPortfolio refuses a
 *     non-finite amount, and the total is the true figure the weights came
 *     from;
 *   · simulated: true — no engine ran and nothing chain-confirmed EXECUTED;
 *     the flag's contract is "never present as chain-confirmed", and a real
 *     holdings snapshot wearing a too-modest label under-claims, which is
 *     the safe direction for money UI. */
export function savePortfolioFromHoldings(
  addr: string,
  holdings: RawHolding[],
  now: number = Date.now(),
): { added: boolean; count: number; totalUsd: number } {
  if (!addr) return { added: false, count: 0, totalUsd: 0 }
  const existing = loadPortfolio(addr)
  if (existing) return { added: false, count: existing.targets.length, totalUsd: existing.amountUsd }

  const priced = seedableFromHoldings(holdings)
  const total = priced.reduce((s, h) => s + h.usd, 0)
  if (priced.length < 1 || !(total > 0)) return { added: false, count: 0, totalUsd: 0 }

  savePortfolio(addr, {
    targets: priced.map((h) => ({
      asset: { chainId: h.chainId, address: h.address, symbol: h.symbol },
      weight: Math.max(1, Math.round((h.usd / total) * 100)),
    })),
    amountUsd: Math.round(total * 100) / 100,
    executedAt: now,
    simulated: true,
    seededFromHoldings: true,
  })
  return { added: true, count: priced.length, totalUsd: Math.round(total * 100) / 100 }
}

/** THE SEEDED BOOK TOPS ITSELF UP (the owner 2026-08-13, live minutes after the
 *  sign-in add shipped: "on the actual portfolio page its not showing all the
 *  assets that was detected during onboarding" — a partial read at add time
 *  froze a partial book forever, because the add never clobbers). While the
 *  `seededFromHoldings` flag stands, later reads may GROW the book:
 *   · APPEND-ONLY — an existing target is never removed, reweighted or
 *     renamed; a bad-RPC day must not shrink the book it cannot see;
 *   · appended weights are the new leg's value share of TODAY's seedable
 *     total (the same fold, dust floor and all) — approximately honest
 *     beside the originals, and the page renormalises over the weight sum;
 *   · the cap still binds: biggest first, only while room remains;
 *   · a user-composed book (no flag — every flow save drops it) is NEVER
 *     touched. */
export function topUpSeededPortfolio(
  addr: string,
  holdings: RawHolding[],
): { added: boolean; count: number } {
  if (!addr) return { added: false, count: 0 }
  const existing = loadPortfolio(addr)
  if (!existing || existing.seededFromHoldings !== true) return { added: false, count: 0 }

  const priced = seedableFromHoldings(holdings)
  const total = priced.reduce((s, h) => s + h.usd, 0)
  if (!(total > 0)) return { added: false, count: 0 }

  const have = new Set(existing.targets.map((t) => `${t.asset.chainId}:${t.asset.address.toLowerCase()}`))
  const room = Math.max(0, MAX_ALLOCATION_ASSETS - existing.targets.length)
  const fresh = priced.filter((h) => !have.has(`${h.chainId}:${h.address.toLowerCase()}`)).slice(0, room)
  if (fresh.length === 0) return { added: false, count: 0 }

  savePortfolio(addr, {
    ...existing,
    targets: [
      ...existing.targets,
      ...fresh.map((h) => ({
        asset: { chainId: h.chainId, address: h.address, symbol: h.symbol },
        weight: Math.max(1, Math.round((h.usd / total) * 100)),
      })),
    ],
    amountUsd: Math.round((existing.amountUsd + fresh.reduce((s, h) => s + h.usd, 0)) * 100) / 100,
  })
  return { added: true, count: fresh.length }
}

// ── SEED FROM A BASKET'S COMPOSITION (the discovery→creation seam, owner
// greenlight ~17:0x): a basket page's recipe becomes the visitor's own
// starting draft — same laws as holdings seeding: never clobbers, ≥2 legs,
// capped, weights ≥1. Target weights (the creator's DESIGN, not live drift)
// are the recipe worth starting from.

export interface CompositionLeg {
  chainId: number
  address: string
  symbol: string
  /** The designed weight, percent. */
  weightPct: number
}

export function seedDraftFromComposition(
  addr: string,
  legs: CompositionLeg[],
  now: number = Date.now(),
): { draft: AllocationDraft; seeded: boolean } | null {
  if (!addr) return null
  const existing = loadDraft(addr)
  if (existing && existing.targets.length > 0) return { draft: existing, seeded: false }

  const usable = legs
    .filter((l) => Number.isFinite(l.weightPct) && l.weightPct > 0)
    .sort((a, b) => b.weightPct - a.weightPct)
    .slice(0, MAX_ALLOCATION_ASSETS)
  const total = usable.reduce((s, l) => s + l.weightPct, 0)
  if (usable.length < 2 || !(total > 0)) return null

  const draft: AllocationDraft = {
    targets: usable.map((l) => ({
      asset: { chainId: l.chainId, address: l.address, symbol: l.symbol },
      weight: Math.max(1, Math.round((l.weightPct / total) * 100)),
    })),
    amountUsd: null,
    intent: 'keep',
    updatedAt: now,
  }
  saveDraft(addr, draft)
  return { draft, seeded: true }
}
