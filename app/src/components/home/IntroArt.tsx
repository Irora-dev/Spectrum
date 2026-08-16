import { useEffect, useMemo, useRef, useState } from 'react'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { AssetLogo } from '../AssetLogo'
import { BasketAvatar } from '../BasketAvatar'
import { BasketBento } from '../BasketBento'
import type { BasketSummary } from '../../lib/spectrum/basket-data'
import { stocksForChain } from '../../lib/chain/stocks'
import { formatUsdCompact } from '../../lib/spectrum/format'
import { tokenVisual } from '../../lib/spectrum/token-meta'
import { SPECTRAL } from './Spine'

/** The example set's PERSONALITY (owner ~16:2x: "not wbtc/weth — default to
 *  the stocks and some tokens mixed in like pons, cashcat"): wrapped majors
 *  and stables read as plumbing, not a portfolio anyone chose. Stocks lead,
 *  the chain's own fun tokens mix in, plumbing only as a last resort.
 *  Exported: the hero panel applies the same rule to its rotating pool. */
export const PLUMBING = new Set(['WETH', 'WBTC', 'CBBTC', 'ETH', 'BTC', 'USDG', 'USDC', 'USDT', 'DAI', 'USDS'])

/** How the weights dial splits an EXAMPLE book. The money is weight-share of
 *  this total, same disclosure posture as the hero panel's example figure. */
const EXAMPLE_TOTAL = 12_800

/** THE PORTFOLIO-INTRO ART (owner 2026-08-03 ~10:00 "far more visual, use
 *  elements from the portfolio page/system" → ~10:3x "a bento basket on the one
 *  book … a live slider affecting the bento grid layout / money").
 *  Same law as the loop's RungArt: real primitives (the app's own BasketBento,
 *  the portfolio's own trim slider), real assets from live baskets. The weights
 *  card is INTERACTIVE: the dial reweights the first asset and the bento glides
 *  to the new geometry, money re-splitting live — the product's own behaviour,
 *  demonstrated. With nothing readable a card keeps its words, never a mock. */
