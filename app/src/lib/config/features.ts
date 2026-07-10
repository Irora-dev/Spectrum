// ─────────────────────────────────────────────────────────────────────────────
// Feature flags — FULLY INDEPENDENT switches. Each flag resolves: its own
// VITE_ENABLE_* env var when SET (the override layer, incl. an explicit false) →
// else the COMMITTED src/site.config.json `features` (what the setup studio /
// wizard write; the onboarding default is everything on) → else off. The shipped
// site.config.json is all-off, so a clone with NO config artifact at all boots
// read-only (the deliberate safety net: live surfaces always trace to a config
// someone created). The underlying infra (wagmi provider, hooks, readers, tx
// builders, components) always stays in the tree — these flags only control what
// renders / what can broadcast.
//
//   WALLET_ENABLED  — the connect-wallet button. Read-only on its own (lets a
//                     user connect to see their own holdings).
//   DEPLOY_ENABLED  — the launch flow's on-chain broadcast. The creator/issuer
//                     acts for themselves.
//   TRADING_ENABLED — the Flush fee console: the holder fee-claim + the
//                     permissionless cranks. A transactional surface (signs txs).
//                     Does NOT include buy/sell.
//   SWAP_ENABLED    — buy/sell: the /swap page + the Token TradePanel broadcast.
//                     A transactional surface and the ARM SWITCH over the resolved
//                     swap router (the canonical Spectrum router ships in
//                     deployments.json; VITE_SWAP_ROUTER_ADDRESS overrides it —
//                     a basket has no buy/sell method and no aggregator can route
//                     it). Off = no /swap route, no nav link, no trade panel.
//
// The single-purpose artifacts this expresses (one per deployment): all-features
// (the onboarding default) · info-only · creation tool · fee console ·
// marketplace w/ buy/sell. See OPERATORS.md.
//
// Independence means no silent implication in either direction: DEPLOY/TRADING/SWAP
// do NOT read WALLET. A nonsensical combo (any transactional flag without a wallet)
// fails the build loudly below instead of silently degrading — that silent
// degradation would itself be a coupling.
// ─────────────────────────────────────────────────────────────────────────────

import siteConfig from '../../site.config.json'

// Tolerate an OLDER committed site.config.json that predates the `features` block (an
// operator who pulls a kit update keeps THEIR config file — a missing block must mean
// "off", never a module-load crash).
const committedFeatures: Partial<Record<'wallet' | 'deploy' | 'trading' | 'swap', boolean>> =
  (siteConfig as { features?: Partial<Record<'wallet' | 'deploy' | 'trading' | 'swap', boolean>> }).features ?? {}

// Env var SET (any value, so an explicit false overrides) → env; else the committed file.
const flag = (envValue: string | undefined, committed: boolean | undefined): boolean =>
  envValue !== undefined ? envValue === 'true' : committed === true

/** Connect-wallet (and any read-only wallet view, e.g. Portfolio). */
export const WALLET_ENABLED = flag(import.meta.env.VITE_ENABLE_WALLET, committedFeatures.wallet)

/**
 * Launching a basket on-chain (the broadcast in useDeployBasket). Irreversible +
 * costs ETH (Dutch-auction slot), so the broadcast also has a hard runtime guard
 * on this flag in `broadcast()`. Salt mining, auction-price reads, and the
 * dry-run simulation are read-only and run regardless.
 */
export const DEPLOY_ENABLED = flag(import.meta.env.VITE_ENABLE_DEPLOY, committedFeatures.deploy)

/** The Flush fee console — the holder fee-claim + the permissionless cranks. A
 *  transactional surface (signs txs). Does NOT include buy/sell. */
export const TRADING_ENABLED = flag(import.meta.env.VITE_ENABLE_TRADING, committedFeatures.trading)

/**
 * Buy/sell — the `/swap` page + the Token TradePanel broadcast. A transactional
 * surface and the arm switch over the resolved swap router (canonical ships;
 * VITE_SWAP_ROUTER_ADDRESS overrides — a basket has no buy/sell method and no
 * aggregator can route it). Off = the nav link is gone, the Token trade panel is
 * hidden, and the `/swap` page redirects home. The broadcast also hard-guards on
 * this flag in `use-basket-swap.ts`.
 */
export const SWAP_ENABLED = flag(import.meta.env.VITE_ENABLE_SWAP, committedFeatures.swap)

/**
 * The migrate flow's REBALANCE delta (new, 2026-07-05): instead of funding an
 * added leg only from the dropped leg's proceeds, the delta sizes every v2
 * deposit to the balanced target and sells/buys across ALL the migration's
 * proceeds — so the in-kind mint captures the maximum and the end-of-flow sweep
 * shrinks toward zero. Migration-scoped (never trades wallet balances beyond
 * what the redeem delivered) and self-limiting: it only replaces the legacy
 * delta when it mints ≥5% more (REBALANCE_MIN_GAIN_BPS), and any pricing
 * failure falls back to the legacy path automatically. NOT an independent
 * surface — it only shapes the delta inside the TRADING-gated migrate flow, so
 * it defaults ON; set VITE_MIGRATE_REBALANCE=false as the escape hatch back to
 * the legacy delta.
 */
export const MIGRATE_REBALANCE_ENABLED = import.meta.env.VITE_MIGRATE_REBALANCE !== 'false'

// Fail-fast invariant: a transactional surface without a wallet is a
// misconfigured build, not a degraded one.
if ((DEPLOY_ENABLED || TRADING_ENABLED || SWAP_ENABLED) && !WALLET_ENABLED) {
  throw new Error(
    'Misconfigured build: VITE_ENABLE_DEPLOY / VITE_ENABLE_TRADING / VITE_ENABLE_SWAP require VITE_ENABLE_WALLET=true.',
  )
}
