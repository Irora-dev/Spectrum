// ─────────────────────────────────────────────────────────────────────────────
// LANDED PUBLISH LANES — the bundle ceremony's cross-reload memory.
//
// A bundle publish is sequential real deploys under ONE shared name. The
// ceremony already remembers landed lanes within a session (alreadyLive →
// seedPublishLanes marks them done, the name locks), but that memory lived in
// a useRef: a page RELOAD mid-bundle restored the draft with the memory gone,
// so re-running the ceremony re-armed lanes that had already deployed — a
// paid duplicate under the same (deployer, name). 2026-08-12 audit headliner.
//
// This row is that memory, persisted beside the composer draft and keyed by
// the SHIPPED name (the bundle's grouping key), so every mount of the
// ceremony — the Composer's and the portfolio flow's — reads and writes the
// same truth. Cleared only when a publish completes (the mix clears with it);
// a mid-ceremony close or reload keeps it, which is the point.
//
// IT ALSO CARRIES THE DEPLOYER (2026-08-13). A bundle is the tuple (deployer,
// name) — thesis.ts groups on both — so the name alone was only half the
// memory: a reload plus a wallet switch let a second wallet finish the run and
// produced two fragments that will never group. The row now remembers WHO
// deployed the landed lanes, and the ceremony refuses to resume under anyone
// else (publish-bundle-model's deployerRefusal owns the sentence).
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'spectrum:landed-lanes:v1'

const isAddr = (v: unknown): v is `0x${string}` => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)

export interface LandedLane {
  chainId: number
  /** The deployed basket, or null when the deploy confirmed but the address
   *  could not be read back (DONE, never retried — the ceremony's own rule). */
  newAddress: `0x${string}` | null
}

export interface LandedLanesRow {
  /** The shipped name — the grouping key every lane deployed under. */
  name: string
  /** The wallet the landed lanes deployed FROM — the other half of the bundle's
   *  identity. Null on a row written before this field existed (or by a caller
   *  that never anchored): an UNBOUND resume, behaving exactly as it did then.
   *  Never fabricate one — an unknown anchor refuses nobody. */
  deployer: `0x${string}` | null
  /** WHAT the run was deploying — the composition digest (bundleSubjectOf) of
   *  the shipping groups, written with the first landed lane. THE HIJACK
   *  GUARD (the owner live 2026-08-14: composing a brand-new bundle, the publish
   *  stage resumed his OLD interrupted run — locked to its name, refusing to
   *  redeploy). A resume is offered only to the draft whose subject matches;
   *  a different draft sees the old run PARKED, never inherited. Absent on
   *  legacy rows — which therefore never auto-seed, only park. */
  subject?: string
  lanes: LandedLane[]
  savedAt: number
}

/** The composition digest a run is identified by: per-chain sorted asset
 *  addresses, chains sorted — the SUBJECT, independent of the editable name
 *  (renames of the same mix keep resuming; a different mix never does). */
export function bundleSubjectOf(groups: readonly { chainId: number; assets: readonly { address: string }[] }[]): string {
  return [...groups]
    .map((g) => `${g.chainId}:${g.assets.map((a) => a.address.toLowerCase()).sort().join(',')}`)
    .sort()
    .join('|')
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function loadLandedLanes(storage: Storage | null = safeStorage()): LandedLanesRow | null {
  try {
    const raw = storage?.getItem(KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<LandedLanesRow>
    if (typeof d.name !== 'string' || d.name.length === 0 || !Array.isArray(d.lanes)) return null
    const lanes = d.lanes.filter(
      (l): l is LandedLane =>
        !!l &&
        Number.isInteger(l.chainId) &&
        (l.newAddress === null || (typeof l.newAddress === 'string' && /^0x[0-9a-fA-F]{40}$/.test(l.newAddress))),
    )
    if (lanes.length === 0) return null
    return {
      name: d.name,
      deployer: isAddr(d.deployer) ? d.deployer : null,
      ...(typeof d.subject === 'string' && d.subject.length > 0 ? { subject: d.subject } : {}),
      lanes,
      savedAt: typeof d.savedAt === 'number' ? d.savedAt : 0,
    }
  } catch {
    return null
  }
}

/** Record one landed lane. A different name replaces the row outright — one
 *  in-flight bundle at a time, same as the single composer draft. The row's
 *  DEPLOYER survives a same-name write untouched (this is called by the
 *  ceremony's hosts, which know the lane but not the anchor — setLandedDeployer
 *  writes that), and is dropped with the rest when the name changes. */
export function recordLandedLane(
  name: string,
  lane: LandedLane,
  subject?: string,
  storage: Storage | null = safeStorage(),
): void {
  if (!name) return
  try {
    const cur = loadLandedLanes(storage)
    const same = cur && cur.name === name ? cur : null
    const lanes = same ? same.lanes.filter((l) => l.chainId !== lane.chainId) : []
    lanes.push(lane)
    // the subject binds at the FIRST landed lane and never moves after — the
    // run's identity is what it was deploying when money first landed
    const keptSubject = same?.subject ?? (typeof subject === 'string' && subject.length > 0 ? subject : undefined)
    storage?.setItem(
      KEY,
      JSON.stringify(
        { name, deployer: same?.deployer ?? null, ...(keptSubject ? { subject: keptSubject } : {}), lanes, savedAt: Date.now() } satisfies LandedLanesRow,
      ),
    )
  } catch {
    /* storage unavailable: the session ref still carries the ceremony */
  }
}

/** Anchor the row to the wallet that deployed its lanes — write-once per row.
 *  The FIRST landed lane's deployer is the bundle's creator on-chain; a later
 *  call under a different wallet must never move it (that is the very switch
 *  the ceremony refuses). A no-op when no row for that name exists yet: the
 *  ceremony calls this straight after its host recorded the lane, so the row is
 *  there — and a host that persists nothing has no resume to bind. */
export function setLandedDeployer(
  name: string,
  deployer: string | null | undefined,
  storage: Storage | null = safeStorage(),
): void {
  if (!name || !isAddr(deployer)) return
  try {
    const cur = loadLandedLanes(storage)
    if (!cur || cur.name !== name || cur.deployer != null) return
    storage?.setItem(KEY, JSON.stringify({ ...cur, deployer, savedAt: Date.now() } satisfies LandedLanesRow))
  } catch {
    /* storage unavailable: the session anchor still binds this run */
  }
}

export function clearLandedLanes(storage: Storage | null = safeStorage()): void {
  try {
    storage?.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}
