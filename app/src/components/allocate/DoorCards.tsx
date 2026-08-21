import { useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { AssetLogo } from '../AssetLogo'
import { BasketBento } from '../BasketBento'
import { stocksForChain } from '../../lib/chain/stocks'

// ─────────────────────────────────────────────────────────────────────────────
// THE DOOR CARDS — the two-outcome moment (for myself · a basket token for
// others), with their hover scenes. Born as the /manager landing (rounds 3-4,
// 2026-08-01); relocated to the flow's OUTCOME station when the owner adopted
// picker-first Create (20:26 + "lets build this out"). The mutable-vs-immutable
// decision, asked where it is concrete.
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'
const fixtureMode = import.meta.env.VITE_DEV_FIXTURE === '1'

// Real assets on their real networks, for the hover scenes
const AAVE = { addr: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', chainId: 1, sym: 'AAVE' }
const SYRUP = { addr: '0x643C4E15d7d62Ad0aBeC4a9BD4b001aA3Ef52d66', chainId: 1, sym: 'SYRUP' }
const PONS = { addr: '0x39dBED3a2bd333467115dE45665cC57F813C4571', chainId: 4663, sym: 'PONS' }
const BANKR = { addr: '0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb', chainId: 8453, sym: 'BANKR' }
const CBBTC = { addr: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', chainId: 8453, sym: 'cbBTC' }

/** Door A's scene (owner 20:02 + follow-up: more assets, more detail —
 *  % and $ values): five rows, each with its weight and dollar slice of an
 *  illustrative $2,500, summing exactly; bars still breathe between mixes.
 *  VISIBLE AT REST, calm — hover-only scenes left a ~250px void in the card
 *  (the "least recently swept" symptom) and never showed at all on touch,
 *  where there is no hover. Approach still ignites: the wrapper lifts to
 *  full and the rows brighten in their stagger. */
export function SceneReweight() {
  const reduce = useReducedMotion()
  const nvda = stocksForChain(4663).find((x) => x.symbol === 'NVDA')
  const rows = [
    { ...AAVE, a: 32, b: 20, usd: 800 },
    ...(nvda ? [{ addr: nvda.address, chainId: 4663, sym: 'NVDA', a: 24, b: 30, usd: 600 }] : []),
    { ...SYRUP, a: 18, b: 22, usd: 450 },
    { ...PONS, a: 16, b: 12, usd: 400 },
    { ...BANKR, a: 10, b: 16, usd: 250 },
  ]
  return (
    <span className="flex w-full flex-col justify-center rounded-2xl border border-white/10 bg-white/[0.04] p-5 opacity-80 backdrop-blur-sm transition-opacity duration-500 group-hover:opacity-100" style={{ transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)' }}>
      <span className="block space-y-3">
      {rows.map((r, i) => (
        <span
          key={r.sym}
          className="flex items-center gap-3 opacity-75 transition-opacity duration-500 group-hover:opacity-100"
          style={{ transitionDelay: `${i * 90}ms`, transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)' }}
        >
          <AssetLogo address={r.addr} symbol={r.sym} chainId={r.chainId} size={24} />
          <span className="w-16 shrink-0 font-mono text-[11px] text-ink">${r.sym}</span>
          <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
            <span
              aria-hidden
              className="manager-breathe absolute inset-y-0 left-0 rounded-full"
              style={
                {
                  background: SPECTRAL,
                  width: `${r.a}%`,
                  '--breathe-from': `${r.a}%`,
                  '--breathe-to': `${r.b}%`,
                  animationDelay: `${i * 0.4}s`,
                  animationPlayState: reduce ? 'paused' : undefined,
                } as React.CSSProperties
              }
            />
          </span>
          <span className="w-10 shrink-0 text-right font-num text-[12px] font-semibold tabular-nums text-ink">{r.a}%</span>
          <span className="w-14 shrink-0 text-right font-num text-[12px] tabular-nums text-ink-dim">${r.usd}</span>
        </span>
      ))}
      </span>
    </span>
  )
}

/** Door B's scene (owner 20:02 + follow-up): "a bento box of a basket
 *  with a token name" — and it must be the REAL asset bento, the exact tile
 *  system the basket pages use (squarified by weight, brand-colored, sheen),
 *  not a mock. Visible at rest like Door A's; the staggered pop-in plays
 *  once when the outcome station mounts (the house first-mount idiom). */
export function SceneBasketToken() {
  const items = [
    { symbol: AAVE.sym, address: AAVE.addr, chainId: AAVE.chainId, weightPct: 40 },
    { symbol: PONS.sym, address: PONS.addr, chainId: PONS.chainId, weightPct: 25 },
    { symbol: BANKR.sym, address: BANKR.addr, chainId: BANKR.chainId, weightPct: 20 },
    { symbol: CBBTC.sym, address: CBBTC.addr, chainId: CBBTC.chainId, weightPct: 15 },
  ]
  return (
    <span className="flex w-full flex-col justify-center rounded-2xl border border-white/10 bg-white/[0.04] p-5 opacity-80 backdrop-blur-sm transition-opacity duration-500 group-hover:opacity-100" style={{ transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)' }}>
      <span className="mb-3 flex items-baseline gap-3">
        <span className="font-display text-lg font-bold uppercase tracking-tight text-ink">$MYBASKET</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">one token · tradable</span>
      </span>
      <BasketBento items={items} aspect={2.6} reveal={{ delayMs: 60, stepMs: 90 }} show />
    </span>
  )
}

/** A proper arrow, drawn — not a glyph (owner 20:02: "the arrows also need to
 *  look a lot nicer"). */
function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 12h15" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  )
}

/** One of the two options. Colorless at rest; hover ignites the hairline, the
 *  arrow — and fades in the image behind (owner 19:49: "when you hover over
 *  it, it actually adds an image behind the card. I'll provide the image").
 *  Until his art lands, a spectral wash stands in so the effect is
 *  reviewable; drop the file in and pass `art` — nothing else changes. */
export function DoorCard({
  title,
  tagline,
  glow,
  art,
  scene,
  cta = 'Start',
  connecting,
  onOpen,
  enterIndex = 0,
  size = 'full',
}: {
  title: string
  tagline: React.ReactNode
  glow: string
  art?: string
  scene?: (active: boolean) => React.ReactNode
  cta?: string
  connecting: boolean
  onOpen: () => void
  enterIndex?: number
  /** `compact` (desk 58, the homepage's phone mount): two doors stacked on a
   *  phone were ~800px of door at full size. Compact drops the min-height to
   *  240 and the padding to p-6, tightens the type a step, and HIDES the
   *  scene — the scenes size themselves (five rows, a bento), and a capped
   *  slot bled them over the tagline on the first probe. A phone door is
   *  title · tagline · CTA. Absent = byte-identical full card; the flow's
   *  outcome station keeps that. */
  size?: 'full' | 'compact'
}) {
  const [active, setActive] = useState(false)
  const compact = size === 'compact'
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={connecting}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      className={`door-card press-lg enter group relative flex w-full flex-col overflow-hidden rounded-[2rem] border border-white/12 bg-panel/70 text-left backdrop-blur-md transition-transform duration-500 hover:-translate-y-1 hover:border-white/30 disabled:cursor-wait ${
        // 240 → 192 (owner 2026-08-06 23:13: "the manage-your-portfolio
        // button and the create-basket button can be made a little bit less,
        // have a bit less height"). The compact door is title · tagline · CTA
        // and it was reserving room it did not use.
        compact ? 'min-h-[192px] p-6' : 'min-h-[384px] p-10'
      }`}
      style={{ transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)', '--enter-i': enterIndex, '--door-glow': glow } as React.CSSProperties}
    >
      {/* the image behind, on approach only — colorless until then */}
      <span aria-hidden className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-700 group-hover:opacity-100">
        {art ? (
          <img src={art} alt="" className="h-full w-full object-cover" />
        ) : (
          <span
            className="absolute inset-0"
            style={{
              background: `radial-gradient(120% 90% at 80% 10%, color-mix(in srgb, ${glow} 30%, transparent), transparent 70%)`,
            }}
          />
        )}
        {/* scrim so the words stay legible over whatever art arrives */}
        <span className="absolute inset-0 bg-void/35" />
      </span>
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px opacity-0 transition-opacity duration-700 group-hover:opacity-90"
        style={{ background: `linear-gradient(90deg, transparent, ${glow}, transparent)` }}
      />

      <span className="relative block">
        <span
          className={`block max-w-[12ch] font-display font-bold uppercase leading-[1.0] tracking-tight text-ink ${
            compact ? 'text-2xl sm:text-3xl' : 'text-4xl sm:text-5xl'
          }`}
        >
          {title}
        </span>
        <span
          /* balanced (owner 2026-08-06 23:13: "the text, the description text
             needs to be balanced over two rows because right now it's not") */
          className={`block font-mono uppercase tracking-[0.16em] text-ink-faint transition-colors duration-500 [text-wrap:balance] group-hover:text-ink-dim ${
            compact ? 'mt-2 text-xs' : 'mt-3 text-base'
          }`}
        >
          {tagline}
        </span>
      </span>

      {/* the hover scene — the outcome, playing right under the title (owner,
          live note: the extra height works ABOVE; no dead pad below the title).
          COMPACT HIDES IT: the scenes size themselves (five rows, a bento) and
          a capped slot let them bleed over the tagline on the first probe —
          a phone door is title · tagline · CTA, and the full mount keeps the
          outcome preview where there is room for it. */}
      {!compact && <span className="relative mt-4 flex min-h-24 flex-1 items-stretch">{scene?.(active)}</span>}

      <span className={`relative flex items-center justify-between gap-4 ${compact ? 'mt-auto pt-4' : 'mt-8'}`}>
        <span
          className={`inline-flex items-center gap-3 rounded-full border border-white/15 font-display font-bold uppercase tracking-[0.14em] text-ink-dim transition-colors duration-500 group-hover:border-white/40 group-hover:text-ink ${
            compact ? 'h-10 px-5 text-xs' : 'h-12 px-6 text-sm'
          }`}
        >
          {connecting ? 'Connecting…' : cta}
        </span>
        {connecting && fixtureMode && (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300/90">
            simulated wallet — no signature
          </span>
        )}
        <span
          className={`relative ml-auto grid shrink-0 place-items-center overflow-hidden rounded-full border border-white/15 text-ink-dim transition-colors duration-500 group-hover:border-transparent group-hover:text-void ${
            compact ? 'h-10 w-10' : 'h-14 w-14'
          }`}
        >
          <span
            aria-hidden
            className="absolute inset-0 rounded-full opacity-0 transition-opacity duration-500 group-hover:opacity-100"
            style={{ background: SPECTRAL }}
          />
          <span className="relative transition-transform duration-500 group-hover:translate-x-0.5">
            <ArrowIcon />
          </span>
        </span>
      </span>
    </button>
  )
}

