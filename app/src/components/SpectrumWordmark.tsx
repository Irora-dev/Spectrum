// The site wordmark: the operator's brand name (from brand.config.ts), with a band of
// spectral light sweeping through the letters (see `.spectrum-wordmark` in index.css).
// Text only, no logo — the Spectrum Mini kit convention.
import brand from '../brand.config'

export function SpectrumWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`spectrum-wordmark font-display font-bold uppercase ${className}`}>{brand.name}</span>
  )
}
