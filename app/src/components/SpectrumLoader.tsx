// The Spectrum ring loader (owner art, 2026-08-19): a glossy torus whose
// rainbow segment travels the ring — 4 hand-made frames looping as one
// animated WebP (27KB, native alpha, stop-motion at 6fps to match the
// mascot's flipbook voice). Use it wherever the app is genuinely WORKING:
// quote simulation, salt mining, route reads, page-level suspense. Under
// reduced motion it holds the fullest frame as a still.
import ringLoader from '../assets/loader/ring-loader.webp'

export function SpectrumLoader({ size = 28, label, className = '' }: { size?: number; label?: string; className?: string }) {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  return (
    <span role="status" aria-label={label ?? 'Loading'} className={`inline-flex items-center gap-2 ${className}`}>
      <img
        src={ringLoader}
        alt=""
        aria-hidden
        draggable={false}
        width={size}
        height={size}
        className="select-none"
        /* the frame cycle alone read as two poses at small sizes — a slow CSS
           spin over the 6-frame pingpong makes the segment truly travel */
        style={reduced ? undefined : { animation: 'spectrum-ring-spin 2.4s linear infinite' }}
      />
      <style>{`@keyframes spectrum-ring-spin { to { transform: rotate(360deg) } }`}</style>
      {label && <span className="text-[13px] text-ink-dim">{label}</span>}
    </span>
  )
}
