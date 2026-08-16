// ─────────────────────────────────────────────────────────────────────────────
// AWAY DIFF — "since you were away", the insights system's missing half
// (owner ruling 2026-08-03 ~15:2x). Every insight is a fact about NOW; this
// is the fact that something CHANGED. No backend: a snapshot of the insight
// inputs persists locally per visit, the next open diffs against it, and the
// surface leads with measured deltas — never advice, never a projection.
//
// Pure core (the house purity law): capture/diff are arithmetic; storage is
// two thin helpers. The SURFACE is the allocator lane's (the insights strip
// is theirs); the extension's service worker is the later upgrade path.
//
// Honesty rules:
//  · a delta is only stated when BOTH sides measured — a position whose
//    exit cost was unreadable yesterday has no "doubled" story today.
//  · thresholds are exported constants, calibrated to the insight system's
//    own floors (drift's 5pp, exit's 1%) so "changed" here means the same
//    thing the standing cards mean.
//  · the snapshot is keyed per wallet-group ANCHOR: the same person's group
//    reads as one book, so their away-story follows the book, not the device
//    connection order.
// ─────────────────────────────────────────────────────────────────────────────

import { showSymbol } from './safe-copy'

export interface AwayPositionSnap {
  symbol: string
  /** Share of the book, percent. */
  pct: number
  valueUsd: number
  /** Measured exit cost, % of position — absent when it did not measure. */
  exitCostPct?: number
}

export interface AwaySnapshot {
  /** v2 adds `unpricedKeys` (see below). v1 snapshots still read: an absent
   *  field simply means "this visit could not tell us", handled below. */
  v: 1 | 2
  atMs: number
  totalUsd: number | null
  /** insight-position key (`${chainId}:${address}`) → the position's facts. */
  positions: Record<string, AwayPositionSnap>
  /** Positions the wallet HELD but could not price on that visit (the mount
   *  drops them pre-diff so a price-feed hiccup is never called "left the
   *  book" — specallocator's mount gate). Without this, the same row coming
   *  BACK reads as "new since your last visit", which is a sayable lie about
   *  something the person has held all along (their v1 residual, closed).
   *  Absent on a v1 snapshot = unknown, and unknown suppresses nothing. */
  unpricedKeys?: string[]
}

export type AwayDelta =
  | { kind: 'total-moved'; pct: number; fromUsd: number; toUsd: number; sentence: string }
  | { kind: 'share-moved'; key: string; symbol: string; fromPct: number; toPct: number; sentence: string }
  | { kind: 'exit-cost-moved'; key: string; symbol: string; fromPct: number; toPct: number; sentence: string }
  | { kind: 'position-new'; key: string; symbol: string; pct: number; sentence: string }
  | { kind: 'position-gone'; key: string; symbol: string; wasPct: number; sentence: string }

/** A position's share must move this many points to be an away-story —
 *  the drift card's own threshold, so "moved" means what the cards mean. */
export const AWAY_SHARE_PP = 5
/** The book's total must move this % to be a story (dust noise is not news). */
export const AWAY_TOTAL_PCT = 2
/** Exit cost must move this many points AND land above the exit card's floor. */
export const AWAY_EXIT_PP = 1
/** A gap shorter than this is a refresh, not an absence — no story. */
export const AWAY_MIN_GAP_MS = 6 * 60 * 60 * 1000
/** More deltas than this is a wall, not a briefing — magnitude keeps the top. */
export const AWAY_MAX_DELTAS = 4

const pct1 = (n: number) => `${Math.abs(n).toFixed(1)}%`
const pp = (n: number) => `${Math.abs(n).toFixed(1)} points`

export function captureAwaySnapshot(
  positions: { key: string; symbol: string; pct: number; valueUsd: number; exitCostPct?: number | null }[],
  totalUsd: number | null,
  now: number = Date.now(),
  /** Keys HELD but unpriced on this visit — recorded so the next diff can tell
   *  "started pricing again" apart from "arrived". Omit and nothing is
   *  suppressed (the v1 behaviour). */
  unpricedKeys?: string[],
): AwaySnapshot {
  const out: AwaySnapshot = {
    v: 2,
    atMs: now,
    totalUsd,
    positions: {},
    ...(unpricedKeys && unpricedKeys.length > 0 ? { unpricedKeys: [...new Set(unpricedKeys)] } : {}),
  }
  for (const p of positions) {
    if (!Number.isFinite(p.pct) || !Number.isFinite(p.valueUsd)) continue
    out.positions[p.key] = {
      symbol: p.symbol,
      pct: p.pct,
      valueUsd: p.valueUsd,
      ...(p.exitCostPct != null && Number.isFinite(p.exitCostPct) ? { exitCostPct: p.exitCostPct } : {}),
    }
  }
  return out
}

/** The deltas worth saying, largest first, capped. Empty when the gap is too
 *  short or nothing crossed a threshold — silence is a valid answer. */
