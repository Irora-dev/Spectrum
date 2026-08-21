import { describe, expect, it } from 'vitest'
// ?raw glob, not node:fs — a browser project's tsconfig carries no node types;
// this mirrors deployer-strings.guard.test.ts, the repo's whole-tree scan idiom.

// ─────────────────────────────────────────────────────────────────────────────
// THE IMPORT-BOUNDARY RATCHET — the A↔B edge set may SHRINK, never grow.
//
// This app carries two products in one tree: A, the portfolio system
// (own-wallet multi-token execution — the carve flow, the runner, funding
// plans, floors, the own-holdings model), and B, the basket product (mint /
// redeem / launch / reshape / theses / bundles). A separation is planned; the
// staged severs live in the split's planning workspace. Until the boundary
// lands, the danger is quiet regrowth: every new import that reaches across
// the product line is another edge someone must cut later, and nothing today
// would even notice it landing.
//
// So this guard freezes the CURRENT cross-boundary edge set — measured, not
// aspirational — and asserts exact equality. Removing an edge is progress:
// delete it from BASELINE in the same commit and the list ratchets down.
// Adding one fails with the edge named. A genuinely intended new cross-import
// is a boundary decision, not a reflex — the failure message says so.
//
// Classification is by explicit lists (below). A file matching neither list is
// NEUTRAL/shared — imports to or from neutral files never count. That keeps
// the guard honest about what it knows: it polices edges between files whose
// product side is settled, and stays silent on genuinely shared infrastructure
// (BasketBento, TradePrism, the pools library, chain config, chrome).
//
// ⚠ GLOB-KEY TRAP (this file's first cut died on it): Vite normalizes keys to
// the SHORTEST relative form, so same-directory files arrive as './foo.ts'
// while everything else arrives as '../../pages/Foo.tsx'. Both forms must be
// normalized or the entire lib/spectrum set silently drops out of the scan —
// the scale assertions below exist to make that class of rot loud.
// ─────────────────────────────────────────────────────────────────────────────

