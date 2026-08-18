// ─────────────────────────────────────────────────────────────────────────────
// THE RUN-LANDED HANDOFF (the owner live 2026-08-15: "you hit the button and then
// you see your portfolio bento grid gently change and it makes it obvious
// you've added money / reweighted / added/removed assets"). The completion
// plate writes WHICH assets this run changed; the portfolio page reads it
// ONCE (spend-on-read, the welcome flag's own discipline) and lets those
// tiles glow with the arrival ring the bento already owns — reuse, not a
// second animation system. sessionStorage: a landing is a this-session
// moment, never a durable fact.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'spectrum:run-landed:v1'

/** Same-page delivery (the owner 2026-08-17: "you click view portfolio after
 *  run done and you don't see any pop up… or an update"): the manage flow runs
 *  ON /portfolio, so a mount-time read never fires for it — the write was
 *  landing in storage nobody re-read. The event is how an already-mounted
 *  portfolio hears the landing; fresh mounts still read at mount. */
export const RUN_LANDED_EVENT = 'spectrum:run-landed'

/** One confirmed change row for the arrival plate — dollars as the plan
 *  recorded them (display truth; the chain's own numbers live in the book). */
export interface RunLandedChange {
  key: string
  symbol: string
  fromUsd: number
  toUsd: number
}

/** THE DEFER/ANNOUNCE SPLIT (the owner live 2026-08-18: "run completing
 *  doesn't have a pop up with success… and you don't see the change in the
 *  bento"). The write used to fire ONLY inside one button's onClick — any
 *  other way out of the overlay lost the landing entirely — and for the
 *  same-page manage flow the event fired while the run overlay still covered
 *  the picture, so the portfolio SPENT the landing behind it: glow played,
 *  scroll scrolled, nobody saw either. Now the run WRITES the landing the
 *  moment it reaches done (announce: false — storage only, so every exit
 *  path and every fresh mount inherits it) and ANNOUNCES when the flow
 *  actually leaves the screen — the first moment the picture is visible. */
export function writeRunLanded(keys: string[], changes: RunLandedChange[] = [], opts?: { announce?: boolean }): void {
  try {
    if (keys.length > 0) sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), keys: keys.slice(0, 64), changes: changes.slice(0, 32) }))
  } catch {
    /* storage unavailable — the landing just doesn't glow */
  }
  if ((opts?.announce ?? true) && typeof window !== 'undefined' && keys.length > 0) window.dispatchEvent(new CustomEvent(RUN_LANDED_EVENT))
}

/** Tell an already-mounted portfolio the landing is now VISIBLE-relevant.
 *  Safe to call with nothing pending: the listener's take() answers empty. */
export function announceRunLanded(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(RUN_LANDED_EVENT))
}

/** Read AND clear — a glow plays once. Stale flags (>10 min) are discarded:
 *  a landing shown an hour later would claim a change the eye can't confirm. */
export interface RunLanded {
  keys: Set<string>
  changes: RunLandedChange[]
}

const EMPTY: RunLanded = { keys: new Set(), changes: [] }

export function takeRunLanded(): RunLanded {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return EMPTY
    sessionStorage.removeItem(KEY)
    const d = JSON.parse(raw) as { at?: number; keys?: unknown; changes?: unknown }
    if (typeof d.at !== 'number' || Date.now() - d.at > 10 * 60_000 || !Array.isArray(d.keys)) return EMPTY
    const keys = new Set(d.keys.filter((k): k is string => typeof k === 'string').map((k) => k.toLowerCase()))
    const changes = (Array.isArray(d.changes) ? d.changes : []).filter(
      (c): c is RunLandedChange =>
        !!c && typeof (c as RunLandedChange).key === 'string' && typeof (c as RunLandedChange).symbol === 'string' &&
        Number.isFinite((c as RunLandedChange).fromUsd) && Number.isFinite((c as RunLandedChange).toUsd),
    )
    return { keys, changes }
  } catch {
    return EMPTY
  }
}
