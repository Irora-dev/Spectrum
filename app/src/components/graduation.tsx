// ─────────────────────────────────────────────────────────────────────────────
// GRADUATION — the declared bridge from the portfolio surfaces INTO the basket
// product (the mirror of lib/spectrum/portfolio-handoff.ts, which bridges the
// other way).
//
// The carve flow genuinely uses the basket product, on purpose — these are
// features, not accidents:
//   · PUBLISH: a finished carve graduates into a launched basket or bundle
//     (the resolver, the bundle-draft grouping, the publish modal);
//   · BUY THROUGH THE BASKET RUNNER: buying a published basket/bundle from
//     the portfolio surface drives the basket product's own run machinery
//     (seed plan, run persistence, the run overlay) — the REAL machinery,
//     never a lookalike (the reuse law);
//   · SEED SAFETY: draft assets take the launch lane's seed-guard verdicts.
//
// Before this file those were nine separate imports scattered through a
// 5,700-line engine — undeclared product-boundary crossings the split's
// ratchet froze one by one. Now they are ONE bridge with a stated contract:
//
//   WHEN THE PORTFOLIO UI LEAVES THIS APP (the split's removal week), this
//   file is deleted with it — nothing else imports it. A successor portfolio
//   product re-implements exactly this file's surface, most of it as a URL
//   hand-off to this app's composer rather than as code (the split plan's
//   cross-product bridge). Until then the imports live here so the boundary
//   has one door, not nine.
//
// Same rules as portfolio-handoff: thin, no state of its own, no new
// derivation of any money number. If a name here grows behavior, it has
// picked a side and must move out.
// ─────────────────────────────────────────────────────────────────────────────

export { resolveAsset } from './launch/BasketBuilder'
export { PublishBundleModal } from './reshape/PublishBundleModal'
export { groupBundleDraft, isBundleDraft, type BundleGroup } from './reshape/publish-bundle-model'
export { seedThesisOf } from './reshape/seed-plan'
export { ThesisRunOverlay } from './thesis/ThesisRunOverlay'
export { seedGuard } from '../lib/spectrum/seed-guard'
export { readThesisFunds } from '../lib/spectrum/thesis-funding'
export { loadThesisRun, runProgress } from '../lib/spectrum/thesis-run'
export { thesisRef } from '../lib/spectrum/thesis-url'
