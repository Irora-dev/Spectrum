import type { BrandConfig } from './theme/brand'
import { SPECTRUM_DNA } from './theme/brand'

// SHIPPED DEFAULT — the create wizard may overwrite this file without --force.
// (Hand-editing instead? Delete the marker line above and the wizard will refuse to
// clobber your work.)
// Your site's look + name. Edit by hand, or let the onboarding wizard write it.
// Change `style` (spectral | aurora | prism | umbra | sylvan) and `palette` to make the
// site your own; the default below reproduces the reference "spectral" look exactly.
// `name` is a text wordmark (no logo) and must not contain "Spectrum" (see validateSiteName).
export const brand: BrandConfig = {
  name: 'Baskets',
  style: 'spectral',
  palette: { ...SPECTRUM_DNA },
}

export default brand
