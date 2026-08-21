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
const H_MASK =
  'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.45) 6%, black 14%, black 86%, rgba(0,0,0,0.4) 94%, transparent 100%)'

export function BundleHero({
  children,
  minH = '56svh',
  centerContent = false,
  dim = false,
  softFade = false,
}: {
  children: ReactNode
  minH?: string
  /** Grid-centre the content within the hero's full height — for set-piece
   *  landings where the title floats in the art (the manager). NOTE for
   *  `.spectrum-wordmark` children: it is display:inline-block, so horizontal
   *  centring needs a text-center PARENT — auto margins do nothing to it. */
  centerContent?: boolean
  /** A black overlay over the art (owner 20:42: "more transparent or like a
   *  blacked out") — content stays full-contrast above it. */
  dim?: boolean
  /** A gentler bottom fade (owner 20:42: the default one reads harsh). */
  softFade?: boolean
}) {
  const vFade = softFade
    ? 'linear-gradient(180deg, black 0%, black 40%, rgba(0,0,0,0.55) 70%, transparent 100%)'
    : 'linear-gradient(180deg, black 0%, black 84%, transparent 100%)'
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
          WebkitMaskImage: `${H_MASK}, ${vFade}`,
          WebkitMaskComposite: 'source-in',
          maskImage: `${H_MASK}, ${vFade}`,
          maskComposite: 'intersect',
        }}
      />
      {dim && <div aria-hidden className="absolute inset-0 bg-void/45" />}
      {/* keeps body copy legible over the bright spectral rays without
          flattening the art — a scrim, not a wash */}
      <div
        aria-hidden
        className="absolute inset-0"
        /* void-token scrim: identical on the dark planes (void ≈ #05050b), no
           black vignette on the light one (owner 2026-08-19) */
        style={{
          background:
            'linear-gradient(90deg, color-mix(in srgb, var(--color-void) 82%, transparent) 0%, color-mix(in srgb, var(--color-void) 55%, transparent) 45%, color-mix(in srgb, var(--color-void) 15%, transparent) 100%)',
        }}
      />
      <div
        className={`relative z-10 mx-auto max-w-[1100px] px-4 pb-12 pt-16 sm:px-6 ${centerContent ? 'grid place-items-center' : ''}`}
        style={{ minHeight: minH }}
      >
        {children}
      </div>
    </section>
  )
}
