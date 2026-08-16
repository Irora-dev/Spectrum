import type { ReactNode } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { homeOnboardingSeen } from '../../lib/spectrum/home-onboarding-seen'
import { portfolioIntroSeen } from './PortfolioIntro'
import { WALLET_ENABLED } from '../../lib/config/features'

// ─────────────────────────────────────────────────────────────────────────────
// THE CONSOLIDATION (owner 2026-08-06 17:1x: "does the onboarding popup from
// the homepage also just use this system? maybe it should honestly just route
// to this onboarding page?") — it didn't: the first-open VEIL (PortfolioIntro)
// was a parallel implementation of the same story, with its own beats and its
// own found-book reveal. One story, one implementation now: a first-time
// /portfolio visitor routes to /onboarding — the hardened funnel (the latch,
// the liquid reveal, the unified book, the wallet ceremony) — and arrives
// back through its "Visit Portfolio" door with both latches set. Every later
// open renders the portfolio directly.
//
// The veil machinery stays exported for its latches; nothing mounts it.
// Deliberately NOT redirected: the demo door (?demo=1 — a dev catalogue, not
// a first visit), replay links (?intro=replay routes to /onboarding too — one
// re-showing surface), and wallet-off builds (no ceremony to route to).
// ─────────────────────────────────────────────────────────────────────────────

export function OnboardingGate({ children }: { children: ReactNode }) {
  const [params] = useSearchParams()
  const demo = import.meta.env.DEV && params.get('demo') === '1'
  const replay = params.get('intro') === 'replay'
  const seen = homeOnboardingSeen() || portfolioIntroSeen()
  if (WALLET_ENABLED && !demo && (replay || !seen)) return <Navigate to="/onboarding" replace />
  return <>{children}</>
}
