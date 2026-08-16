// The detect-and-offer marker. Runs ONLY on the operator's own origin (the
// manifest injects this solely when a site origin is configured at build
// time), and does exactly one thing: stamp the page so the site can offer the
// extension only when it's absent. No reading, no listening, no page access
// beyond the one attribute + one event.
//
// KEEP THIS FILE TYPESCRIPT-SYNTAX-FREE. The Firefox build copies it through
// an esbuild transform, and its whole value is being trivially auditable.
;(() => {
  try {
    const version = chrome.runtime.getManifest().version
    document.documentElement.dataset.spectrumLens = version
    document.documentElement.dispatchEvent(
      new CustomEvent('spectrum-lens', { detail: { version } }),
    )
  } catch {
    // Never break the host page for a convenience marker.
  }
})()
