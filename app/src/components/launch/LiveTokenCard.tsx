import { PrismMark } from '../../hud'
import { AssetLogo } from '../AssetLogo'

const DEFAULT_GRAD = 'conic-gradient(from -90deg, var(--color-cyan), var(--color-violet), var(--color-magenta), var(--color-amber), var(--color-teal), var(--color-cyan))'

// A weighted color-wheel of the basket: each constituent's brand colour spans its
// weight slice — so the identity is literally generated from what's inside, and shifts
// as weights change.
function conicFromBasket(colors: string[], weights: number[]): string {
  if (colors.length === 0) return DEFAULT_GRAD
  if (colors.length === 1) return `conic-gradient(from -90deg, ${colors[0]}, ${colors[0]})`
  const total = weights.reduce((a, b) => a + (b || 0), 0) || 100
  let acc = 0
  const stops: string[] = []
  colors.forEach((c, i) => {
    const span = ((weights[i] || 0) / total) * 360
    stops.push(`${c} ${acc.toFixed(2)}deg ${(acc + span).toFixed(2)}deg`)
    acc += span
  })
  return `conic-gradient(from -90deg, ${stops.join(', ')})`
}

// Live preview of the basket's on-chain identity — a generative avatar (prism refracting
// the basket's weighted colour-wheel) plus the live name / ticker.
// Updates in real time as the creator composes + names the basket.
export function LiveTokenCard({
  name,
  symbol,
  assets,
  weights,
  blend,
  chainId,
  glowGrad,
}: {
  name: string
  symbol: string
  assets: { symbol: string; address: string }[]
  weights: number[]
  blend: string[]
  chainId: number
  glowGrad?: string | null
}) {
  const conic = conicFromBasket(blend, weights)
  const icons = assets.slice(0, 7)
  const more = Math.max(0, assets.length - icons.length)

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/12 bg-white/[0.03] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-md">
      {glowGrad && (
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 left-0 h-44 w-full opacity-25 blur-3xl"
          style={{ background: glowGrad }}
        />
      )}

      <div className="relative flex items-center gap-4">
        {/* generative avatar — the prism refracting the basket's weighted colour-wheel */}
        <div className="relative shrink-0">
          <div className="absolute -inset-1.5 rounded-2xl opacity-50 blur-md" style={{ background: conic }} aria-hidden />
          <div
            className="relative grid h-16 w-16 place-items-center overflow-hidden rounded-2xl ring-1 ring-white/20 transition-[background] duration-500"
            style={{ background: conic }}
          >
            <div
              aria-hidden
              className="absolute inset-0"
              style={{ background: 'radial-gradient(circle at 50% 46%, rgba(7,7,11,0.6), rgba(7,7,11,0.12) 62%, transparent)' }}
            />
            <PrismMark size={34} className="relative" />
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-display text-xl font-bold uppercase tracking-wide text-ink">
              {symbol ? `$${symbol}` : <span className="text-ink-faint">$SYMBOL</span>}
            </span>
          </div>
          <div className={`mt-1 truncate font-display text-base ${name.trim() ? 'text-ink-dim' : 'text-ink-faint'}`}>
            {name.trim() || 'Untitled basket'}
          </div>
        </div>
      </div>

      {/* constituents + NAV */}
      <div className="relative mt-4 flex items-center">
        <div className="flex items-center -space-x-2">
          {icons.map((t) => (
            <AssetLogo key={t.address} address={t.address} symbol={t.symbol} chainId={chainId} size={24} />
          ))}
        </div>
        {more > 0 && <span className="ml-2.5 font-mono text-[10px] text-ink-faint">+{more}</span>}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-ink-faint">

        </span>
      </div>
    </div>
  )
}
