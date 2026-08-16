import { useState } from 'react'
import { buildBasketHolderStats, type BasketHolderRow } from '../../lib/spectrum/basket-holder-stats'
import type { BasketData } from '../../lib/spectrum/basket-data'
import type { PortfolioHolding } from '../../lib/spectrum/hooks'
import type { PnlIndex } from '../../lib/spectrum/pnl'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { MASKED_USD, moneyPrivacyOn } from '../../lib/spectrum/format'
import { ChainBadge } from '../ChainBadge'
import { Carousel } from '../Carousel'
import { DexSwapCard } from '../DexSwapCard'

// ─────────────────────────────────────────────────────────────────────────────
// BASKET HOLDER STATS — the buyer's side of the portfolio (the owner, 2026-08-15:
// PnL since you bought, the best performing assets in each basket, "beautiful,
// streamlined, and really accommodating for basket buyers", RPC-efficient).
//
// EVERY INPUT IS LIFTED. This component opens no query of its own: holdings,
// the PnL index and the per-basket data all arrive as props from the page that
// already reads them. That is deliberate and is the RPC-efficiency answer —
// see basket-holder-stats.ts's header. If this ever needs a `useQuery`, check
// first whether the page already has the value.
//
// Rows are POSITIONS WITH ONE ACTION. The swap is the real DexSwapCard locked
// to that basket (`fixedBasket` + `strip`), never a lookalike — the house rule
// after three rejected recreations. It only mounts for the row you expand, so
// the collapsed list stays cheap.
// ─────────────────────────────────────────────────────────────────────────────

const usd = (v: number) =>
  moneyPrivacyOn() ? MASKED_USD : `$${v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 })}`
/** Signed money keeps its sign INSIDE the mask — privacy hides the amount, not
 *  the direction; a masked row that cannot say up or down is useless. */
