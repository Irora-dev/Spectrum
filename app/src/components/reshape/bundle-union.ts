import { appendResolvedLeg, removeDraftLeg, setDraftWeightPct } from './reshape-model'
import type { ReshapeDraft, ReshapeLeg } from './reshape-types'

// ─────────────────────────────────────────────────────────────────────────────
// THE BUNDLE-UNION MODEL — the pure model behind the thesis reshape's ONE edit
// surface (no React, no chain calls, no storage — thesis-reshape-model.ts's
// extraction pattern). Owner ruling (the owner 2026-08-12, live review): "the chain
// selection shouldn't be needed … you can reweight the whole basket and add
// assets and we then know/compute which assets need updating on each chain's
// underlying basket token." So the creator edits the bundle's COMBINED mix
// once; this module folds the per-chain drafts into that union (mergeUnion),
// applies one edit set to every chain's own draft (compileChains), and a chain
// whose compiled draft is unchanged ships nothing — auto-skip is COMPUTED from
// the result, never a toggle the creator has to get right.
//
// EVERY MUTATION GOES THROUGH reshape-model.ts's ops (removeDraftLeg /
// appendResolvedLeg / setDraftWeightPct — themselves on weights.ts's law:
// MIN 5 · STEP 5 · ≤20 assets · Σ=100, borrow-from-largest). This file never
// touches a weights array directly, so every compiled draft is deployable by
// construction — or the chain is refused out loud (`kept`), never bent.
//
// THE NO-EDIT INVARIANT (what makes auto-skip honest): compiling an EMPTY edit
// set runs zero ops, so every chain comes back changed:false with its draft
// exactly as it went in — no round-trip drift, no re-snapping, no phantom
// ships. The first test pins it.
//
// IDENTITY IS THE CASE-FOLDED SYMBOL: the same asset has a DIFFERENT address
// on every chain, so the union keys legs by unionKey(symbol) — the one name
// the creator actually sees. Resolving an ADD to a per-chain address/route is
// chain I/O and stays with the caller; this module only states, per chain,
// which adds could not land there (`unresolvedAdds`).
// ─────────────────────────────────────────────────────────────────────────────

/** Cross-chain identity: case-folded symbol (locale-independent toLowerCase —
 *  addresses differ per chain by construction, the symbol is what unifies). */
export function unionKey(symbol: string): string {
  return symbol.toLowerCase()
}

export interface UnionEntry {
  key: string
  /** Display case = first seen across the fold. */
  symbol: string
  /** First non-null name seen across the fold (display slot), else null. */
  name: string | null
  /** Which chains hold it today, each with ITS OWN current weight. */
  perChain: { chainId: number; weightPct: number; leg: ReshapeLeg }[]
}

/** Merge per-chain seeded drafts into the union list the one edit surface
 *  shows: one entry per case-folded symbol, ordered by COMBINED weight desc
 *  (ties: first-seen, stable). A symbol held on three chains is ONE entry with
 *  three perChain rows — each row keeps that chain's own weight and leg. */
export function mergeUnion(drafts: ReadonlyMap<number, ReshapeDraft>): UnionEntry[] {
  const byKey = new Map<string, UnionEntry>()
  for (const [chainId, draft] of drafts) {
    draft.legs.forEach((leg, i) => {
      const key = unionKey(leg.symbol)
      let entry = byKey.get(key)
      if (!entry) {
        entry = { key, symbol: leg.symbol, name: leg.name ?? null, perChain: [] }
        byKey.set(key, entry)
      } else if (entry.name === null && leg.name != null) {
        entry.name = leg.name
      }
      entry.perChain.push({ chainId, weightPct: draft.weights[i] ?? 0, leg })
    })
  }
  // Map values iterate in first-seen order — that order IS the tie-break.
  const entries = [...byKey.values()]
  const firstSeen = new Map(entries.map((e, i) => [e.key, i]))
  const combined = (e: UnionEntry) => e.perChain.reduce((s, p) => s + p.weightPct, 0)
  return entries.sort(
    (a, b) => combined(b) - combined(a) || (firstSeen.get(a.key) ?? 0) - (firstSeen.get(b.key) ?? 0),
  )
}

export interface UnionEdits {
  /** key -> target pct: set this asset to N% on EVERY chain that holds it.
   *  The op snaps to STEP and clamps to [MIN, CAP−MIN·(n−1)] per chain. */
  reweights: ReadonlyMap<string, number>
  /** keys removed everywhere. */
  removals: ReadonlySet<string>
  /** Assets added: resolved per chain by the CALLER (resolution is chain I/O,
   *  not this module's job). weightPct is the target on every chain where it
   *  resolved. */
  adds: readonly { key: string; symbol: string; weightPct: number; perChain: { chainId: number; leg: ReshapeLeg }[] }[]
}

export interface CompiledChain {
  chainId: number
  /** The chain's new draft after the edits — null when the edit is
   *  INAPPLICABLE there (see keptTooFewLegsWords). */
  draft: ReshapeDraft | null
  /** True when the compiled MIX differs from current — ships. Compared as
   *  address→weight content, order-insensitive: a remove/re-add round-trip
   *  that lands the same asset at the same weight is not a change, and
   *  shipping it would mint an identical version for nothing. */
  changed: boolean
  /** Human sentence when this chain cannot take the edit and therefore keeps
   *  its current version (today's one cause: removals leave <2 legs). */
  kept: string | null
  /** Adds that could not land here — no route resolved on this chain, or the
   *  MAX_ASSETS ceiling (appendResolvedLeg's own refusal) — stated, never
   *  silent. The rest of the edit still applies to this chain. */
  unresolvedAdds: string[] // symbols
}

