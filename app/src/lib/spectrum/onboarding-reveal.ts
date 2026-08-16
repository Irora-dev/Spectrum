// ─────────────────────────────────────────────────────────────────────────────
// PER-WALLET onboarding memory. The /portfolio gate and the home latch are
// per-BROWSER — one visit to /onboarding latches the device forever. The
// arrival's reveal memory has always been per-WALLET (which owners have had
// their book played on this device). Extracted from Onboarding.tsx on the
// owner's 2026-08-12 report ("doesn't prompt me to onboard" with a freshly
// connected real wallet): his browser was long-latched from days of reviewing,
// so the gate never routed him, and nothing else asked. The reveal memory is
// the honest per-wallet fact, and /portfolio's invite plate needs to read it
// too — so it lives in lib now. Keys and semantics unchanged.
// ─────────────────────────────────────────────────────────────────────────────

// The per-owner reveal memory. Device-local like every latch here; capped so
// a wallet-hopping session can't grow it unbounded.
const REVEALED_KEY = 'spectrum.onboarding-revealed.v1'

/** The stored owner list, or [] when the row is absent, corrupt, or storage
 *  is unavailable — so a corrupted row can never brick a WRITE (the old
 *  in-page writer parsed inside its own try and a bad row aborted the write
 *  forever; a write now heals it). */
function readList(key: string): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(raw) ? (raw as string[]) : []
  } catch {
    return []
  }
}

function addToList(key: string, owner: string): void {
  const next = [...new Set([...readList(key), owner.toLowerCase()])].slice(-20)
  try {
    window.localStorage.setItem(key, JSON.stringify(next))
  } catch {
    /* private mode — it simply does not persist */
  }
}

export function hasSeenReveal(owner: string): boolean {
  return readList(REVEALED_KEY).includes(owner.toLowerCase())
}

export function markSeenReveal(owner: string): void {
  addToList(REVEALED_KEY, owner)
}

// The invite's own per-wallet dismissal: "not now" is an answer the plate must
// remember PER WALLET, or it becomes a nag for one owner and stays silent for
// the next. Same shape and cap as the reveal list.
const INVITE_DISMISSED_KEY = 'spectrum.onboarding-invite-dismissed.v1'

export function inviteDismissed(owner: string): boolean {
  try {
    const list = JSON.parse(window.localStorage.getItem(INVITE_DISMISSED_KEY) ?? '[]') as unknown
    return Array.isArray(list) && list.includes(owner.toLowerCase())
  } catch {
    // storage unreadable (NOT merely corrupt): treat as dismissed — an invite
    // that cannot remember "no" must never show (the portfolio-welcome
    // anti-loop rule, applied here)
    return true
  }
}

export function dismissOnboardingInvite(owner: string): void {
  addToList(INVITE_DISMISSED_KEY, owner)
}

/** Should /portfolio invite this connected wallet into onboarding?
 *
 *  True only for a wallet that has NEVER had its arrival played on this device
 *  and whose invite hasn't been dismissed. The browser-wide latch is untouched:
 *  the OnboardingGate still owns first visits; this owns the per-wallet ask. */
export function shouldInviteOnboarding(owner: string): boolean {
  return !hasSeenReveal(owner) && !inviteDismissed(owner)
}

// The gate's escape hatch is SESSION-scoped, deliberately (owner 2026-08-13,
// second report, minutes after the reveal-keyed gate shipped: his wallet had
// been marked revealed WITHOUT the add step ever completing, so the ceremony
// said "done" while the book said "empty" and the gate stood down — "we
// cannot have this limbo state be possible". A permanent dismissal row would
// re-open that limbo forever, so "browse without onboarding" answers for the
// VISIT; a fresh visit with a still-empty book asks again.)
const GATE_BROWSE_KEY = 'spectrum.portfolio-gate-browse.v1'

export function browseWithoutOnboarding(owner: string): void {
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(GATE_BROWSE_KEY) ?? '[]') as unknown
    const list = Array.isArray(raw) ? (raw as string[]) : []
    window.sessionStorage.setItem(
      GATE_BROWSE_KEY,
      JSON.stringify([...new Set([...list, owner.toLowerCase()])].slice(-20)),
    )
  } catch {
    /* private mode — the in-page dismissal state still carries this visit */
  }
}

export function browsedThisSession(owner: string): boolean {
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(GATE_BROWSE_KEY) ?? '[]') as unknown
    return Array.isArray(raw) && (raw as string[]).includes(owner.toLowerCase())
  } catch {
    // sessionStorage unreadable: treat as browsed — a gate that cannot
    // remember "not now" must not nag in a loop (the anti-loop rule)
    return true
  }
}

/** THE RENDER MATRIX for /portfolio's entry face (owner 2026-08-13: "if a
 *  person like me genuinely doesn't finish the signup, the portfolio page
 *  should just have a pretty card that says you must complete onboarding" —
 *  and, the same night, "we cannot have this limbo state be possible").
 *
 *  KEYED ON THE OUTCOME, NOT THE CEREMONY: the first cut consulted the
 *  arrival's reveal memory, and the owner's own wallet was the counter-case —
 *  marked revealed without the ADD ever completing, an empty book wearing
 *  full chrome. What the gate actually protects is "this page has nothing to
 *  show you and onboarding is how it gets something", and the only honest key
 *  for that is the BOOK (the saved allocation + hand-added assets, both
 *  device-local synchronous reads the caller passes as `bookEmpty`).
 *
 *  True = the page renders ONE full-page gate card instead of its chrome.
 *  The contract, row by row, pinned by tests:
 *   · disconnected              → false (the ConnectGate face owns that)
 *   · demo door (?demo=1)       → false (a catalogue, not a wallet)
 *   · dev-preview stand-in      → false (it is never `connected`)
 *   · book has ANYTHING in it   → false (added or hand-added — the page has
 *                                  something true to show)
 *   · SIGNED IN on this device  → false (the login latch, the owner 2026-08-13:
 *                                  "'log into' your portfolio by signing" —
 *                                  a wallet that signed in, or whose VERIFIED
 *                                  linked member did, is never re-gated; the
 *                                  caller passes the group-aware read, and
 *                                  the page's add-attempted effect closes the
 *                                  empty-book seam)
 *   · revealed but book EMPTY   → TRUE (the limbo: ceremony done, outcome
 *                                  missing — the gate keys on the outcome)
 *   · browsed this session      → false (the escape hatch holds for the
 *                                  visit; a new visit with an empty book
 *                                  asks again — never a permanent limbo)
 *   · connected + empty + not browsed + never signed in → TRUE
 *  A render swap on /portfolio itself — never a redirect (anti-loop laws).
 *  `signedIn` is a caller-passed sync read (portfolio-signin's latch), the
 *  same shape as `bookEmpty` — the matrix stays pure and dependency-free. */
export function shouldGatePortfolio(opts: {
  connected: boolean
  owner: string | null | undefined
  demo: boolean
  bookEmpty: boolean
  signedIn: boolean
}): boolean {
  return (
    opts.connected &&
    !!opts.owner &&
    !opts.demo &&
    opts.bookEmpty &&
    !opts.signedIn &&
    !browsedThisSession(opts.owner)
  )
}
