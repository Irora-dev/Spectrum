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

export function writeRunLanded(keys: string[]): void {
  try {
    if (keys.length > 0) sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), keys: keys.slice(0, 64) }))
  } catch {
    /* storage unavailable — the landing just doesn't glow */
  }
}

/** Read AND clear — a glow plays once. Stale flags (>10 min) are discarded:
 *  a landing shown an hour later would claim a change the eye can't confirm. */
export function takeRunLanded(): Set<string> {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return new Set()
    sessionStorage.removeItem(KEY)
    const d = JSON.parse(raw) as { at?: number; keys?: unknown }
    if (typeof d.at !== 'number' || Date.now() - d.at > 10 * 60_000 || !Array.isArray(d.keys)) return new Set()
    return new Set(d.keys.filter((k): k is string => typeof k === 'string').map((k) => k.toLowerCase()))
  } catch {
    return new Set()
  }
}
