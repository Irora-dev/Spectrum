// The wax-seal highlight badges (owner art, 2026-08-19): four embossed coins
// for card-corner highlights on Home/Explore. Every seal a card wears is
// DERIVED from measured data the card already states (the honesty law:
// display is never curation wearing a data face) — the rules live with the
// page that computes them; this component only draws.
//   teal    → Top 24h (the list's best measured 24h change)
//   amber   → Most backed (the list's largest AUM)
//   violet  → New (young inception, when the page knows the age)
//   rainbow → Featured (an explicit operator pick — config, never inferred)
import sealTeal from '../assets/seals/seal-teal.webp'
import sealAmber from '../assets/seals/seal-amber.webp'
import sealViolet from '../assets/seals/seal-violet.webp'
import sealRainbow from '../assets/seals/seal-rainbow.webp'

export type SealKind = 'top24h' | 'backed' | 'new' | 'featured'

const SEAL: Record<SealKind, { src: string; label: string }> = {
  top24h: { src: sealTeal, label: 'Top 24h' },
  backed: { src: sealAmber, label: 'Most backed' },
  new: { src: sealViolet, label: 'New' },
  featured: { src: sealRainbow, label: 'Featured' },
}

export function SealBadge({ kind, size = 52, className = '' }: { kind: SealKind; size?: number; className?: string }) {
  const s = SEAL[kind]
  return (
    <div className={`pointer-events-none flex flex-col items-center gap-1 ${className}`} title={s.label}>
      <img src={s.src} alt="" aria-hidden draggable={false} width={size} height={size} className="rotate-6 select-none drop-shadow-[0_4px_10px_rgba(0,0,0,0.25)]" />
      <span className="rounded-full border border-white/[0.16] bg-void/60 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-ink backdrop-blur-sm">
        {s.label}
      </span>
    </div>
  )
}