export function IntroArt({
  kind,
  accent,
  baskets,
}: {
  kind: 'book' | 'weights' | 'insights'
  accent: string
  baskets: BasketSummary[]
}) {
  // The weights dial: the first asset's example weight, percent. Rests at 34
  // (the marker's position); dragging either side reads as trim or add.
  const [dial, setDial] = useState(34)
  // 'live' while ANY input is moving the dial, settled 220ms after the last
  // change — the PRODUCT surface's own pattern (PositionsMode markDialing).
  // The pointer-event version (audit F8) left keyboard steps and edge drag
  // paths in 'glide', where every tick RE-SORTS slot order mid-transition —
  // tiles permanently mid-flight, stacked (owner ~16:1x, reproduced class:
  // the bento's 08:55 bug). Live mode freezes order and resizes in place;
  // the settle re-sorts once, smoothly.
  const [dialing, setDialing] = useState(false)
  const dialingTimer = useRef<number | undefined>(undefined)
  const markDialing = () => {
    setDialing(true)
    window.clearTimeout(dialingTimer.current)
    dialingTimer.current = window.setTimeout(() => setDialing(false), 220)
  }
  useEffect(() => () => window.clearTimeout(dialingTimer.current), [])
  // Distinct real assets with the owner-ruled personality: STOCKS lead, the
  // chain's own tokens (the PONS/CASHCAT class) mix in, wrapped majors and
  // stables (plumbing) only as a last resort. Interleaved stock/token so the
  // four-slot cards read as a mix, not a sector. Still real: every entry
  // comes from a live basket's own constituents.
  const assets = useMemo(() => {
    const stockSyms = new Set(stocksForChain(4663).map((s) => s.symbol.toUpperCase()))
    const bySym = new Map<string, { symbol: string; address: string; chainId: number }>()
    for (const b of baskets)
      for (const t of b.top ?? []) {
        const k = t.symbol.toUpperCase()
        if (!bySym.has(k)) bySym.set(k, { symbol: t.symbol, address: t.address, chainId: b.chainId })
      }
    const pool = [...bySym.values()]
    const stocks = pool.filter((a) => stockSyms.has(a.symbol.toUpperCase()))
    const tokens = pool.filter(
      (a) => !stockSyms.has(a.symbol.toUpperCase()) && !PLUMBING.has(a.symbol.toUpperCase()),
    )
    const plumbing = pool.filter((a) => PLUMBING.has(a.symbol.toUpperCase()))
    const out: typeof pool = []
    // stock, token, stock, token — falling through when a bucket runs dry
    for (let i = 0; out.length < 4 && (i < stocks.length || i < tokens.length); i++) {
      if (i < stocks.length && out.length < 4) out.push(stocks[i])
      if (i < tokens.length && out.length < 4) out.push(tokens[i])
    }
    for (const a of plumbing) {
      if (out.length >= 4) break
      out.push(a)
    }
    return out
  }, [baskets])

  // The single largest constituent weight anywhere — the portfolio page's own
  // "largest single position" fact — PLUS the whole designed composition of the
  // basket that holds it, because the arc needs a real whole to draw (top
  // assets across different baskets are not a composition; one basket's is).
  const concentration = useMemo(() => {
    let best: { symbol: string; pct: number; basket: BasketSummary } | null = null
    for (const b of baskets)
      for (const t of b.top ?? []) {
        if ((t.weightPct || 0) > (best?.pct ?? 0)) best = { symbol: t.symbol, pct: t.weightPct, basket: b }
      }
    if (!best) return null
    const legs = (best.basket.top ?? [])
      .filter((t) => (t.weightPct || 0) > 0)
      .sort((a, b) => b.weightPct - a.weightPct)
    return { ...best, legs }
  }, [baskets])

  // Look-through reach: the asset that appears in the most baskets — carrying
  // WHICH baskets, so the fact can be shown as the real avatars rather than a
  // number. Only a fact when it reaches through MORE than one.
  const reach = useMemo(() => {
    const counts = new Map<
      string,
      { symbol: string; address: string; chainId: number; in: BasketSummary[] }
    >()
    for (const b of baskets) {
      const seen = new Set<string>()
      for (const t of b.top ?? []) {
        const k = t.symbol.toUpperCase()
        if (seen.has(k)) continue
        seen.add(k)
        const e = counts.get(k) ?? { symbol: t.symbol, address: t.address, chainId: b.chainId, in: [] }
        e.in.push(b)
        counts.set(k, e)
      }
    }
    let best: { symbol: string; address: string; chainId: number; in: BasketSummary[] } | null = null
    for (const e of counts.values()) if (e.in.length > (best?.in.length ?? 0)) best = e
    return best && best.in.length >= 2 ? best : null
  }, [baskets])

  if (kind === 'book') {
    // ONE picture (owner ~10:3x: "a bento basket … rather than a chart") — the
    // cross-chain book as the app's own bento, real assets spanning networks.
    if (assets.length === 0) return null
    const networks = new Set(assets.map((a) => a.chainId)).size
    const shape = [32, 26, 22, 20]
    const sum = shape.slice(0, assets.length).reduce((x, y) => x + y, 0)
    const items = assets.map((a, i) => ({
      id: `${a.chainId}:${a.address.toLowerCase()}`,
      symbol: a.symbol,
      address: a.address,
      chainId: a.chainId,
      weightPct: ((shape[i] ?? 10) / sum) * 100,
    }))
    return (
      <div>
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">one portfolio</span>
          <span className="font-mono text-[9px] uppercase tracking-[0.14em]" style={{ color: accent }}>
            {networks} network{networks === 1 ? '' : 's'}
          </span>
        </div>
        <BasketBento items={items} aspect={1.5} />
      </div>
    )
  }

  if (kind === 'weights') {
    // A LIVE dial (owner ~10:3x: "a live slider affecting the bento grid
    // layout / money") — drag it and the product's own behaviour plays out:
    // the first asset's weight follows the thumb, the others re-proportion
    // around it, the bento GLIDES to the new geometry, and the example money
    // re-splits. The slider is the portfolio's real control (the invisible
    // trim-bar input is the drag layer, the drawn thumb rides it).
    if (assets.length < 3) return null
    const MIN = 10
    const MAX = 60
    const REST = 34
    const picks = assets.slice(0, Math.min(4, assets.length))
    const others = picks.slice(1)
    const baseShape = [30, 26, 22]
    const baseSum = others.reduce((s, _, i) => s + (baseShape[i] ?? 20), 0)
    const rest = 100 - dial
    const items = [
      {
        id: `${picks[0].chainId}:${picks[0].address.toLowerCase()}`,
        symbol: picks[0].symbol,
        address: picks[0].address,
        chainId: picks[0].chainId,
        weightPct: dial,
        footer: { amount: formatUsdCompact((dial / 100) * EXAMPLE_TOTAL) },
      },
      ...others.map((a, i) => {
        const pct = ((baseShape[i] ?? 20) / baseSum) * rest
        return {
          id: `${a.chainId}:${a.address.toLowerCase()}`,
          symbol: a.symbol,
          address: a.address,
          chainId: a.chainId,
          weightPct: pct,
          footer: { amount: formatUsdCompact((pct / 100) * EXAMPLE_TOTAL) },
        }
      }),
    ]
    const pos = ((dial - MIN) / (MAX - MIN)) * 100
    const restPos = ((REST - MIN) / (MAX - MIN)) * 100
    return (
      <div>
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-dim">
            ${showSymbol(picks[0].symbol)} · <span className="text-ink">{Math.round(dial)}%</span>
          </span>
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">example</span>
        </div>
        <BasketBento items={items} aspect={1.7} animateLayout layoutMotion={dialing ? 'live' : 'glide'} />
        <div className="relative mt-4 h-6">
          {/* the track */}
          <span aria-hidden className="absolute top-1/2 h-2 w-full -translate-y-1/2 rounded-full bg-white/[0.07]" />
          {/* the change, filled between the resting marker and the thumb */}
          {Math.abs(pos - restPos) > 0.5 && (
            <span
              aria-hidden
              className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full opacity-90"
              style={{
                left: `${Math.min(pos, restPos)}%`,
                width: `${Math.abs(pos - restPos)}%`,
                background: accent,
              }}
            />
          )}
          {/* the resting marker the thumb passes over */}
          <span
            aria-hidden
            className="absolute top-1/2 z-[5] h-5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/45"
            style={{ left: `${restPos}%` }}
          />
          {/* the invisible native input = the drag layer (a11y + drag) */}
          <input
            type="range"
            min={MIN}
            max={MAX}
            step={1}
            value={Math.round(dial)}
            onChange={(e) => {
              markDialing()
              setDial(Number(e.target.value))
            }}
            aria-label={`Example weight for $${showSymbol(picks[0].symbol)}, percent`}
            className="trim-bar"
          />
          {/* the drawn thumb — a void core in a spectral ring */}
          <span
            aria-hidden
            className="trim-thumb pointer-events-none absolute top-1/2 z-20 grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full transition-shadow"
            style={{ left: `${pos}%`, background: SPECTRAL, boxShadow: '0 4px 14px rgba(0,0,0,0.6)' }}
          >
            <span className="h-4 w-4 rounded-full bg-[#0c0a18] shadow-[inset_0_1px_2px_rgba(255,255,255,0.25)]" />
          </span>
        </div>
      </div>
    )
  }

  // insights — the facts DRAWN, not metered (owner ~11:1x: "can be improved
  // massively"). Concentration = a real composition arc: the whole designed
  // composition of the basket holding the largest position, each segment in
  // its asset's own colour (colour follows the entity), the fact direct-
  // labelled in the centre wearing ink. Reach = the actual baskets the asset
  // reaches through, as their real avatars. Depth stays absent: the summary
  // carries no pool-depth reading, and nothing here fakes one.
  if (!concentration && !reach) return null
  const R = 38
  const C = 2 * Math.PI * R
  const GAP = 2.5
  const segs = concentration
    ? (() => {
        const top = concentration.legs.slice(0, 5)
        const rest = concentration.legs.slice(5).reduce((s, t) => s + t.weightPct, 0)
        const parts = [
          ...top.map((t) => ({
            key: t.symbol,
            pct: t.weightPct,
            color: tokenVisual(t.symbol, t.address).color,
            lead: t.symbol === concentration.symbol,
          })),
          ...(rest > 0 ? [{ key: 'other', pct: rest, color: 'rgba(255,255,255,0.12)', lead: false }] : []),
        ]
        const total = parts.reduce((s, p) => s + p.pct, 0) || 1
        let acc = 0
        return parts.map((p) => {
          const len = (p.pct / total) * C
          const seg = { ...p, dash: Math.max(0, len - GAP), offset: -acc }
          acc += len
          return seg
        })
      })()
    : []
  return (
    <div>
      {concentration && (
        <div className="flex items-center gap-4 border-b border-white/8 pb-3">
          <svg
            viewBox="0 0 96 96"
            className="h-24 w-24 shrink-0 -rotate-90"
            role="img"
            aria-label={`Largest single position: $${showSymbol(concentration.symbol)} at ${concentration.pct.toFixed(0)} percent of its basket`}
          >
            {segs.map((s) => (
              <circle
                key={s.key}
                cx="48"
                cy="48"
                r={R}
                fill="none"
                stroke={s.color}
                strokeOpacity={s.lead || s.key === 'other' ? 1 : 0.55}
                strokeWidth={s.lead ? 11 : 8}
                strokeDasharray={`${s.dash} ${C - s.dash}`}
                strokeDashoffset={s.offset}
              />
            ))}
          </svg>
          <div className="min-w-0">
            <div className="font-num text-2xl font-light leading-none tabular-nums text-ink">
              {concentration.pct.toFixed(0)}%
            </div>
            <div className="mt-1 truncate font-display text-[12px] font-bold text-ink">${showSymbol(concentration.symbol)}</div>
            <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
              largest single position
            </div>
          </div>
        </div>
      )}
      {reach && (
        <div className={`flex items-center gap-3 ${concentration ? 'pt-3' : ''}`}>
          <AssetLogo address={reach.address} symbol={reach.symbol} chainId={reach.chainId} size={26} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-num text-sm font-semibold tabular-nums text-ink">
              ${showSymbol(reach.symbol)} · {reach.in.length} baskets
            </div>
            <div className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">reach-through</div>
          </div>
          {/* the actual baskets it reaches, overlapping like the holders row */}
          <div className="flex shrink-0 -space-x-2">
            {reach.in.slice(0, 4).map((b) => (
              <span key={b.address} className="rounded-full ring-2 ring-panel">
                <BasketAvatar address={b.address} symbol={b.symbol} size={22} />
              </span>
            ))}
            {reach.in.length > 4 && (
              <span className="grid h-[22px] w-[22px] place-items-center rounded-full bg-white/10 font-mono text-[8px] text-ink-dim ring-2 ring-panel">
                +{reach.in.length - 4}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