const FILES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob('../../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
  )
    .filter(([path]) => !/\.test\.tsx?$/.test(path) && !/__(fixtures|mocks)__/.test(path))
    .map(([path, src]) => [path.replace(/^\.\.\/\.\.\//, '').replace(/^\.\//, 'lib/spectrum/'), src]),
)

// ── The product lists (the split's boundary evidence, frozen 2026-08-18) ────

/** lib/spectrum modules that are PORTFOLIO (A) — extensionless basenames. */
const A_MODULES = new Set([
  // core money path
  'allocation', 'batcher', 'portfolio-batcher', 'plan-legs', 'floor-discipline',
  'displayed-vs-signed', 'execution-runner', 'runner-effects', 'submission-store',
  'capability-ladder', 'execution-arming', 'portfolio-run-wiring', 'portfolio-run-market',
  'use-execution-runner', 'hop-reserve', 'refuel', 'economic-leg-cap', 'zeroex-quote',
  'assemble-batch', 'shadow-pipeline', 'rebalance-batcher', 'batch-fee-verification',
  'realised-price', 'routing', 'adversarial-wallet', 'mempool-exposure',
  'pool-safety', 'acquisition-route', 'acquisition-inputs', 'leg-preflight', 'failure-log',
  // the CoW limit-order lane
  'cow', 'cow-api', 'cow-pending', 'use-cow-orders', 'app-data', 'allowances', 'permit2',
  'order-intent', 'order-commitments', 'limit-price',
  // LP / range orders
  'range-order', 'lp-positions',
  // the own-wallet holdings model + portfolio surfaces' data layer
  'insights', 'position-intents', 'publish-picks', 'seed-from-holdings', 'exposure',
  'raw-holdings', 'use-raw-holdings', 'chain-totals', 'asset-unify', 'dust-fold',
  'manual-assets', 'seen-assets', 'found-book', 'use-book-total', 'portfolio-signin',
  'portfolio-welcome', 'onboarding-reveal', 'release-surface', 'change-attribution',
  'portfolio-history', 'use-portfolio-history', 'use-exit-costs', 'history-insights',
  'use-history-insights', 'away-diff', 'csv-export', 'last-seen',
  // wave-A hardening modules (journal/reconciliation/lint are run-side)
  'run-journal', 'post-trade-reconciliation', 'calldata-lint',
  // funding-plan is DECLARED portfolio-owned (it is money-core, digest-set):
  // today's basket-side imports of it are frozen edges the split must cut —
  // the shared seam for the types both sides need is plan-shared-types.
  'funding-plan',
])

/** lib/spectrum modules that are BASKET (B). thesis-run-types sits here on
 *  purpose: it is B-shaped, and the A-core imports of it are exactly the
 *  staged severs — classifying it B keeps those edges visible until they cut. */
const B_MODULES = new Set([
  'use-basket-swap', 'use-dex-swap', 'swap-quote', 'swap-sim', 'use-swap-sim',
  // caller-split re-read 2026-08-19: it is the D-R1 mint-split GUARD (basket
  // launch domain, mint-funding's sibling) — the first classification put it
  // DARK-A by its importer graph; its subject decides instead
  'caller-split',
  'mint-funding', 'use-mint-funding', 'first-mint-split', 'contract-split',
  'launch-first-mint', 'split-guard', 'shown-floor', 'delta-trade', 'pay-token',
  'pay-prefill', 'use-sweep', 'use-swap-migrate', 'use-migrate', 'fee-model',
  'use-basket-fees', 'use-fee-actions', 'use-fee-state', 'flush-eligibility',
  'launch-batch', 'use-deploy', 'deploy', 'salt-mining', 'salt-init-code',
  'salt-miner.worker', 'create2-mine', 'bundle', 'leg-health', 'use-mint-health',
  'thesis-sell', 'fair-mint', 'thesis', 'thesis-funding', 'thesis-pay-asset',
  'thesis-url', 'thesis-run', 'thesis-run-types', 'seed-guard', 'launch-doors',
  'launch-duplicates', 'launch-journey', 'launch-names',
])

/** Directory prefixes (under src/) owned by one side outright. */
const A_DIRS = ['components/allocate/', 'components/portfolio/']
const B_DIRS = ['components/launch/', 'components/reshape/', 'components/thesis/', 'creator/']

/** Bare components (extensionless basenames directly under components/). */
const A_COMPONENTS = new Set([
  'PositionsMode', 'PublishPicker', 'AssetSearchModal', 'TrimBar', 'MoneyFacets',
  'RangeOrderPanel', 'PortfolioChart', 'PortfolioExposure', 'PortfolioClaims',
  'RiskSpectrum', 'InsightCard', 'HomeOnboarding',
])
const B_COMPONENTS = new Set([
  'DexSwapCard', 'TradePanel', 'SweepPanel', 'MigrateModal', 'FeePanel',
  'SeedBasketModal', 'PayTokenPicker', 'SwapPendingOverlay', 'BundleForge',
  // basket-product surfaces (a parallel measurement's finding, folded in) —
  // BasketAvatar and BasketBento stay SHARED chrome on purpose
  'BasketCard', 'BasketWash', 'BundleShelf', 'BundleHero', 'BasketContents',
])

/** Pages (extensionless basenames under pages/). Yours carries both products
 *  today — it is classified A because the portfolio surface is its spine, so
 *  its basket imports are frozen edges the split must cut, not invisible. */
const A_PAGES = new Set(['Yours', 'Portfolio', 'Onboarding', 'Manager'])
const B_PAGES = new Set([
  'Token', 'Explore', 'Bundle', 'Create', 'Composer', 'Flush', 'Thesis',
  'Creator', 'League', 'SlashCreators', 'Swap', 'Embed', 'BuySuccessTest', 'PostDeployTest',
])

type Side = 'A' | 'B' | null

/** Classify an extensionless src-relative path ('lib/spectrum/allocation',
 *  'components/allocate/PortfolioFlow', 'pages/Yours'). */
function classify(p: string): Side {
  for (const d of A_DIRS) if (p.startsWith(d)) return 'A'
  for (const d of B_DIRS) if (p.startsWith(d)) return 'B'
  const m = p.match(/^lib\/spectrum\/([^/]+)$/)
  if (m) return A_MODULES.has(m[1]) ? 'A' : B_MODULES.has(m[1]) ? 'B' : null
  const c = p.match(/^components\/([^/]+)$/)
  if (c) return A_COMPONENTS.has(c[1]) ? 'A' : B_COMPONENTS.has(c[1]) ? 'B' : null
  const g = p.match(/^pages\/([^/]+)$/)
  if (g) return A_PAGES.has(g[1]) ? 'A' : B_PAGES.has(g[1]) ? 'B' : null
  return null
}

/** Resolve a relative import specifier against the importing file's dir and
 *  answer the extensionless src-relative target. Package imports answer null. */
function resolveTarget(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const clean = spec.replace(/\?.*$/, '').replace(/\.(ts|tsx)$/, '')
  const parts = fromFile.split('/').slice(0, -1)
  for (const seg of clean.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/** Every import edge in a source: static `import … from 'x'`, re-exports
 *  `export … from 'x'`, and lazy `import('x')`. */
function importSpecs(src: string): string[] {
  const specs: string[] = []
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g)) specs.push(m[1])
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1])
  return specs
}

