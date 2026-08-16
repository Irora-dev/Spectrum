import { AssetLogo } from './AssetLogo'
import { showSymbol } from '../lib/spectrum/safe-copy'

// ─────────────────────────────────────────────────────────────────────────────
// What a basket holds, as words and numbers (owner 2026-08-02: "each basket
// token should show the assets within it and their %s so people have a good
// idea of what that exposure means"). Used on BOTH surfaces — the portfolio's
// held-basket cards and the reshape mode's basket rows — so the two can never
// describe the same basket differently.
//
// It is EXPOSURE, never a control: no bars, no inputs. The mode trades the
// basket as one unit (the owner's ruling); these legs are what that unit carries.
// A basket whose legs aren't readable renders nothing rather than a guess.
//
// CIRCLES, NOT A LIST (owner 2026-08-02 17:53: "let's just have those as
// circles — the circle and then its percent, and when you hover over the
// circle it tells you what the asset is, rather than a list, because it makes
// the thing too long"). The ticker rides `title` + `aria-label`, so pointer
// users get the tooltip and screen readers get the name outright.
// ─────────────────────────────────────────────────────────────────────────────

export interface BasketLeg {
  symbol: string
  address: string
  chainId: number
  weightPct: number
}

export function BasketContents({
  legs,
  max = 8,
  className = '',
}: {
  legs: BasketLeg[]
  /** Rows shown before the tail collapses into a count. */
  max?: number
  className?: string
}) {
  const priced = legs.filter((l) => l.weightPct > 0).sort((a, b) => b.weightPct - a.weightPct)
  if (priced.length === 0) return null
  const shown = priced.slice(0, max)
  const restPct = priced.slice(max).reduce((s, l) => s + l.weightPct, 0)
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {shown.map((l) => (
          <span
            key={`${l.chainId}:${l.address}`}
            className="flex items-center gap-1.5"
            title={`$${showSymbol(l.symbol)} · ${l.weightPct.toFixed(0)}%`}
            aria-label={`$${showSymbol(l.symbol)}, ${l.weightPct.toFixed(0)} percent`}
          >
            <AssetLogo address={l.address} symbol={l.symbol} chainId={l.chainId} size={20} />
            <span className="font-num text-[11px] font-semibold tabular-nums text-ink-dim">
              {l.weightPct.toFixed(0)}%
            </span>
          </span>
        ))}
        {restPct > 0.5 && (
          <span
            className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint"
            title={`${priced.length - max} smaller holdings · ${restPct.toFixed(0)}%`}
          >
            +{priced.length - max} · {restPct.toFixed(0)}%
          </span>
        )}
      </div>
    </div>
  )
}
