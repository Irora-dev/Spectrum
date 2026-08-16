// Basket weight model for the Launch builder (ported from the bento create flow).
// Whole-number weights that ALWAYS sum to CAP; raising one borrows from the largest
// others down to MIN; lowering hands the freed budget back to the largest. Pure —
// the same Weight[] feeds the bento preview and the deploy basket (bps = pct × 100).

export const CAP = 100 // total weight (%)
export const STEP = 5 // +/- increment (steppers + dials keep the 5-feel)
// FLOOR = 1 (owner 2026-08-12: "i want it to be 1% min") — the contract only
// enforces Σ=100 (toBasketEntries), so the old 5 was a UI law; 1% tail
// positions are now composable AND deployable end-to-end. Removing an asset
// entirely stays the way below 1.
export const MIN = 1
/** New assets land at a visible weight (the old MIN), never at the 1% floor. */
export const ADD_AT = STEP
// The 20-asset cap is a PRODUCT law, not arithmetic: it derived from CAP/MIN
// when the floor was 5 and every deploy surface converged on it — the floor
// relaxing to 1 must not silently allow 100-leg baskets.
export const MAX_ASSETS = 20
// ── THE FLOOR ON LEG COUNT IS 1 (owner 2026-08-13) ──────────────────────────
// "for simplicity can't we allow a basket to just have one asset? since the
// multi-chain baskets can always have one asset on one chain and a future
// upgrade could always add more."
//
// The old ≥2 was OURS, never the contract's. Proved rather than assumed
// (scripts/one-leg-probe.ts): a one-leg basket at weight 100 was assembled
// through toBasketEntries, salted against predictTokenAddress, and eth_call
// SIMULATED green on the production Base factory, the production Ethereum
// factory, and the rehearsal Base factory — each alongside a two-leg control
// through the identical code. The factory does not count legs; it enforces
// Σ=10000 bps, which one leg at 100% satisfies exactly.
//
// The arithmetic below is already single-leg-correct and is meant to be:
// equalSplit(1)=[100], isValid([100])=true, addAsset([100])=[95,5],
// removeAsset back to one re-lands it on 100, and adjustWeight REFUSES at n=1
// (a lone leg is pinned at 100% — see its comment).
export const MIN_ASSETS = 1
/** What a one-asset basket actually IS, said once so every surface says it the
 *  same way: it tracks that asset instead of spreading risk, and the creator
 *  fee is unchanged. A fact the buyer is owed — not a warning, not a lecture. */
export const SINGLE_ASSET_NOTE =
  'One asset: this basket tracks it rather than spreading risk, and the creator fee still applies.'

/** Even split across n assets, summing to exactly CAP (remainder spread over the first few). */
export function equalSplit(n: number): number[] {
  if (n <= 0) return []
  const base = Math.floor(CAP / n)
  const w = new Array<number>(n).fill(base)
  let rem = CAP - base * n
  for (let i = 0; rem > 0; i = (i + 1) % n, rem--) w[i] += 1
  return w
}

/** Set asset `i` to `i.weight + delta` (clamped), rebalancing others to keep Σ = CAP. */
export function adjustWeight(weights: number[], i: number, delta: number): number[] {
  const n = weights.length
  if (i < 0 || i >= n || n === 0) return weights
  // A single asset is always 100% — with no counterparty to rebalance against, any
  // change would just destroy mass (Σ drifted below CAP and the weight strip shrank
  // to half width; owner hit this live 2026-07-09). Refuse instead.
  if (n === 1) return weights
  const w = [...weights]
  const maxForI = CAP - MIN * (n - 1) // others can't drop below MIN
  const target = Math.max(MIN, Math.min(w[i] + delta, maxForI))
  let diff = target - w[i]
  if (diff === 0) return w
  w[i] = target

  if (diff > 0) {
    // borrow `diff` from the largest others, each down to MIN
    let need = diff
    while (need > 0) {
      let j = -1
      let best = MIN
      for (let k = 0; k < n; k++) if (k !== i && w[k] > best) ((best = w[k]), (j = k))
      if (j < 0) break
      const take = Math.min(need, w[j] - MIN)
      if (take <= 0) break
      w[j] -= take
      need -= take
    }
  } else {
    // hand the freed budget to the largest other — and if there is no other to
    // receive it, UNDO the change rather than silently losing mass (Σ must stay CAP)
    let give = -diff
    let j = -1
    let best = -1
    for (let k = 0; k < n; k++) if (k !== i && w[k] > best) ((best = w[k]), (j = k))
    if (j >= 0) w[j] += give
    else w[i] -= diff // revert; diff is negative, so this restores the original
    give = 0
  }
  return w
}

export function setWeight(weights: number[], i: number, value: number): number[] {
  return adjustWeight(weights, i, value - (weights[i] ?? 0))
}

/** Append an asset at ADD_AT (a visible landing, never the bare floor),
 *  borrowing from the largest existing holding. */
export function addAsset(weights: number[]): number[] {
  if (weights.length >= MAX_ASSETS) return weights
  const w = [...weights, ADD_AT]
  // borrow the whole landing weight from the largest other that can spare it
  // (staying at or above the floor); Σ re-lands on exactly CAP
  let j = -1
  let best = MIN + ADD_AT - 1
  for (let k = 0; k < w.length - 1; k++) if (w[k] > best) ((best = w[k]), (j = k))
  if (j >= 0) w[j] -= ADD_AT
  else {
    // nothing can spare the whole landing: land at the floor instead and
    // borrow the floor (the pre-2026-08-12 behaviour, still Σ-exact)
    w[w.length - 1] = MIN
    let j2 = -1
    let b2 = MIN
    for (let k = 0; k < w.length - 1; k++) if (w[k] > b2) ((b2 = w[k]), (j2 = k))
    if (j2 >= 0) w[j2] -= MIN
    else return weights
  }
  return w
}

/** Remove asset `i`; its weight goes to the largest remaining (then a final fix-up to CAP). */
export function removeAsset(weights: number[], i: number): number[] {
  const w = weights.filter((_, k) => k !== i)
  if (w.length === 0) return w
  const sum = w.reduce((s, x) => s + x, 0)
  let diff = CAP - sum
  // give/take the difference from the largest holding
  let j = 0
  for (let k = 1; k < w.length; k++) if (w[k] > w[j]) j = k
  w[j] = Math.max(MIN, w[j] + diff)
  diff = CAP - w.reduce((s, x) => s + x, 0)
  if (diff !== 0) w[j] = Math.max(MIN, w[j] + diff)
  return w
}

export function sum(weights: number[]): number {
  return weights.reduce((s, x) => s + x, 0)
}

export function isValid(weights: number[]): boolean {
  return weights.length > 0 && weights.length <= MAX_ASSETS && sum(weights) === CAP && weights.every((w) => w >= MIN)
}
