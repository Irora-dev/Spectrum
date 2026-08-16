import { homeOnboardingSeen } from './home-onboarding-seen'

// ─────────────────────────────────────────────────────────────────────────────
// THE ARRIVAL (the owner 2026-08-06 14:21, routed here by UIGuy): "when you go to
// your portfolio, then it should obviously introduce you to your portfolio. So
// you need to do like, welcome to your portfolio, kind of starting introductory
// text. And then it obviously loads the portfolio in, the positions, et cetera."
//
// The moment is narrow on purpose: the FIRST /portfolio open after someone has
// walked the onboarding act. Not every visit — a greeting you get daily is
// furniture, and this one is meant to land the handoff from "I connected a
// wallet" to "this is mine".
//
// It rides breadcrumbs that already exist (the onboarding-seen latch) plus its
// own one-shot latch, so nothing new is plumbed and the greeting cannot repeat.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'spectrum.portfolio-welcomed.v1'

/** Has this browser already been welcomed to the portfolio? */
function welcomed(): boolean {
  try {
    return localStorage.getItem(KEY) === 'done'
  } catch {
    // storage unavailable: treat as welcomed, so a greeting can never loop
    return true
  }
}

export function markWelcomed(): void {
  try {
    localStorage.setItem(KEY, 'done')
  } catch {
    /* private browsing — it just does not persist */
  }
}

/**
 * Should this page open with the welcome?
 *
 * Both conditions, and each is doing work: they came THROUGH onboarding (so
 * this is a handoff, not a cold visit), and they have not been welcomed before
 * (so it happens once). Reading it does not spend it — the caller marks after
 * it has actually been shown, or a race with a slow book read would burn the
 * greeting on a page that never displayed it.
 */
export function shouldWelcome(): boolean {
  return homeOnboardingSeen() && !welcomed()
}
