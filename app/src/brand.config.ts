import type { BrandConfig } from './theme/brand'
import { SPECTRUM_DNA } from './theme/brand'

// SHIPPED DEFAULT — the create wizard may overwrite this file without --force.
// (Hand-editing instead? Delete the marker line above and the wizard will refuse to
// clobber your work.)
// Your site's look + name. Edit by hand, or let the onboarding wizard write it.
// Change `style` (spectral | aurora | prism | umbra | sylvan) and `palette` to make the
// site your own; the default below reproduces the reference "spectral" look exactly.
// `name` is a text wordmark (no logo). "Spectrum" is the recommended default
// (owner 2026-07-29): a site built on this kit is an interface to the protocol.
export const brand: BrandConfig = {
  name: 'Spectrum',
  // The tagline was UNSET, so every browser tab, bookmark and the footer fell
  // back to "onchain baskets" — the same half-the-product problem as the old
  // hero, in the one string that follows people around after they leave. This
  // is the hero's short form; an operator overrides it like any other brand key.
  tagline: 'build a portfolio, or basket it',
  style: 'spectral',
  palette: { ...SPECTRUM_DNA },
  // Bundles ship OFF as of 2026-08-01 (the owner): the cross-chain bundle idea is
  // becoming its own product on its own branch, and shipping a half-built
  // creation flow here meanwhile is worse than shipping none. Nothing was
  // removed — deleting this line restores the pages exactly as they were, and
  // the setup studio still lists the toggle.
  // SCOPE NARROWED 2026-08-11: that "own product" then shipped (the published
  // cross-chain Bundle system - home shelf, creator strip, the composer's
  // publish ceremony, Explore's bundle band - none of it page-gated), so this
  // key now gates only what the 2026-08-01 ruling actually targeted: the OLD
  // hand-picked allocations surfaces (BundleGrid, BundleShelf, FeaturedBundle,
  // the forge doors).
  // `create` shipped OFF while the flow's engine was SIMULATED; that comment
  // carried its own retirement clause — "flip it to true (or delete the key)
  // the release after the first real run" — and the first real run happened
  // 2026-08-16 (the live gen-3 buy, executors armed at the flip). The key is
  // DELETED rather than set true: absent = ON is the page-toggle doctrine, so
  // an operator who wants it dark writes `create: false` themselves.
  pages: { bundle: false },
  // NO defaultChainId HERE, deliberately. It used to be `4663` under a "do not
  // merge to main" comment, and that comment was doing a job the code should
  // have been doing: every absorption of this branch into the kit dragged the
  // test line's Robinhood default with it, and UIGuy had to catch and revert it
  // by hand (his 2026-08-06 15:06 note). A divergence that depends on a
  // reviewer noticing it is an incident with a delay on it.
  //
  // This file is IDENTICAL on both lines now. The test deploy sets
  // VITE_DEFAULT_CHAIN_ID instead, resolved in lib/chain/active-chain.ts — the
  // env is where per-deploy divergence belongs, and it keeps this file pure
  // data, which matters because the create wizard both reads and rewrites it
  // (an `import.meta.env` in here does not even typecheck under its config).
}

export default brand
