import type { StorageLike } from './allocation'

// ─────────────────────────────────────────────────────────────────────────────
// THE EXECUTION LOG (features 1 + 7 of the 2026-08-03 ~16:4x round, both
// greenlit): a device-local, append-only record of what this wallet DID —
// each completed run, with its recorded changes. Two consumers:
//   · the value chart's event markers ("your actions on your own line"),
//   · the CSV export's realized-events sheet.
//
// Honesty rules, same family as the rest of the storage seam:
//   · append-only at the one completion choke point; nothing re-derives
//     history it didn't witness (rows exist from the day this shipped —
//     the chart says nothing about days the log wasn't there);
//   · changes come from the composer's RECORDED ends (funding.changes),
//     never re-derived from stored percentages (the $3.63-DEGEN lesson);
//   · reads sanitize row by row and drop junk — localStorage is a trust
//     boundary like everywhere else.
//
// PARTIAL ENTRIES (the line above, closed 2026-08-04 — PM-ratified as REQUIRED
// before 3.2: "a live half-run that vanishes is the worst class of record
// failure this OS exists to prevent"). A run that stops after some steps
// finished HAS moved money, so it logs `partial: true` with only the steps
// that actually completed, plus `stoppedAt` naming where it stopped. What a
// partial entry may NOT do is guess a cause: the batcher discards a failed
// leg's inner reason (`RequiredLegFailed(index)` is all that surfaces), so the
// row carries the leg INDEX and says the reason is unavailable rather than
// inventing "slippage" or "no liquidity" — those need opposite responses and
// we cannot tell them apart.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecLogEntry {
  ts: number
  kind: 'rebalance' | 'create' | 'publish' | 'swap'
  /** NET NEW MONEY the run brought in — create's invested amount; a pure
   *  rebalance's honest 0. ONE semantic for the column (never a portfolio
   *  value, never gross moved). Null when unknown — never zero-as-unknown. */
  totalUsd: number | null
  /** The legs the run actually moved, exact recorded ends. */
  changes?: { symbol: string; deltaUsd: number; realizedUsd?: number }[]
  simulated: boolean
  /** TRUE when the run stopped before finishing — the money in `changes` moved,
   *  the rest did not. A partial row is not a failure report; it is the honest
   *  record of what happened to the money.
   *
   *  ⚠ ON A PARTIAL ROW, `totalUsd` MUST BE WHAT ACTUALLY MOVED, or null
   *  (audit round 3, 2026-08-04): a partial `create` was keeping the full
   *  intended amount, so a run that stopped at the bridge still told the chart
   *  and the CSV it brought in $500. The read-back FORCES null on any partial
   *  row that carries no `changes` to back the figure — the never-claim-what-
   *  you-cannot-know law, applied to our own history. */
  partial?: boolean
  /** Where it stopped, in plain words the run panel already showed the user
   *  ("the Base batch", "the bridge to Ethereum"). No cause is claimed. */
  stoppedAt?: string
  /** The failing leg's INDEX when the chain told us one (`RequiredLegFailed`),
   *  with no cause attached — the contract discards the inner reason. */
  failedLegIndex?: number
}

const KEY = (addr: string) => `spectrum:execlog:${addr.toLowerCase()}`
/** Plenty for a personal history; a runaway writer cannot flood storage. */
const MAX_ENTRIES = 200

function safeStorage(): StorageLike | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Read the history of a WHOLE WALLET GROUP as one timeline (2026-08-11,
 *  the owner's ruling that one portfolio should mean one history).
 *
 *  The log stays keyed PER WALLET on write — the row records which wallet
 *  actually signed, which is a fact about the money and must not be smeared
 *  across a group that can change later. Reading merges: every member's rows,
 *  newest-first, each tagged with the wallet that made it. Unlink a wallet and
 *  its rows leave with it; its own key still holds them, so nothing is lost.
 *
 *  Deduped by (wallet, ts, kind): the same address appearing twice in a group
 *  (an anchor also listed as a member of itself, a duplicated import) must not
 *  double a row. */
export function loadExecLogGroup(
  addrs: readonly string[],
  storage: StorageLike | null = safeStorage(),
): (ExecLogEntry & { wallet: string })[] {
  const seen = new Set<string>()
  const rows: (ExecLogEntry & { wallet: string })[] = []
  for (const a of addrs) {
    const wallet = (a ?? '').toLowerCase()
    if (!wallet || seen.has(wallet)) continue
    seen.add(wallet)
    for (const e of loadExecLog(wallet, storage)) rows.push({ ...e, wallet })
  }
  return rows.sort((x, y) => y.ts - x.ts)
}

export function appendExec(addr: string, entry: ExecLogEntry, storage: StorageLike | null = safeStorage()): void {
  if (!addr || !storage) return
  const write = () => {
    const rows = loadExecLog(addr, storage)
    rows.push(entry)
    try {
      storage.setItem(KEY(addr), JSON.stringify(rows.slice(-MAX_ENTRIES)))
    } catch {
      /* storage full/blocked: the log is a nicety, never worth throwing for */
    }
  }
  write()
  // TAB-RACE CONVERGENCE (audit follow-up): two tabs completing runs at the
  // same moment both read-modify-write, and the slower write drops the
  // faster tab's row. One deferred read-back re-appends this entry if a
  // concurrent writer clobbered it — both tabs converge on both rows.
  // Bounded to a single retry; identity is (ts, kind).
  if (typeof setTimeout === 'function') {
    setTimeout(() => {
      const rows = loadExecLog(addr, storage)
      if (!rows.some((r) => r.ts === entry.ts && r.kind === entry.kind)) write()
    }, 0)
  }
}

export function loadExecLog(addr: string, storage: StorageLike | null = safeStorage()): ExecLogEntry[] {
  if (!addr || !storage) return []
  try {
    const raw = storage.getItem(KEY(addr))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (r): r is ExecLogEntry =>
          r &&
          Number.isFinite(r.ts) &&
          r.ts > 0 &&
          (r.kind === 'rebalance' || r.kind === 'create' || r.kind === 'publish' || r.kind === 'swap') &&
          (r.totalUsd === null || Number.isFinite(r.totalUsd)) &&
          typeof r.simulated === 'boolean',
      )
      .map((r) => ({
        ts: r.ts,
        kind: r.kind,
        // A PARTIAL row may not claim money it never moved: without `changes`
        // to back the figure, the honest value is "unknown" (audit round 3).
        totalUsd: r.partial === true && !Array.isArray(r.changes) ? null : r.totalUsd,
        simulated: r.simulated,
        // partial-run fields, clamped like everything else crossing the seam
        ...(r.partial === true ? { partial: true as const } : {}),
        ...(typeof r.stoppedAt === 'string' && r.stoppedAt.length > 0
          ? { stoppedAt: r.stoppedAt.slice(0, 80) }
          : {}),
        ...(Number.isInteger(r.failedLegIndex) && (r.failedLegIndex as number) >= 0
          ? { failedLegIndex: r.failedLegIndex as number }
          : {}),
        changes: Array.isArray(r.changes)
          ? r.changes
              .filter((c) => c && typeof c.symbol === 'string' && Number.isFinite(c.deltaUsd))
              .map((c) => ({
                symbol: c.symbol.slice(0, 16),
                deltaUsd: Math.round(c.deltaUsd * 100) / 100,
                realizedUsd: Number.isFinite(c.realizedUsd) ? Math.round((c.realizedUsd as number) * 100) / 100 : undefined,
              }))
          : undefined,
      }))
      .slice(-MAX_ENTRIES)
  } catch {
    return []
  }
}