/** The kept-current sentence — says WHAT happened, never a bare "kept".
 *  `remaining` = how many legs the compiled basket would have held (0 or 1). */
export function keptTooFewLegsWords(remaining: number): string {
  void remaining // reached only at zero now (MIN_ASSETS = 1)
  return `These edits would leave this network's basket holding no assets at all — a basket needs at least one, so this network keeps its current version and ships nothing.`
}

/**
 * Apply one edit set to every chain's current draft. Order: removals → adds →
 * reweights — and that order IS the precedence law:
 *   · a removed key has no surviving legs when reweights run, so "removal
 *     wins" over a reweight of the same key by construction (no resurrection);
 *   · an added key's fresh leg IS a surviving leg, so a reweight of it applies
 *     exactly where the add landed.
 * NO-EDIT INVARIANT: empty edits run zero ops and MUST compile every chain to
 * changed:false with a draft deep-equal to current — this is the invariant
 * that makes auto-skip honest; the first test pins it.
 */
export function compileChains(drafts: ReadonlyMap<number, ReshapeDraft>, edits: UnionEdits): CompiledChain[] {
  const out: CompiledChain[] = []
  for (const [chainId, current] of drafts) out.push(compileOne(chainId, current, edits))
  return out
}

// ── one chain's compile (the three phases, every mutation an op) ─────────────

function compileOne(chainId: number, current: ReshapeDraft, edits: UnionEdits): CompiledChain {
  let draft = current

  // 1 · removals — every leg matching a removed key goes, ONE op per leg
  //     (index re-found after each removal; the freed weight lands per
  //     removeDraftLeg's law: handed to the largest remaining).
  let removedHere = false
  for (const key of edits.removals) {
    for (let i = indexOfKey(draft, key); i >= 0; i = indexOfKey(draft, key)) {
      draft = removeDraftLeg(draft, i)
      removedHere = true
    }
  }

  // 2 · adds — in order; each lands at MIN (appendResolvedLeg) then rises to
  //     its target (setDraftWeightPct — the op snaps and clamps, so a target
  //     under MIN simply lands at MIN). A chain absent from the add's perChain
  //     could not resolve it — stated. An add whose key this chain ALREADY
  //     holds becomes a weight target on the existing leg, never a duplicate.
  //     appendResolvedLeg refusing (the MAX_ASSETS ceiling — identity return)
  //     is stated the same way: the add didn't land HERE, the rest of the
  //     edit still applies.
  const unresolvedAdds: string[] = []
  for (const add of edits.adds) {
    const resolved = add.perChain.find((p) => p.chainId === chainId)
    if (!resolved) {
      unresolvedAdds.push(add.symbol)
      continue
    }
    const existing = indexOfKey(draft, add.key)
    if (existing >= 0) {
      draft = setDraftWeightPct(draft, existing, add.weightPct)
      continue
    }
    const appended = appendResolvedLeg(draft, resolved.leg)
    if (appended === draft) {
      unresolvedAdds.push(add.symbol)
      continue
    }
    draft = setDraftWeightPct(appended, appended.legs.length - 1, add.weightPct)
  }

  // The <2 refusal — only when a removal HERE caused it. A chain that was
  // already single-leg compiles untouched (the no-edit invariant depends on
  // this distinction), and an add can rescue a removal (remove one of two,
  // add a replacement → a lawful 2-leg draft, not a refusal).
  // MIN_ASSETS is 1 (weights.ts, the owner's ruling) — a removal may shrink a
  // basket to ONE leg; only a removal to ZERO refuses (owner 2026-08-16, the
  // same live find as version-seed's stale two-gate).
  if (draft.legs.length < 1 && removedHere) {
    return { chainId, draft: null, changed: false, kept: keptTooFewLegsWords(draft.legs.length), unresolvedAdds }
  }

  // 3 · reweights — set every surviving leg matching the key; a chain that
  //     doesn't hold the key is simply not touched by it. On a single-leg
  //     chain the op itself refuses (no counterparty to rebalance against),
  //     so the draft stays as-is and auto-skip covers it.
  for (const [key, target] of edits.reweights) {
    for (let i = 0; i < draft.legs.length; i++) {
      if (unionKey(draft.legs[i].symbol) === key) draft = setDraftWeightPct(draft, i, target)
    }
  }

  return { chainId, draft, changed: !sameMix(current, draft), kept: null, unresolvedAdds }
}

/** First leg index whose symbol folds to `key`, or −1. */
function indexOfKey(draft: ReshapeDraft, key: string): number {
  return draft.legs.findIndex((l) => unionKey(l.symbol) === key)
}

/** Would deploying `next` ship the mix `current` already holds? Compares the
 *  address→weight content, ORDER-INSENSITIVE (a reordered but identical mix
 *  is the same basket in substance) and address-case-insensitive (the add
 *  pipeline's own dupe rule). Identity fields (name/symbol/feeConfig) are not
 *  edited by this module, so they carry through and are not compared. */
function sameMix(current: ReshapeDraft, next: ReshapeDraft): boolean {
  if (current.legs.length !== next.legs.length) return false
  const a = mixOf(current)
  const b = mixOf(next)
  if (a.size !== b.size) return false
  for (const [address, weight] of a) if (b.get(address) !== weight) return false
  return true
}

function mixOf(draft: ReshapeDraft): Map<string, number> {
  const m = new Map<string, number>()
  draft.legs.forEach((l, i) => {
    const k = l.address.toLowerCase()
    m.set(k, (m.get(k) ?? 0) + (draft.weights[i] ?? 0))
  })
  return m
}
