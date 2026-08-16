import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { AssetLogo } from './AssetLogo'
import { InfoDot } from './InfoDot'
import { formatUsdCompact, formatUsdTight } from '../lib/spectrum/format'
import { showSymbol } from '../lib/spectrum/safe-copy'
import {
  RANGE_ORDER_FEE_BPS,
  previewRangeOrder,
  rangeOrderFee,
  rangeOrderProgress,
  type RangeOrderSide,
} from '../lib/spectrum/range-order'

// ─────────────────────────────────────────────────────────────────────────────
// SELL (OR BUY) THROUGH A LIQUIDITY POSITION — the control.
//
// the owner, 2026-08-06 14:52 + 15:2x: "all a person wants to know is, I want to
// sell between 1 million and 5 million with this amount of tokens, how much
// money am I going to make?"… "make the ui/ux experience for this option
// genuinely beautiful in the reshape system."
//
// SO THE CONTROL IS IN HIS UNITS, NOT UNISWAP'S. You drag two handles across a
// market-cap axis; we convert to prices, to ticks, and pick the pool. Nothing
// on this panel says "tick", "liquidity" or "sqrtPriceX96" — that complexity is
// ours to carry, and hiding it IS the product.
//
// THREE DESIGN DECISIONS WORTH THE WORDS:
//
//   · THE AXIS IS LOGARITHMIC. Market caps span orders of magnitude, and on a
//     linear axis a $1M–$5M range against a $40M ceiling is an invisible sliver
//     pinned to the left edge. Log spacing makes every decade the same width,
//     which is how someone actually thinks about "2× from here" vs "10× from
//     here".
//   · THE ANSWER SITS UNDER THE BAND, NOT IN A TOOLTIP. It is the reason the
//     control exists, so it is always on screen — and hover-gated content is
//     invisible on touch anyway.
//   · THE UN-FILL WARNING IS NEVER COLLAPSED. A range order is not a limit
//     order; it reverses if price comes back. That sentence is the one thing a
//     user can be genuinely hurt by not reading, so it cannot live behind a
//     disclosure. (The ⓘ carries the detail; the line itself always shows.)
//
// The number is CONDITIONAL and says so — "if it trades through this range" —
// never "you will make". It is the AMM's own arithmetic, not a forecast, and
// the profit-projection red line is the reason the wording is load-bearing.
// ─────────────────────────────────────────────────────────────────────────────

/** How far out the axis reaches around today's market cap. Wide enough that a
 *  10× target is reachable by dragging, tight enough that the handles are not
 *  hunting in empty space. */
const AXIS_LOW_MULT = 0.25
const AXIS_HIGH_MULT = 20

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

/** Position on the log axis, 0–1. */
function toAxis(mcap: number, lo: number, hi: number): number {
  if (!(mcap > 0) || !(lo > 0) || !(hi > lo)) return 0
  return clamp01((Math.log(mcap) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)))
}

/** The inverse — where a drag landed, in market cap. */
function fromAxis(t: number, lo: number, hi: number): number {
  return Math.exp(Math.log(lo) + clamp01(t) * (Math.log(hi) - Math.log(lo)))
}

function mcapLabel(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return '—'
  if (m >= 1e9) return `$${(m / 1e9).toFixed(m >= 1e10 ? 0 : 1)}B`
  if (m >= 1e6) return `$${(m / 1e6).toFixed(m >= 1e7 ? 0 : 2)}M`
  if (m >= 1e3) return `$${(m / 1e3).toFixed(0)}K`
  return `$${Math.round(m)}`
}

export interface RangeOrderAsset {
  symbol: string
  address: string
  chainId: number
  /** USD the position is worth TODAY — the reshape system's own currency, and
   *  the most that can be laddered out. */
  valueUsd: number
  /** Today's market cap. Null = we cannot speak in market caps for this token,
   *  and the panel says so rather than inventing one. */
  nowMcap: number | null
}

