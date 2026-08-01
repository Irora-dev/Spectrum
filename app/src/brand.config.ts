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
  style: 'spectral',
  palette: { ...SPECTRUM_DNA },
  // Bundles ship OFF as of 2026-08-01 (Colby): the cross-chain bundle idea is
  // becoming its own product on its own branch, and shipping a half-built
  // creation flow here meanwhile is worse than shipping none. Nothing was
  // removed — deleting this line restores the pages exactly as they were, and
  // the setup studio still lists the toggle.
  pages: { bundle: false },
  // No `defaultChainId` here on purpose: the kit ships BASE-first. The lab branch
  // sets 4663 for the stocks-forward demo, and that override is deliberately not
  // promoted — an operator picks their own default in /setup or this file.
}

export default brand
