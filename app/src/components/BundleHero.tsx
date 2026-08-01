import type { ReactNode } from 'react'
import bundleArt from '../assets/bundle-hero.jpg'
import bundleArt1280 from '../assets/bundle-hero.1280.jpg'

// The bundle hero (owner 2026-08-01: this art on ALL bundle pages). Same
// treatment as the home and league heroes so the site reads as one thing:
// full-bleed break-out of the centre column, the art masked to transparent at
// the left/right lanes the animated spectrum bands occupy — so the bands shine
// THROUGH rather than fighting it — and composited into the page at the foot.
//
// The art is a 3840px master with a 1280w twin; without the srcSet a phone
// decodes the full one for a decorative background (the exact regression the
// 1280w pass fixed across the other heroes).
const MASK =
  'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.45) 6%, black 14%, black 86%, rgba(0,0,0,0.4) 94%, transparent 100%), linear-gradient(180deg, black 0%, black 84%, transparent 100%)'

export function BundleHero({ children, minH = '56svh' }: { children: ReactNode; minH?: string }) {
  return (
    <section className="relative left-1/2 -mt-8 w-screen -translate-x-1/2 overflow-hidden">
      <img
        src={bundleArt}
        srcSet={`${bundleArt1280} 1280w, ${bundleArt} 3840w`}
        sizes="100vw"
        alt=""
        aria-hidden
        className="absolute inset-0 h-full w-full object-cover object-right"
        style={{
          WebkitMaskImage: MASK,
          WebkitMaskComposite: 'source-in',
          maskImage: MASK,
          maskComposite: 'intersect',
        }}
      />
      {/* keeps body copy legible over the bright spectral rays without
          flattening the art — a scrim, not a wash */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ background: 'linear-gradient(90deg, rgba(5,5,11,0.82) 0%, rgba(5,5,11,0.55) 45%, rgba(5,5,11,0.15) 100%)' }}
      />
      <div className="relative z-10 mx-auto max-w-[1100px] px-4 pb-12 pt-16 sm:px-6" style={{ minHeight: minH }}>
        {children}
      </div>
    </section>
  )
}