const signedUsd = (v: number) => (v >= 0 ? '+' : '−') + usd(Math.abs(v))
const pct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`
const toneOf = (v: number) => (v > 0 ? 'text-teal' : v < 0 ? 'text-alert' : 'text-ink-dim')

function LegChip({ leg, label }: { leg: NonNullable<BasketHolderRow['best']>; label: string }) {
  const c = leg.change24hPct ?? 0
  return (
    <div className="min-w-0 flex-1">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="truncate font-display text-sm font-bold uppercase tracking-wide text-ink">${showSymbol(leg.symbol)}</span>
        <span className={`font-num text-sm tabular-nums ${toneOf(c)}`}>{pct(c)}</span>
      </div>
    </div>
  )
}

function Row({ row, data }: { row: BasketHolderRow; data: BasketData | null }) {
  const [open, setOpen] = useState(false)
  const p = row.pnl
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <button type="button" onClick={() => setOpen((v) => !v)} className="press flex w-full items-start justify-between gap-3 text-left">
        <span className="inline-flex min-w-0 items-center gap-2.5">
          <ChainBadge chainId={row.chainId} size="sm" />
          <span className="truncate font-display text-base font-bold uppercase tracking-wide text-ink">${showSymbol(row.symbol)}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-num text-base tabular-nums text-ink">{usd(row.valueUsd)}</span>
          {p ? (
            <span className={`block font-num text-xs tabular-nums ${toneOf(p.netUsd)}`}>
              {signedUsd(p.netUsd)} · {pct(p.netPct * 100)}
            </span>
          ) : (
            <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">no purchase on record</span>
          )}
        </span>
      </button>

      {(row.best || row.worst) && (
        <div className="mt-3 flex gap-4 border-t border-white/[0.06] pt-3">
          {row.best && <LegChip leg={row.best} label="best 24h" />}
          {row.worst && <LegChip leg={row.worst} label="worst 24h" />}
        </div>
      )}

      {/* what the read could NOT price, said rather than swallowed — a "best
          performer" picked from part of a basket is a misleading number */}
      {row.unpricedLegs > 0 && (
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
          {row.unpricedLegs} of {row.legs.length} holdings could not be priced — the movers above are drawn from the rest.
        </p>
      )}

      {open && (
        <div className="mt-4 space-y-3 border-t border-white/[0.06] pt-4">
          {p && (
            <dl className="grid grid-cols-3 gap-3 font-mono text-[11px] text-ink-dim">
              <div>
                <dt className="text-ink-faint">invested</dt>
                <dd className="mt-0.5 font-num text-sm tabular-nums text-ink">{usd(p.investedUsd)}</dd>
              </div>
              <div>
                <dt className="text-ink-faint">now worth</dt>
                <dd className="mt-0.5 font-num text-sm tabular-nums text-ink">{usd(p.currentUsd)}</dd>
              </div>
              <div>
                <dt className="text-ink-faint">realised</dt>
                <dd className={`mt-0.5 font-num text-sm tabular-nums ${p.realizedUsd === 0 ? 'text-ink-dim' : toneOf(p.realizedUsd)}`}>
                  {p.realizedUsd === 0 ? '—' : signedUsd(p.realizedUsd)}
                </dd>
              </div>
            </dl>
          )}
          {/* COVERAGE, said plainly. Below ~99% the basis covers only part of
              the position (tokens arrived by transfer, or before the index's
              first block), so the PnL above describes a subset — a number
              that silently described less than the whole position would be the
              kind of quiet wrongness this lane keeps finding. */}
          {p && p.coverage < 0.99 && (
            <p className="font-mono text-[10px] leading-relaxed text-amber-200/70">
              We can only trace what you paid for {Math.round(p.coverage * 100)}% of these tokens — the rest arrived another way, so the
              figures above cover that share only.
            </p>
          )}

          {row.legs.length > 0 && (
            <Carousel label={`${showSymbol(row.symbol)} holdings`} peek="78%" resetKey={row.key}>
              {row.legs.map((l) => (
                <div key={l.asset} className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-display text-sm font-bold uppercase tracking-wide text-ink">${showSymbol(l.symbol)}</span>
                    <span className={`font-num text-xs tabular-nums ${l.change24hPct == null ? 'text-ink-faint' : toneOf(l.change24hPct)}`}>
                      {l.change24hPct == null ? 'unpriced' : pct(l.change24hPct)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between gap-2 font-mono text-[10px] text-ink-faint">
                    <span>{l.liveWeightPct.toFixed(1)}% of basket</span>
                    <span className="font-num tabular-nums text-ink-dim">{usd(l.valueUsd)}</span>
                  </div>
                </div>
              ))}
            </Carousel>
          )}

          {/* the REAL swap card, locked to this basket — not a lookalike */}
          {/* locked to THIS basket when we have its data; without it the
              card would open a picker, which is not what a row-level action is */}
          {data && <DexSwapCard chainId={row.chainId} fixedBasket={data} strip />}
        </div>
      )}
    </div>
  )
}

export function BasketHolderStats({
  holdings,
  pnlByChain,
  dataByKey,
}: {
  holdings: readonly PortfolioHolding[]
  pnlByChain: Readonly<Record<number, PnlIndex | null | undefined>>
  dataByKey: ReadonlyMap<string, BasketData | null | undefined>
}) {
  const stats = buildBasketHolderStats(holdings, pnlByChain, dataByKey)
  // self-hide only when there is genuinely nothing to say (the LP lesson: a
  // section that hides on refused data swallows the sentence that mattered)
  if (stats.rows.length === 0) return null

  const hasBasis = stats.totalInvestedUsd > 0
  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-display text-lg font-bold uppercase tracking-tight text-ink">Your baskets</h3>
        {hasBasis && (
          <span className="inline-flex items-baseline gap-2">
            <span className={`font-num text-xl tabular-nums ${toneOf(stats.totalNetUsd)}`}>{signedUsd(stats.totalNetUsd)}</span>
            <span className={`font-num text-sm tabular-nums ${toneOf(stats.totalNetUsd)}`}>{pct(stats.totalNetPct * 100)}</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">since you bought</span>
          </span>
        )}
      </div>

      {stats.rowsWithoutBasis > 0 && (
        <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-ink-faint">
          {stats.rowsWithoutBasis === stats.rows.length
            ? 'No purchase history on record for these yet, so there is nothing to compare against.'
            : `${stats.rowsWithoutBasis} of ${stats.rows.length} not counted above — no purchase on record for them.`}
        </p>
      )}

      <div className="mt-4 space-y-3">
        {stats.rows.map((r) => (
          <Row key={r.key} row={r} data={dataByKey.get(r.key) ?? null} />
        ))}
      </div>
    </section>
  )
}
