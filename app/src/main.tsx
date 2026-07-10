import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import brand from './brand.config'
import { applyBrand } from './theme/theme'
import { validateSiteName } from './theme/brand'
import { loadDraft } from './theme/setup-draft'

// Apply the operator's brand (colours + structure + fonts) before first paint (no flash).
// The default `spectral` brand reproduces the reference tokens exactly → unchanged.
applyBrand(brand)

// A saved Setup-studio draft (this browser only) previews on top — so the operator's
// in-progress look persists across navigation/reload. Real visitors have no draft and
// always see the committed brand.config above.
const setupDraft = loadDraft()
if (setupDraft) applyBrand(setupDraft)

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
