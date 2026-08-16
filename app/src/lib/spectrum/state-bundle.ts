import { importBundle, type ChainVerifier } from './wallet-links'

// ─────────────────────────────────────────────────────────────────────────────
// STATE BUNDLE — the whole-browser backup (owner ruling 2026-08-03 ~15:2x).
// Everything a user accumulates here is localStorage: targets, drafts,
// executed/published records, cost-basis indexes, wallet links. A browser
// wipe silently deletes their portfolio intent and P&L history — this is the
// recovery story: one JSON file the user carries, same posture as the
// wallet-links bundle (the file is transport, verification happens on import).
//
// WHAT GOES IN: intent + records (allocation state, pnl indexes, the intro
// latch, anything under the spectrum namespaces). WHAT STAYS OUT: caches
// (spectrum:cache:* — re-derivable from chain, restoring one stale is worse
// than refetching) and the wallet-links key, which is NOT restored raw — it
// routes through the links importBundle so every record is signature-verified
// exactly like a links-only file.
//
// IMPORT POSTURE: additive, never a clobber. A key that already exists in
// this browser is SKIPPED and counted — restoring a backup onto a live
// browser must not overwrite newer local work with older remote state. (A
// deliberate "replace" flow can come later if ever asked; silent overwrite
// cannot be undone and is not offered.)
// ─────────────────────────────────────────────────────────────────────────────

const WALLET_LINKS_KEY = 'spectrum.wallet-links.v1'
const CACHE_PREFIX = 'spectrum:cache:'
/** Namespaces that carry intent or records worth backing up. */
const INCLUDE_PREFIXES = ['spectrum:', 'spectrum.', 'pnl:']

export interface StateBundle {
  v: 1
  kind: 'spectrum-state'
  exportedAt: number
  /** Raw localStorage entries, key → stored string. */
  entries: Record<string, string>
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

export function bundleKeyEligible(key: string): boolean {
  if (key.startsWith(CACHE_PREFIX)) return false
  return INCLUDE_PREFIXES.some((p) => key.startsWith(p))
}

export function exportStateBundle(now: number = Date.now()): StateBundle {
  const s = storage()
  const entries: Record<string, string> = {}
  if (s) {
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i)
      if (!key || !bundleKeyEligible(key)) continue
      const value = s.getItem(key)
      if (value != null) entries[key] = value
    }
  }
  return { v: 1, kind: 'spectrum-state', exportedAt: now, entries }
}

export interface StateRestoreReport {
  restored: number
  /** Keys skipped because this browser already holds them (never clobbered). */
  skippedExisting: number
  /** Keys refused: cache-namespace, foreign, or unparseable JSON values. */
  rejected: number
  /** The wallet-links merge, when the bundle carried links. */
  links: { added: number; rejected: number } | null
}

/** Restore a bundle. Returns null when the text is not a state bundle at all
 *  (a links-only file says so rather than half-importing). */
export async function importStateBundle(
  json: string,
  verify?: ChainVerifier | null,
): Promise<StateRestoreReport | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const bundle = parsed as Partial<StateBundle>
  if (bundle?.v !== 1 || bundle.kind !== 'spectrum-state' || typeof bundle.entries !== 'object' || bundle.entries == null)
    return null

  const s = storage()
  const report: StateRestoreReport = { restored: 0, skippedExisting: 0, rejected: 0, links: null }
  for (const [key, value] of Object.entries(bundle.entries)) {
    if (typeof value !== 'string' || !bundleKeyEligible(key)) {
      report.rejected += 1
      continue
    }
    if (key === WALLET_LINKS_KEY) {
      // Links never restore raw — every record re-verifies, exactly as a
      // links-only import would (and merges additively by member).
      report.links =
        verify === undefined ? await importBundle(linksAsBundle(value)) : await importBundle(linksAsBundle(value), verify)
      continue
    }
    // Every stored value in these namespaces is JSON — refuse what is not,
    // rather than planting a value the reader will choke on.
    try {
      JSON.parse(value)
    } catch {
      report.rejected += 1
      continue
    }
    if (!s) continue
    if (s.getItem(key) != null) {
      report.skippedExisting += 1
      continue
    }
    try {
      s.setItem(key, value)
      report.restored += 1
    } catch {
      report.rejected += 1
    }
  }
  return report
}

/** Wrap a raw wallet-links storage value in the links-bundle envelope the
 *  links importer verifies. */
function linksAsBundle(rawValue: string): string {
  try {
    const links = JSON.parse(rawValue)
    return JSON.stringify({ v: 1, exportedAt: 0, links: Array.isArray(links) ? links : [] })
  } catch {
    return JSON.stringify({ v: 1, exportedAt: 0, links: [] })
  }
}

/** ONE import door for both file kinds (the backup and the links-only
 *  bundle), returning the user-worded note — shared by the wallet panel and
 *  the recovery doors on the portfolio's empty states. */
export async function importAnyBundle(json: string): Promise<string> {
  const state = await importStateBundle(json)
  if (state) {
    const parts = [
      `${state.restored} restored`,
      state.skippedExisting > 0 ? `${state.skippedExisting} kept local (newer here)` : '',
      state.links ? `${state.links.added} link${state.links.added === 1 ? '' : 's'} verified` : '',
      state.rejected > 0 ? `${state.rejected} rejected` : '',
    ].filter(Boolean)
    return `Backup restored: ${parts.join(', ')}.`
  }
  const links = await importBundle(json)
  if (links) {
    const refused = links.rejected - links.capped
    const parts = [
      `${links.added} link${links.added === 1 ? '' : 's'} verified and added`,
      refused > 0 ? `${refused} rejected` : '',
      // cap-skipped ≠ signature-refused: a big legit bundle must not read
      // as a pile of bad signatures (audit 2026-08-06 #7)
      links.capped > 0 ? `${links.capped} beyond the 64-record cap were not examined` : '',
    ].filter(Boolean)
    return `${parts.join(', ')}.`
  }
  return 'That file is not a Spectrum backup or wallet-group bundle.'
}

/** Download the whole-state backup as a file — shared by the wallet panel's
 *  full-backup row and the portfolio's backup nudge (one implementation). */
export function downloadStateBackup(): void {
  const blob = new Blob([JSON.stringify(exportStateBundle(), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'spectrum-backup.json'
  a.click()
  URL.revokeObjectURL(url)
}
