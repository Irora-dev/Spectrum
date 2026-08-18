import type { BrandConfig } from './theme/brand'
import { SPECTRUM_DNA } from './theme/brand'

// SHIPPED DEFAULT — the create wizard may overwrite this file without --force.
// (Hand-editing instead? Delete the marker line above and the wizard will refuse to
// clobber your work.)
//
// ⚠ OPERATOR-OWNED — UPSTREAM NEVER EDITS THIS FILE AGAIN (policy 2026-08-17).
// Kit policy lives in theme/kit-defaults.ts; your values here always win over
// it. This covenant is enforced at release time (release/check-operator-owned.mjs
// refuses any upstream commit touching this file or site.config.json), so
// pulling kit updates into your fork can never conflict on your own brand.
//
// Your site's look + name. Edit by hand, or let the onboarding wizard write it.
// Change `style` (spectral | aurora | prism | umbra | sylvan | enterprise) and
// `palette` to make the site your own; the default below reproduces the
// reference "spectral" look exactly. `name` is a text wordmark (no logo).
export const brand: BrandConfig = {
  name: 'Spectrum',
  tagline: 'build a portfolio, or basket it',
  style: 'spectral',
  palette: { ...SPECTRUM_DNA },
  // NO defaultChainId HERE, deliberately: per-deploy divergence belongs in the
  // env (VITE_DEFAULT_CHAIN_ID, resolved in lib/chain/active-chain.ts). This
  // file stays pure data — the create wizard both reads and rewrites it.
}

export default brand