function measureCrossEdges(): string[] {
  const edges = new Set<string>()
  for (const [file, src] of Object.entries(FILES)) {
    const fromPath = file.replace(/\.(ts|tsx)$/, '')
    const fromSide = classify(fromPath)
    if (!fromSide) continue
    for (const spec of importSpecs(src)) {
      const target = resolveTarget(file, spec)
      if (!target) continue
      const toSide = classify(target)
      if (!toSide || toSide === fromSide) continue
      edges.add(`${fromPath} -> ${target}`)
    }
  }
  return [...edges].sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// RATCHET — this list may only SHRINK. Measured 2026-08-18 at the split's
// staging point. Deleting an edge you severed is the ratchet working; adding
// one must fail here and go to the split's boundary decision instead.
// ─────────────────────────────────────────────────────────────────────────────
const BASELINE: string[] = [
  'components/PortfolioClaims -> lib/spectrum/use-fee-actions',
  'components/PortfolioClaims -> lib/spectrum/use-fee-state',
  'components/PositionsMode -> components/BasketContents',
  'components/portfolio/BasketHolderStats -> components/DexSwapCard',
  'components/reshape/ReshapeThesisModal -> components/AssetSearchModal',
  'components/reshape/ReshapeThesisModal -> components/TrimBar',
  'components/reshape/ShapeEditor -> components/AssetSearchModal',
  'components/reshape/ShapeEditor -> components/TrimBar',
  'lib/spectrum/use-exit-costs -> lib/spectrum/swap-quote',
  'lib/spectrum/use-exit-costs -> lib/spectrum/swap-sim',
  'pages/Composer -> components/TrimBar',
  'pages/Creator -> components/PortfolioClaims',
  'pages/Manager -> components/BundleHero',
  'pages/Portfolio -> components/BasketCard',
  'pages/Portfolio -> components/BasketWash',
  'pages/Portfolio -> components/BundleShelf',
  'pages/Portfolio -> lib/spectrum/thesis',
  'pages/Portfolio -> lib/spectrum/use-fee-actions',
  'pages/Yours -> components/BasketContents',
  'pages/Yours -> components/MigrateModal',
  'pages/Yours -> lib/spectrum/thesis',
  'pages/Yours -> lib/spectrum/thesis-url',
  'pages/Yours -> lib/spectrum/use-fee-actions',
]

describe('the import boundary between the portfolio and basket products', () => {
  it('cross-boundary edges EQUAL the frozen baseline — shrink by severing, never grow', () => {
    const now = measureCrossEdges()
    const base = new Set(BASELINE)
    const cur = new Set(now)
    const added = now.filter((e) => !base.has(e))
    const removed = BASELINE.filter((e) => !cur.has(e))
    const detail = [
      added.length ? `ADDED cross-boundary edges (cut the import, or take it to the split's boundary decision):\n  ${added.join('\n  ')}` : '',
      removed.length ? `REMOVED edges (severed — delete them from BASELINE in this same commit):\n  ${removed.join('\n  ')}` : '',
    ]
      .filter(Boolean)
      .join('\n')
    expect(now, detail).toEqual(BASELINE)
  })

  it('the scan and the classifier still see both products at scale — an empty side means rot, never cleanliness', () => {
    // the glob-key trap above: if lib/spectrum dropped out of FILES, side A
    // would collapse and the boundary would look "clean" — make that loud.
    expect(FILES['lib/spectrum/plan-legs.ts'], 'lib/spectrum must be in the scan (glob-key normalization rotted)').toBeTruthy()
    expect(FILES['pages/Yours.tsx'], 'pages must be in the scan').toBeTruthy()
    const sides = { A: 0, B: 0 }
    for (const file of Object.keys(FILES)) {
      const s = classify(file.replace(/\.(ts|tsx)$/, ''))
      if (s) sides[s] += 1
    }
    expect(sides.A).toBeGreaterThan(40)
    expect(sides.B).toBeGreaterThan(40)
  })
})
