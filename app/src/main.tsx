import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import brand from './brand.config'
import { applyBrand } from './theme/theme'
import { validateSiteName } from './theme/brand'
import { loadDraft } from './theme/setup-draft'
import { initViewerDesignMode } from './theme/design-mode'

// Apply the operator's brand (colours + structure + fonts) before first paint (no flash).
// The default `spectral` brand reproduces the reference tokens exactly → unchanged.
applyBrand(brand)

// A saved Setup-studio draft (this browser only) previews on top — so the operator's
// in-progress look persists across navigation/reload. Real visitors have no draft and
// always see the committed brand.config above.
//
// ⚠ A DRAFT MUST NOT BE ABLE TO WHITE-SCREEN THE SITE. This runs at module scope
// ABOVE createRoot, so anything that throws here takes the whole app down and
// keeps doing it: the draft stays in localStorage, so every reload re-throws.
// Reproduced with a field-poor draft (no `palette`) — applyBrand reads through
// it, throws, and React never mounts. That is reachable without an attacker: a
// draft written by an OLDER kit, before a key existed, is exactly the case
// loadDraft's own doc comment describes, and merging it over the committed
// brand is the mitigation it already implements — the boot path just was not
// passing the argument that turns it on. Same class as the poisoned-session
// chat DoS closed in the 2026-08-21 audit, on the brand path instead.
let setupDraft: ReturnType<typeof loadDraft> = null
try {
  setupDraft = loadDraft(brand)
  if (setupDraft) applyBrand(setupDraft)
} catch {
  // a draft we cannot render is a draft we ignore: re-apply the committed brand
  // whole, in case the failed attempt left half its tokens on the root
  setupDraft = null
  applyBrand(brand)
}

// The viewer's own design mode (the menu toggle) re-skins whatever the visitor
// would otherwise see — committed brand or the operator's in-progress draft.
// honourBrandStyle while a DRAFT is in play: the Setup studio has to show the
// operator the style they are drafting, never the shipped light default, or the
// tool misreports its own output on every reload (design-mode.ts).
initViewerDesignMode(setupDraft ?? brand, { honourBrandStyle: !!setupDraft })

// Dev-time guard: the site name must not be "Spectrum*" and must fit the wordmark.
if (import.meta.env.DEV) {
  const check = validateSiteName(brand.name)
  if (!check.ok) console.warn(`[brand.config] invalid site name: ${check.error}`)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
