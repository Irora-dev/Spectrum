// Basket weight model for the Launch builder (ported from the bento create flow).
// Whole-number weights that ALWAYS sum to CAP; raising one borrows from the largest
// others down to MIN; lowering hands the freed budget back to the largest. Pure —
// the same Weight[] feeds the bento preview and the deploy basket (bps = pct × 100).

export const CAP = 100 // total weight (%)
export const STEP = 5 // +/- increment
export const MIN = 5 // floor per asset (remove the asset entirely to go lower)
export const MAX_ASSETS = Math.floor(CAP / MIN) // 20

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

/** Append an asset at MIN, borrowing from the largest existing holding. */
export function addAsset(weights: number[]): number[] {
  if (weights.length >= MAX_ASSETS) return weights
  const w = [...weights, MIN]
  // borrow MIN from the largest other
  let j = -1
  let best = MIN
  for (let k = 0; k < w.length - 1; k++) if (w[k] > best) ((best = w[k]), (j = k))
  if (j >= 0) w[j] -= MIN
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
