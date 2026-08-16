// ─────────────────────────────────────────────────────────────────────────────
// THE ONBOARDING BREADCRUMB — one story, told once. The homepage's get-started
// act and the portfolio first-open ceremony are the same system; someone who
// walked the homepage act (connected, saw their book) should not get the full
// story pitch again on /portfolio — the ceremony opens on the found step
// instead. The story stays one dot-click away (the dots navigate).
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'spectrum.home-onboarding.seen.v1'

// The in-memory half (audit 2026-08-06 correctness #1): with localStorage
// refusing writes (private mode, quota), the persistent latch never sets and
// the OnboardingGate bounced /portfolio → /onboarding on EVERY visit, all
// session — an inescapable loop. The session flag makes "seen" true for this
// tab regardless of storage weather; persistence remains best-effort.
let seenThisSession = false

export function markHomeOnboardingSeen(): void {
  seenThisSession = true
  try {
    localStorage.setItem(KEY, 'done')
  } catch {
    /* private browsing — the session flag above still carries this tab */
  }
}

export function homeOnboardingSeen(): boolean {
  if (seenThisSession) return true
  try {
    return localStorage.getItem(KEY) === 'done'
  } catch {
    return false
  }
}
