// Serialize the setup studio's Deployment section to the .env.local text (mirrors what the
// create/ CLI writes) — so /setup exports the WHOLE config, not just the look. The studio
// collects ONLY the operator's own values (fee wallet, RPC key, site URL); contracts are the
// shipped canonical deployment (Base, Ethereum + Robinhood Chain, all live) — own-deployment overrides are a
// hand-edit power path (.env.example), never a studio field. DB omitted by design.

import { isAddress } from 'viem'
import { pageEnabled, type PageKey, type PageToggles } from './brand'

export type FeeTier = 'all' | 'info' | 'creation' | 'fees' | 'marketplace'
export interface DeployConfig {
  feeWallet: string
  rpcKey: string
  siteUrl: string
  tier: FeeTier
}

// Every tier connects a wallet (Rabby / MetaMask / Coinbase / WalletConnect); the tier sets
// what a connected visitor can DO. The default is ALL of it (owner decision 2026-07-09:
// every deployment has the full functionality by default); narrower tiers scope down.
const TIER_FLAGS: Record<FeeTier, { wallet?: boolean; deploy?: boolean; trading?: boolean; swap?: boolean }> = {
  all: { wallet: true, deploy: true, trading: true, swap: true },
  info: { wallet: true },
  creation: { wallet: true, deploy: true },
  fees: { wallet: true, trading: true },
  marketplace: { wallet: true, swap: true },
}

// Row labels stay one short line (owner 2026-07-09); the detail lives in
// TIER_DETAILS behind each row's hover ⓘ.
export const TIER_LABELS: Record<FeeTier, string> = {
  all: 'All features, the full site (default)',
  info: 'Info only: browse and read',
  creation: 'Creation: launch baskets',
  fees: 'Fee console: claim + cranks',
  marketplace: 'Marketplace: buy / sell',
}

export const TIER_DETAILS: Record<FeeTier, string> = {
  all: 'Launch, buy / sell, the fee console, and portfolio. Every transaction surface is on, running on the canonical Spectrum contracts.',
  info: 'Browse and read only. Visitors can connect a wallet to view a portfolio; no transactions.',
  creation: 'Creators launch baskets from your site. No buy / sell and no fee console.',
  fees: 'Holders claim fees and anyone can run the permissionless cranks on the flush page. No buy / sell.',
  marketplace: 'The swap page and the token buy / sell panel, live through the resolved router.',
}

// The full site leads (the default); the narrower tiers follow as scope-downs.
export const FEE_TIERS: FeeTier[] = ['all', 'info', 'creation', 'fees', 'marketplace']

// A fresh deploy config — the full site on the shipped canonical deployment; the operator's
// own values (fee wallet / RPC key / site URL) start blank.
export const DEFAULT_DEPLOY: DeployConfig = {
  feeWallet: '', rpcKey: '', siteUrl: '', tier: 'all',
}

export interface DeployIssues {
  feeWallet?: string
  rpcKey?: string
  siteUrl?: string
}

/**
 * Validate the deploy config. Two severities:
 *  • ERROR (blocking) — a REQUIRED field left empty (RPC key + site URL — operators
 *    bring their own, owner 2026-07-09), or a filled field that isn't a
 *    well-formed 0x address; exporting would write a broken/incomplete .env.
 *  • WARNING (non-blocking) — a nudge; the .env is still valid + hand-editable.
 * The fee wallet stays optional. Checksums aren't required (strict: false).
 */
export function validateDeploy(d: DeployConfig): { errors: DeployIssues; warnings: DeployIssues } {
  const errors: DeployIssues = {}
  const warnings: DeployIssues = {}
  const malformed = (v: string) => !!v.trim() && !isAddress(v.trim(), { strict: false })
  const isHttpsUrl = (v: string) => { try { return new URL(v).protocol === 'https:' } catch { return false } }

  if (malformed(d.feeWallet)) errors.feeWallet = 'Not a valid 0x address'
  if (!d.rpcKey.trim()) errors.rpcKey = 'Required. Bring your own key, restricted to your domain (it ships in the public bundle)'
  if (!d.siteUrl.trim()) errors.siteUrl = 'Required. The public address your site will live at'
  else if (!isHttpsUrl(d.siteUrl.trim())) warnings.siteUrl = 'Should be a full https:// URL (used for social cards)'

  return { errors, warnings }
}

