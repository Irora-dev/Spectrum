import type { CSSProperties } from 'react'
import { AssetLogo } from './AssetLogo'
import { tokenVisual } from '../lib/spectrum/token-meta'

// Real tokens (curated brand colours + logos) used purely as an illustration.
const ASSETS = [
  { symbol: 'VVV', address: '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf' },
  { symbol: 'VIRTUAL', address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b' },
  { symbol: 'BNKR', address: '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b' },
  { symbol: 'POD', address: '0xed664536023d8e4b1640c394777d34abaff1df8f' },
  { symbol: 'REI', address: '0x6b2504a03ca4d43d0d73776f6ad46dab2f2a4cfd' },
  { symbol: 'AEON', address: '0xbf8e8f0e8866a7052f948c16508644347c57aba3' },
  { symbol: 'NOCK', address: '0x9b5e262cf9bb04869ab40b19af91d2dc85761722' },
  { symbol: 'SURPLUS', address: '0xc52aedec3374422d7510e294cfaa90799595cba3' },
]
const CHAIN = 8453

// Just the animation: real asset logos orbit, then drift together and fuse into
// a single glowing basket token. Reused at small scale in explainers and blown up
// as the homepage hero backdrop. `showCore` hides the centre token so something
// else (e.g. the wordmark) can sit at the convergence point. The orbit radius is
// driven by the `--orbit-r` CSS var (set via className, responsively), so a wider
// ring + a modest `logoSize` opens up the middle and the gaps between assets.
export function ConceptOrbit({
  showCore = true,
  logoSize = 38,
  className = '',
}: {
  showCore?: boolean
  logoSize?: number
  className?: string
}) {
  return (
    <div className={`relative mx-auto h-72 w-full max-w-md ${className}`}>
      {/* soft glow that breathes with the token */}
      <div aria-hidden className="concept-core absolute left-1/2 top-1/2 h-40 w-40 rounded-full bg-violet/25 blur-3xl" />

      {/* orbiting assets that converge into the centre */}
      <div className="concept-spin absolute inset-0">
        {ASSETS.map((a, i) => (
          <div
            key={a.address}
            className="concept-orb absolute left-1/2 top-1/2"
            style={{ '--angle': `${(i / ASSETS.length) * 360}deg` } as CSSProperties}
          >
            <AssetLogo
              address={a.address}
              symbol={a.symbol}
              chainId={CHAIN}
              size={logoSize}
              discColor={`color-mix(in srgb, ${tokenVisual(a.symbol, a.address).color} 55%, #000)`}
            />
          </div>
        ))}
      </div>

      {/* the basket token they fuse into */}
      {showCore && (
        <div
          className="concept-core absolute left-1/2 top-1/2 grid h-16 w-16 place-items-center rounded-2xl ring-1 ring-white/25"
          style={{ background: 'linear-gradient(135deg, var(--color-cyan), var(--color-violet-bright) 52%, var(--color-magenta))' }}
        >
          <svg viewBox="0 0 24 24" aria-hidden className="h-6 w-6 text-black/80" fill="currentColor">
            <path d="M12 2l9 9-9 9-9-9 9-9z" />
          </svg>
        </div>
      )}
    </div>
  )
}

// "Many assets become one token" — the orbit animation plus an explanatory caption.
export function ConceptReveal() {
  return (
    <div className="text-center">
      <ConceptOrbit />
      <h3 className="mt-1 font-display text-xl font-bold uppercase tracking-tight text-ink sm:text-2xl">
        Many assets, one token
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-dim">
        A basket token bundles many assets into one. Its price tracks the combined value of
        everything inside, so one token carries the whole basket.
      </p>
    </div>
  )
}