export function RangeOrderPanel({
  asset,
  side = 'sell',
  className = '',
  onPlace,
}: {
  asset: RangeOrderAsset
  side?: RangeOrderSide
  className?: string
  /** Absent = the control previews only and says so. Wiring arrives with the
   *  position manager; the panel is honest about it rather than dangling a
   *  button that cannot work. */
  onPlace?: (plan: { amountUsd: number; lowerMcap: number; upperMcap: number }) => void
}) {
  const { nowMcap } = asset

  const axis = useMemo(() => {
    if (nowMcap == null || !(nowMcap > 0)) return null
    return { lo: nowMcap * AXIS_LOW_MULT, hi: nowMcap * AXIS_HIGH_MULT }
  }, [nowMcap])

  // Opening stance: a ladder from just above spot out to ~4×, a recognisable
  // "take profit into strength" shape rather than an arbitrary one.
  const [bounds, setBounds] = useState<{ lower: number; upper: number } | null>(() =>
    nowMcap != null && nowMcap > 0 ? { lower: nowMcap * 1.25, upper: nowMcap * 4 } : null,
  )
  const [amountUsd, setAmountUsd] = useState<number>(() => asset.valueUsd)
  const [drag, setDrag] = useState<'lower' | 'upper' | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  const onTrackMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, which: 'lower' | 'upper') => {
      const el = trackRef.current
      if (!el || !axis) return
      const r = el.getBoundingClientRect()
      if (r.width <= 0) return
      const m = fromAxis(clamp01((e.clientX - r.left) / r.width), axis.lo, axis.hi)
      setBounds((cur) => {
        if (!cur) return cur
        // the handles cannot cross OR meet: a zero-width range is not a range
        const gap = 1.02
        return which === 'lower'
          ? { ...cur, lower: Math.min(m, cur.upper / gap) }
          : { ...cur, upper: Math.max(m, cur.lower * gap) }
      })
    },
    [axis],
  )

  // ── the panel refuses rather than guesses ────────────────────────────────
  if (nowMcap == null || axis == null || bounds == null) {
    return (
      <div className={`rounded-2xl border border-white/10 bg-white/[0.02] p-5 ${className}`}>
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
          No readable market cap for ${showSymbol(asset.symbol)} — this control speaks in market
          caps, and we will not invent one
        </p>
      </div>
    )
  }

  // THE MATHS IS SCALE-INVARIANT, which is why no circulating supply is needed:
  // market-cap ratios ARE price ratios (same supply on both sides), so feeding
  // the preview mcaps and a size expressed in "position per unit mcap" gives
  //   proceeds = amountUsd × √(Ma·Mb) / M0
  // exactly, and `avgFillPrice` comes back as the effective MARKET CAP.
  const preview = previewRangeOrder(amountUsd / nowMcap, { lower: bounds.lower, upper: bounds.upper })
  const fees = preview ? rangeOrderFee(preview.proceeds) : null
  const progress = rangeOrderProgress(nowMcap, { lower: bounds.lower, upper: bounds.upper }, side)

  const tLower = toAxis(bounds.lower, axis.lo, axis.hi)
  const tUpper = toAxis(bounds.upper, axis.lo, axis.hi)
  const tNow = toAxis(nowMcap, axis.lo, axis.hi)
  const startsInRange = nowMcap > bounds.lower

  const handle = (which: 'lower' | 'upper', t: number, label: string) => (
    <div
      role="slider"
      tabIndex={0}
      aria-label={`${which === 'lower' ? 'Lower' : 'Upper'} market cap`}
      aria-valuetext={label}
      aria-valuenow={Math.round(which === 'lower' ? bounds.lower : bounds.upper)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag(which)
      }}
      onPointerMove={(e) => drag === which && onTrackMove(e, which)}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId)
        setDrag(null)
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.1 : 0.02
        const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
        if (!dir) return
        e.preventDefault()
        const next = fromAxis(t + dir * step, axis.lo, axis.hi)
        setBounds((cur) =>
          !cur
            ? cur
            : which === 'lower'
              ? { ...cur, lower: Math.min(next, cur.upper / 1.02) }
              : { ...cur, upper: Math.max(next, cur.lower * 1.02) },
        )
      }}
      className="absolute top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none focus:outline-none"
      style={{ left: `${t * 100}%` }}
    >
      {/* the grab target is generous and unpainted; the drawn handle is small —
          the same split the ⓘ uses, so a money control is easy to catch
          without a chunky puck sitting on the data */}
      <span className="grid h-9 w-9 place-items-center">
        <span
          className={`block h-5 w-[7px] rounded-full transition-[box-shadow,transform] ${
            drag === which ? 'scale-110' : ''
          }`}
          style={{
            background: 'var(--color-cyan)',
            boxShadow: drag === which ? '0 0 0 4px color-mix(in srgb, var(--color-cyan) 22%, transparent)' : '0 0 0 2px rgba(0,0,0,0.4)',
          }}
        />
      </span>
    </div>
  )

  return (
    <div className={`rounded-2xl border border-white/10 bg-white/[0.02] p-5 ${className}`}>
      {/* ── the header: what this is, and on what ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-2.5">
          <AssetLogo address={asset.address} symbol={asset.symbol} chainId={asset.chainId} size={22} />
          <span className="font-mono text-[13px] uppercase tracking-[0.16em] text-ink-dim">
            {side === 'sell' ? 'Sell' : 'Buy'} ${showSymbol(asset.symbol)} through a position
            <InfoDot>
              Instead of selling into the market at today&rsquo;s price, your tokens are placed as
              liquidity across a market-cap range. As the price trades up through that range the
              pool sells them for you, and you earn the pool&rsquo;s trading fees while it happens.
              You choose the range; we pick the pool, the fee tier and the tick settings.
            </InfoDot>
          </span>
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          now {mcapLabel(nowMcap)}
        </span>
      </div>

      {/* ── the axis: today's mark, and the band you're selling across ── */}
      <div className="mt-6">
        <div ref={trackRef} className="relative h-9 select-none">
          {/* the rail */}
          <span aria-hidden className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/[0.07]" />
          {/* the band — the money actually being laddered */}
          <span
            aria-hidden
            className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
            style={{
              left: `${tLower * 100}%`,
              width: `${Math.max(0, tUpper - tLower) * 100}%`,
              background: 'linear-gradient(90deg, var(--color-cyan), var(--color-violet-bright))',
            }}
          />
          {/* WHERE PRICE IS NOW — the fact the whole decision is relative to */}
          <span
            aria-hidden
            className="absolute top-1/2 h-4 w-px -translate-y-1/2"
            style={{ left: `${tNow * 100}%`, background: 'rgba(255,255,255,0.55)' }}
          />
          {handle('lower', tLower, mcapLabel(bounds.lower))}
          {handle('upper', tUpper, mcapLabel(bounds.upper))}
        </div>
        {/* THE BOUNDS SIT UNDER THEIR OWN HANDLES. Pinning them to the row's
            edges (justify-between) read as axis ends rather than as the values
            being dragged — a number has to point at the thing it names, or the
            control is a guessing game. The `now` mark is labelled for the same
            reason: an unlabelled tick is a question, not a fact. */}
        <div className="relative mt-1.5 h-9">
          <span
            className="absolute -translate-x-1/2 whitespace-nowrap font-num text-[13px] font-semibold tabular-nums text-ink"
            style={{ left: `${tLower * 100}%` }}
          >
            {mcapLabel(bounds.lower)}
          </span>
          <span
            className="absolute -translate-x-1/2 whitespace-nowrap font-num text-[13px] font-semibold tabular-nums text-ink"
            style={{ left: `${tUpper * 100}%` }}
          >
            {mcapLabel(bounds.upper)}
          </span>
          <span
            className="absolute top-[19px] -translate-x-1/2 whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint"
            style={{ left: `${tNow * 100}%` }}
          >
            now
          </span>
        </div>
        <p className="mt-1 text-center font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">
          {side === 'sell' ? 'sells across this band' : 'buys across this band'}
        </p>
      </div>

      {/* ── how much of the holding to place ── */}
      <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Amount</span>
        {[0.25, 0.5, 1].map((f) => {
          const on = Math.abs(amountUsd - asset.valueUsd * f) < asset.valueUsd * 0.005
          return (
            <button
              key={f}
              type="button"
              aria-pressed={on}
              onClick={() => setAmountUsd(asset.valueUsd * f)}
              className={`press rounded-full border px-4 py-1.5 font-mono text-[10px] uppercase tracking-wide transition-colors ${
                on ? 'border-cyan/60 bg-cyan/[0.1] text-ink' : 'border-white/15 text-ink-dim hover:border-white/35'
              }`}
            >
              {f === 1 ? 'All' : `${f * 100}%`}
            </button>
          )
        })}
        <span className="ml-auto font-num text-[13px] font-semibold tabular-nums text-ink-dim">
          {formatUsdCompact(amountUsd)} of ${showSymbol(asset.symbol)}
        </span>
      </div>

      {/* ── THE ANSWER — the reason the control exists, always on screen ── */}
      {preview && fees && (
        <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            If it trades through this range
          </p>
          <p className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-num text-3xl font-semibold tabular-nums text-ink">
              {formatUsdCompact(fees.net)}
            </span>
            <span className="text-[13px] leading-snug text-ink-dim">
              after the {(RANGE_ORDER_FEE_BPS / 100).toFixed(2)}% fee on what converts
              <InfoDot>
                Charged only on the part of the position that actually converted, and only when you
                withdraw. A range that never fills costs nothing. While the position is live it is
                also earning the pool&rsquo;s own trading fees, which are yours.
              </InfoDot>
            </span>
          </p>
          <p className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            <span>
              fills at{' '}
              <span className="font-num tabular-nums text-ink-dim">
                {mcapLabel(preview.avgFillPrice)}
              </span>{' '}
              average
            </span>
            <span>
              <span className="font-num tabular-nums text-ink-dim">{preview.upliftVsFloor.toFixed(2)}×</span> the floor
            </span>
            <span>
              fee <span className="font-num tabular-nums text-ink-dim">{formatUsdTight(fees.fee)}</span>
            </span>
          </p>
        </div>
      )}

      {/* ── the two honest caveats, never collapsed ── */}
      <div className="mt-4 space-y-1.5">
        <p className="flex items-start gap-2 font-mono text-[10px] uppercase leading-relaxed tracking-[0.12em] text-amber">
          <span aria-hidden className="mt-[3px]">
            ⚠
          </span>
          <span>
            It can un-fill — you are only sold once you withdraw
            <InfoDot>
              A range order is not a limit order. If the price trades up through your range and then
              comes back down, the pool spends the proceeds buying your tokens back. The position is
              only settled when you withdraw it, which you can do from your portfolio at any time.
            </InfoDot>
          </span>
        </p>
        {startsInRange && (
          <p className="font-mono text-[10px] uppercase leading-relaxed tracking-[0.12em] text-ink-faint">
            Today&rsquo;s price already sits inside this band, so part of it converts immediately
            {progress != null && <> — about {Math.round(progress.fraction * 100)}% straight away</>}
          </p>
        )}
      </div>

      {/* ── the action, honest about what exists ── */}
      <div className="mt-5">
        {onPlace ? (
          <button
            type="button"
            onClick={() => onPlace({ amountUsd, lowerMcap: bounds.lower, upperMcap: bounds.upper })}
            disabled={!preview}
            className="spectral-btn press inline-flex h-11 items-center justify-center rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void disabled:opacity-50"
          >
            Place this position →
          </button>
        ) : (
          /* NO DEAD BUTTON. Minting needs the position manager, which this app
             does not carry yet; saying so beats a control that fails on click. */
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            Preview only for now — placing a position lands with the position manager
          </p>
        )}
      </div>
    </div>
  )
}