/** True when the deploy config has a blocking address error. */
export const hasDeployErrors = (e: DeployIssues): boolean => Object.keys(e).length > 0

// A transactional page can be toggled ON yet be inert because the chosen tier
// doesn't arm the feature flag it needs (brand.ts annotations + features.ts +
// TIER_FLAGS above): launch→deploy, trade→swap, fees→trading, portfolio→wallet.
type ArmedFlag = 'wallet' | 'deploy' | 'trading' | 'swap'
const PAGE_NEEDS: { page: PageKey; flag: ArmedFlag; message: string }[] = [
  { page: 'launch', flag: 'deploy', message: 'Launch is on but needs the Creation tier to deploy baskets.' },
  { page: 'trade', flag: 'swap', message: 'Swap is on but needs the Marketplace tier to buy / sell.' },
  { page: 'fees', flag: 'trading', message: 'Flush is on but needs the Fee console tier to run fee actions.' },
  { page: 'portfolio', flag: 'wallet', message: 'Portfolio is on but needs a wallet (any tier except info) to show holdings.' },
]

/**
 * Coherence check between the pages the operator ships and the tier that powers
 * them: an enabled page whose required flag the tier doesn't arm renders but can't
 * transact. Informational (non-blocking) — the operator may want the page anyway.
 */
export function pageTierWarnings(deploy: DeployConfig, pages: Partial<PageToggles> | undefined): { page: PageKey; message: string }[] {
  const armed = TIER_FLAGS[deploy.tier] ?? {}
  return PAGE_NEEDS.filter(({ page, flag }) => pageEnabled(pages, page) && !armed[flag]).map(({ page, message }) => ({ page, message }))
}

/** The committed deploy identity: src/site.config.json (public by construction — every
 *  value here ships in the client bundle anyway). The RPC key deliberately stays OUT of
 *  this file (owner 2026-07-09: it lives only in the gitignored .env.local). */
export function siteConfigToJson(d: DeployConfig): string {
  const f = TIER_FLAGS[d.tier] ?? TIER_FLAGS.all
  return (
    JSON.stringify(
      {
        siteUrl: d.siteUrl.trim(),
        feeWallet: d.feeWallet.trim(),
        features: { wallet: !!f.wallet, deploy: !!f.deploy, trading: !!f.trading, swap: !!f.swap },
      },
      null,
      2,
    ) + '\n'
  )
}

export function envConfigToText(d: DeployConfig): string {
  const L: string[] = ['# Generated by the on-site Setup studio. Vite reads .env.local.', '']
  L.push('# Your tier (feature flags), site URL and fee wallet live in the COMMITTED')
  L.push('# src/site.config.json — this file carries ONLY the value kept out of git.', '')
  L.push('# RPC key (required) — ships in the public bundle; use a key restricted to your domain.')
  L.push('# This is the ONE value that stays out of git (this file is ignored): on a')
  L.push('# git-connected CI build, set VITE_ALCHEMY_API_KEY in the host dashboard/CLI.')
  L.push(`VITE_ALCHEMY_API_KEY=${d.rpcKey.trim()}`, '')
  L.push('# On a git-connected CI build this file is invisible (gitignored) — set')
  L.push('# VITE_ALCHEMY_API_KEY in the host dashboard/CLI; everything else travels committed.')
  L.push('# The VITE_* vars in .env.example remain as overrides of the committed values.', '')
  L.push('# Contracts are the shipped canonical Spectrum deployment (Base, Ethereum + Robinhood Chain).')
  L.push('# Serving your OWN deployment instead is a hand-edit power path — every override')
  L.push('# (factory, swap router, public infra) is documented in .env.example.')
  L.push('# Database intentionally omitted — the kit ships DB-less. Discovery, charts, leaderboards,')
  L.push('# launch, and referrals all run on chain data alone.')
  L.push('# Creator thesis/profile is deployer-signed JSON. To show it to ALL visitors with no backend,')
  L.push('# commit each signed blob to app/metadata/<chainId>/<basket>.json (ships in the build). An')
  L.push('# external host (VITE_METADATA_BASE_URL) is optional, for baskets you do not bundle.')
  return L.join('\n') + '\n'
}
