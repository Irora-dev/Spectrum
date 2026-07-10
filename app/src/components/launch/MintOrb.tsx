import { useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { AssetLogo } from '../AssetLogo'
import { PixelDissolve } from '../PixelDissolve'

export type MintStatus = 'forming' | 'added'

const SPECTRAL_CONIC =
  'conic-gradient(from 0deg, var(--color-amber), var(--color-magenta), var(--color-violet), var(--color-cyan), var(--color-teal), var(--color-amber))'
// stable ref so PixelDissolve's effect doesn't re-run each render
const SPECTRAL_PIXELS = ['var(--color-amber)', 'var(--color-magenta)', 'var(--color-violet)', 'var(--color-cyan)', 'var(--color-teal)']

const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// A brief "minting" overlay shown while an asset is validated + routed on-chain
// (the findBestPool latency). The token orb materialises inside a spinning spectral
// ring; once it lands the centre flips to "Added", then the whole card disintegrates
// into spectral pixels (Prismbeat's PixelReveal dissolve) and `onDone` fires. Portals
// to <body> so it escapes the builder's backdrop-blur containing blocks; purely visual.
export function MintOrb({
  address,
  symbol,
  chainId,
  status,
  onDone,
}: {
  address: string
  symbol?: string
  chainId: number
  status: MintStatus
  onDone?: () => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const reduced = reducedMotion()
  const added = status === 'added'

  // Once "Added" has held for a beat, begin the pixel-dissolve exit.
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    if (status !== 'added') return
    const t = window.setTimeout(() => setLeaving(true), 650)
    return () => window.clearTimeout(t)
  }, [status])

  // Reduced motion: no canvas dissolve — just fade out, then dismiss.
  useEffect(() => {
    if (!leaving || !reduced) return
    const t = window.setTimeout(() => onDone?.(), 320)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving, reduced])

  const cardStyle: CSSProperties = leaving
    ? reduced
      ? { opacity: 0, transition: 'opacity 0.3s ease' }
      : {
          // dissolve the frame so only the pixel field remains
          background: 'transparent',
          borderColor: 'transparent',
          boxShadow: 'none',
          backdropFilter: 'none',
          WebkitBackdropFilter: 'none',
          transition: 'background 0.26s ease, border-color 0.26s ease, box-shadow 0.26s ease',
        }
    : {
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'scale(1)' : 'scale(0.92)',
        transition: 'opacity 0.25s ease, transform 0.3s cubic-bezier(0.16,1,0.3,1)',
      }

  const contentStyle: CSSProperties | undefined = leaving
    ? { opacity: 0, transition: 'opacity 0.26s ease' }
    : undefined

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[60] grid place-items-center">
      {/* faint backdrop */}
      <div
        aria-hidden
        className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"
        style={{ opacity: mounted && !leaving ? 1 : 0, transition: 'opacity 0.3s ease' }}
      />

      {/* card */}
      <div
        role="status"
        aria-live="polite"
        className="relative w-[19rem] rounded-3xl border border-white/12 bg-panel/90 px-10 py-9 shadow-[0_40px_90px_-20px_rgba(0,0,0,0.85)] backdrop-blur-xl"
        style={cardStyle}
      >
        <div className="flex flex-col items-center gap-4" style={contentStyle}>
          <div className="relative grid h-36 w-36 place-items-center">
            {/* spectral ring — spins while forming, locks solid once added */}
            <div
              aria-hidden
              className={`absolute inset-0 rounded-full ${!reduced && !added ? 'animate-spin' : ''}`}
              style={{
                background: SPECTRAL_CONIC,
                WebkitMask:
                  'radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 5px))',
                mask: 'radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 5px))',
                animationDuration: '1.1s',
                opacity: added ? 1 : 0.95,
              }}
            />
            {/* energy pulse while forming */}
            {!reduced && !added && (
              <div
                aria-hidden
                className="absolute inset-3 animate-ping rounded-full"
                style={{ background: 'radial-gradient(circle, rgba(123,92,255,0.45), transparent 70%)' }}
              />
            )}
            {/* inner disc */}
            <div aria-hidden className="absolute inset-[10px] rounded-full bg-void/85" />

            {/* centre — the token orb materialises */}
            <div
              className="relative grid place-items-center"
              style={{
                opacity: added ? 0 : mounted ? 1 : 0,
                transform: added ? 'scale(0.7)' : mounted ? 'scale(1)' : 'scale(0.5)',
                transition: 'opacity 0.3s ease, transform 0.45s cubic-bezier(0.16,1,0.3,1)',
              }}
            >
              <AssetLogo address={address} symbol={symbol || '?'} chainId={chainId} size={76} />
            </div>

            {/* centre — "Added" once it lands */}
            <div
              className="absolute inset-0 grid place-items-center text-center"
              style={{
                opacity: added ? 1 : 0,
                transform: added ? 'scale(1)' : 'scale(0.8)',
                transition: 'opacity 0.3s ease 0.05s, transform 0.4s cubic-bezier(0.16,1,0.3,1) 0.05s',
              }}
            >
              <div>
                <svg
                  viewBox="0 0 24 24"
                  className="mx-auto h-7 w-7 text-cyan"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M5 13l4 4L19 7" />
                </svg>
                <div className="mt-1 font-display text-lg font-bold uppercase tracking-wide text-ink">Added</div>
              </div>
            </div>
          </div>

          {/* caption */}
          <div className="text-center">
            <div className="font-display text-sm font-bold uppercase tracking-wide text-ink">
              {symbol ? `$${symbol}` : 'Token'}
            </div>
            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
              {added ? 'Added to basket' : 'Finding best pool…'}
            </div>
          </div>
        </div>

        {/* pixel-dissolve exit (Prismbeat-style) — fills the card and disintegrates it */}
        {leaving && !reduced && <PixelDissolve colors={SPECTRAL_PIXELS} onDone={onDone} />}
      </div>
    </div>,
    document.body,
  )
}
