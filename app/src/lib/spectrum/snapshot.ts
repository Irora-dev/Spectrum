// ─────────────────────────────────────────────────────────────────────────────
// Snapshot consumption — OPTIONAL and zero-config: the source auto-resolves
// (explicit env → social-layer DB → same-origin file, see resolveSnapshotUrl)
// and a missing/stale/malformed source degrades to live RPC reads, so with no
// snapshot anywhere the app behaves exactly as if this module didn't exist.
//
// The structural cost problem with a fully client-side app is that GLOBAL data
// (the basket list, NAV/TVL marks, deployers, inception) is re-fetched from the
// RPC once per visitor per poll. A snapshot inverts that: a tiny scheduled
// poller — scripts/build-snapshot.mjs, or the social-layer DB's cron function
// (DATABASE-DESIGN.md §4), either way the only key-holder — writes one JSON on
// a cadence, and every visitor reads THAT.
// RPC spend becomes O(1) per interval per deployment instead of O(visitors).
//
// Trust/freshness posture:
//   • DISPLAY-GRADE ONLY. List/discovery surfaces may render from a snapshot.
//     Anything trade-critical — swap floors (swap-quote.ts), click-time
//     simulates, allowances, live fee state, wallet balances — is NEVER served
//     from a snapshot. Do not add a bypass.
//   • Stale or malformed snapshots are DISCARDED (age gate below) and callers
//     fall back to live reads — a dead poller degrades to exactly the current
//     behavior, never to stale-forever data.
//   • The snapshot is unauthenticated static JSON the OPERATOR hosts for their
//     own frontend; shape is validated defensively before use.
// ─────────────────────────────────────────────────────────────────────────────

export interface SnapshotLeg {
  asset: string
  symbol: string
  name: string
  decimals: number
  targetBps: number
  balance: number
  priceUsd: number
  ch1: number
  ch6: number
  ch24: number
}

export interface SnapshotBasket {
  address: string
  name: string
  symbol: string
  decimals: number
  totalSupply: number
  effectiveSupply: number | null
  navPerToken: number
  navSource: 'onchain' | 'reconstructed'
  fullyPriced: boolean
  aumUsd: number
  deployer: string | null
  inceptionTs: number | null
  legs: SnapshotLeg[]
}

export interface SpectrumSnapshot {
  v: 1
  /** Unix seconds the poller produced this snapshot. */
  generatedAt: number
  /** Keyed by decimal chainId string. A missing chain means "not covered" —
   *  callers use the live path for it (distinct from an empty basket list). */
  chains: Record<string, { baskets: SnapshotBasket[] }>
}

// Source resolution — zero-config by design. Precedence:
//   1. VITE_SNAPSHOT_URL — explicit operator override (any host/CDN).
//   2. Same-origin `snapshot.json` beside the app (resolved against the
//      BUNDLE URL, not the page URL — correct under base:'./' subpath hosting
//      and on deep-route hard loads). Absent → one memoized miss per interval
//      and the site behaves exactly as with no snapshot at all.
// An explicit URL beats the bundled file. Snapshot is an RPC-cost optimization,
// NOT a database — the DB-less kit reads live when there's no snapshot.
function resolveSnapshotUrl(): string | null {
  const explicit = (import.meta.env.VITE_SNAPSHOT_URL as string | undefined)?.trim()
  if (explicit) return explicit
  try {
    return new URL('../snapshot.json', import.meta.url).href // bundle lives in assets/
  } catch {
    return null
  }
}
const SNAPSHOT_URL = resolveSnapshotUrl()

// Reject snapshots older than this (seconds). Default 15 min — generous vs the
// suggested 2–5 min poller cadence, tight enough that a dead poller flips the
// site back to live reads quickly.
const MAX_AGE_SEC = (() => {
  const raw = Number(import.meta.env.VITE_SNAPSHOT_MAX_AGE_SEC)
  return Number.isFinite(raw) && raw > 0 ? raw : 900
})()

// Re-fetch the URL at most this often; between fetches every caller shares the
// same in-memory copy (the HTTP layer/CDN handles actual caching).
const REFETCH_MS = 60_000

function isSnapshot(v: unknown): v is SpectrumSnapshot {
  if (!v || typeof v !== 'object') return false
  const s = v as SpectrumSnapshot
  return (
    s.v === 1 &&
    Number.isFinite(s.generatedAt) &&
    s.generatedAt > 0 &&
    typeof s.chains === 'object' &&
    s.chains !== null
  )
}

function isFresh(s: SpectrumSnapshot): boolean {
  const age = Date.now() / 1000 - s.generatedAt
  // Small negative tolerance for host/browser clock skew.
  return age > -300 && age <= MAX_AGE_SEC
}

let memo: { snap: SpectrumSnapshot | null; ts: number } | null = null
let inflight: Promise<SpectrumSnapshot | null> | null = null

/** The current fresh snapshot, or null (unconfigured / unreachable / stale /
 *  malformed). Never throws; never blocks longer than one fetch. */
export async function loadSnapshot(): Promise<SpectrumSnapshot | null> {
  if (!SNAPSHOT_URL) return null
  const now = Date.now()
  if (memo && now - memo.ts < REFETCH_MS) {
    return memo.snap && isFresh(memo.snap) ? memo.snap : null
  }
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const r = await fetch(SNAPSHOT_URL, { headers: { Accept: 'application/json' } })
      const json = r.ok ? ((await r.json()) as unknown) : null
      const snap = json && isSnapshot(json) && isFresh(json) ? json : null
      memo = { snap, ts: Date.now() }
      return snap
    } catch {
      memo = { snap: null, ts: Date.now() }
      return null
    } finally {
      inflight = null
    }
  })()
  return inflight
}
