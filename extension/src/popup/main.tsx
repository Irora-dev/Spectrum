// Fonts are BUNDLED — an extension page must not reach out to the Google Fonts
// CDN (remote resources are a CSP, privacy, and store-review liability). The
// kit's voice: Chakra Petch for numbers and headings, JetBrains Mono for
// tracked micro-labels and the technical body.
import '@fontsource/chakra-petch/500.css'
import '@fontsource/chakra-petch/600.css'
import '@fontsource/chakra-petch/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './theme.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import brand from '@app/brand.config'
import { applyBrand } from '@app/theme/theme'
import { App } from './App'

// The operator's brand, applied exactly as the site applies it at startup —
// palette + style structure land as CSS vars over the static spectral
// defaults, so an operator's popup carries THEIR look with zero divergence.
applyBrand(brand)
document.title = `${brand.name} portfolio`

// …except type: an extension page loads NO remote fonts (CSP/privacy), so the
// preset's font vars are re-pinned to the two bundled faces — Chakra Petch for
// display AND numbers (extension spec 2026-08-02 §3), JetBrains Mono for the
// technical voice. Bundling operator-chosen faces is a kit-build step, later.
// --font-body is left alone: a sans-body style falls through its own stack.
const root = document.documentElement
root.style.setProperty('--font-display', '"Chakra Petch", ui-sans-serif, system-ui, sans-serif')
root.style.setProperty('--font-num', '"Chakra Petch", ui-sans-serif, system-ui, sans-serif')
root.style.setProperty(
  '--font-mono',
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
