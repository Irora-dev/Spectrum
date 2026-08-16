import { brand } from '../../brand.config'
import { pageEnabled, type PageKey } from '../../theme/brand'

// ─────────────────────────────────────────────────────────────────────────────
// The ONE seam for links into the create/portfolio flow (UIGuy convergence
// requirement, 2026-08-02 11:30): flow entries must be flag-aware — a
// hardcoded href to a page an operator turned off bounces to /, so a primary
// CTA would silently land home.
//
// ROUTE TRUTH since 2026-08-12 (owner: "/launch needs to be replaced with
// /create"): /create is the REAL creation surface (Composer face + the deploy
// studio) and rides the `launch` page key, default-ON like every real page.
// The manager engine lives at /manager behind the operator's `create` key —
// default-ON since 2026-08-16 (the executors went real at the flip and the
// first live run landed; brand.config.ts's shipped OFF retired per its own
// clause). An operator ships it dark by writing `create: false`.
//
// `pageEnabled` treats ABSENT keys as ON, the default-ON doctrine of every
// page toggle. This helper stays the only place that knows either path.
// ─────────────────────────────────────────────────────────────────────────────

const CREATE_PAGE_KEY = 'create' as PageKey
const LAUNCH_PAGE_KEY = 'launch' as PageKey

export function createFlowOn(): boolean {
  // Same rule as App.tsx's CREATE_FLOW: dev servers show the flow regardless —
  // the shipped operator default keeps it dark until the executors are real.
  return pageEnabled(brand.pages, CREATE_PAGE_KEY) || import.meta.env.DEV
}

/** Href into the flow's door moment, or null when the operator ships that
 *  flow off — callers hide the affordance (never a link that lands on Home). */
export function flowHref(door: 'keep' | 'publish'): string | null {
  if (door === 'publish') {
    // The REAL creation surface: /create derives basket vs bundle from the
    // picks and publishes for real. No ?door param — bundle-ness is derived,
    // not declared.
    return pageEnabled(brand.pages, LAUNCH_PAGE_KEY) ? '/create' : null
  }
  // The KEEP flow still lives in the manager engine (simulated; batcher-gated
  // for real execution) — its intent seam survives at /manager.
  return createFlowOn() ? '/manager?door=keep' : null
}