export function diffAwaySnapshots(prev: AwaySnapshot, next: AwaySnapshot): AwayDelta[] {
  if (!(next.atMs - prev.atMs >= AWAY_MIN_GAP_MS)) return []
  const out: (AwayDelta & { mag: number })[] = []
  // BOUND AT THE SENTENCE, NOT AT CAPTURE (2026-08-06, after the same class was
  // found reaching wallet-prompt labels in capability-ladder.ts). A snapshot is
  // PERSISTED, so snapshots written before this fix still hold unbounded
  // deployer symbols — bounding only on the way in would leave every stored one
  // able to bypass it. Bounding where the shown sentence is built covers the
  // records already on disk as well as the new ones.
  const shown = (raw: string) => showSymbol(raw)

  if (prev.totalUsd != null && next.totalUsd != null && prev.totalUsd > 0) {
    const movePct = ((next.totalUsd - prev.totalUsd) / prev.totalUsd) * 100
    if (Math.abs(movePct) >= AWAY_TOTAL_PCT) {
      out.push({
        kind: 'total-moved',
        pct: movePct,
        fromUsd: prev.totalUsd,
        toUsd: next.totalUsd,
        sentence: `Your total moved ${movePct >= 0 ? 'up' : 'down'} ${pct1(movePct)} while you were away.`,
        mag: Math.abs(movePct),
      })
    }
  }

  for (const [key, was] of Object.entries(prev.positions)) {
    const is = next.positions[key]
    if (!is) {
      out.push({
        kind: 'position-gone',
        key,
        symbol: shown(was.symbol),
        wasPct: was.pct,
        sentence: `$${shown(was.symbol)} is no longer in the book. It was ${pct1(was.pct)} of it.`,
        mag: was.pct,
      })
      continue
    }
    const sharePp = is.pct - was.pct
    if (Math.abs(sharePp) >= AWAY_SHARE_PP) {
      out.push({
        kind: 'share-moved',
        key,
        symbol: is.symbol,
        fromPct: was.pct,
        toPct: is.pct,
        sentence: `$${shown(is.symbol)} ${sharePp >= 0 ? 'grew' : 'shrank'} ${pp(sharePp)}, from ${pct1(was.pct)} to ${pct1(is.pct)} of the book.`,
        mag: Math.abs(sharePp),
      })
    }
    // Exit-cost stories need BOTH sides measured — absence has no delta.
    if (was.exitCostPct != null && is.exitCostPct != null) {
      const exitPp = is.exitCostPct - was.exitCostPct
      if (Math.abs(exitPp) >= AWAY_EXIT_PP) {
        out.push({
          kind: 'exit-cost-moved',
          key,
          symbol: is.symbol,
          fromPct: was.exitCostPct,
          toPct: is.exitCostPct,
          sentence: `Leaving $${shown(is.symbol)} now costs ${pct1(is.exitCostPct)} of the position, ${exitPp >= 0 ? 'up' : 'down'} from ${pct1(was.exitCostPct)}.`,
          mag: Math.abs(exitPp),
        })
      }
    }
  }

  // Held-but-unpriced last visit ⇒ NOT an arrival now (v2). The person has
  // held it all along; only our ability to price it changed, and calling that
  // "new since your last visit" is a lie about their own book.
  const wasUnpriced = new Set(prev.unpricedKeys ?? [])
  for (const [key, is] of Object.entries(next.positions)) {
    if (prev.positions[key]) continue
    if (wasUnpriced.has(key)) continue
    if (is.pct < AWAY_SHARE_PP) continue // a sliver arriving is not a story
    out.push({
      kind: 'position-new',
      key,
      symbol: is.symbol,
      pct: is.pct,
      sentence: `$${shown(is.symbol)} is new since your last visit, at ${pct1(is.pct)} of the book.`,
      mag: is.pct,
    })
  }

  return out
    .sort((a, b) => b.mag - a.mag)
    .slice(0, AWAY_MAX_DELTAS)
    .map(({ mag: _mag, ...d }) => d)
}

// ── storage (per group anchor, so the story follows the BOOK) ───────────────

const SNAP_KEY = (anchor: string) => `spectrum:away:v1:${anchor.toLowerCase()}`

export function loadAwaySnapshot(anchor: string): AwaySnapshot | null {
  try {
    const raw = window.localStorage.getItem(SNAP_KEY(anchor))
    if (!raw) return null
    const parsed = JSON.parse(raw) as AwaySnapshot
    // Accept every version this module has ever written. v1's absent
    // `unpricedKeys` reads as "unknown" and suppresses nothing in the diff
    // (`prev.unpricedKeys ?? []` above) — the type comment's promise.
    return (parsed?.v === 1 || parsed?.v === 2) && typeof parsed.atMs === 'number' ? parsed : null
  } catch {
    return null
  }
}

export function saveAwaySnapshot(anchor: string, snap: AwaySnapshot): void {
  try {
    window.localStorage.setItem(SNAP_KEY(anchor), JSON.stringify(snap))
  } catch {
    /* quota/private browsing — the story just does not persist */
  }
}
