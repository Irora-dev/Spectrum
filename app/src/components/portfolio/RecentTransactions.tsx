import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { useMemo } from 'react'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { loadTradeHistory } from '../../lib/spectrum/use-trade-history'
import { loadExecLogGroup } from '../../lib/spectrum/exec-log'
import { BasketAvatar } from '../BasketAvatar'
import { ChainBadge } from '../ChainBadge'
import { basketHref } from '../../lib/spectrum/short-url'

// ─────────────────────────────────────────────────────────────────────────────
// RECENT TRANSACTIONS (recording 1221, the owner: "below the basket system and
// above the liquidity positions, a recent transactions card with a scrollable
// carousel … how much the transaction was, what you bought, what you sold,
// with the little logos — pretty, not overloaded with text, good spacing, a
// slideshow that works on mobile and desktop").
//
// DATA: the SAME trade stream the tax export reads (loadTradeHistory over the
// linked group) — the PnL indexes this page already builds serve it, so the
// card adds no new log scans after the book's own warmup. Figures are the
// stream's own: settlement dollars per trade, realized on sells.
//
// FORM: one snap rail on every size (his slideshow ask), each card a figure
// with two quiet lines — never a table. A trade younger than ten minutes
// wears the arrival ring, which is how "you literally see the new one pop
// up" without a second glow store (the bento's run-landed flag is spend-on-
// read and already spent by the tiles).
// ─────────────────────────────────────────────────────────────────────────────

const FRESH_MS = 10 * 60_000

/** One card's facts, whichever stream it came from. `address`/`chainId`
 *  null = an exec-log row with no on-chain identity — no link, seed avatar. */
interface Row {
  ts: number | null
  symbol: string
  usd: number | null
  side: 'bought' | 'sold' | 'run'
  chainId: number | null
  address: string | null
  realizedUsd: number | null
}

function ago(ts: number | null): string {
  if (ts == null) return 'date unknown'
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function RecentTransactions({
  wallets,
  symbolOf,
}: {
  /** The linked group — the same set every read on this page covers. */
  wallets: readonly string[]
  /** Basket address (lowercase) → ticker, from the page's own catalog read. */
  symbolOf: (chainId: number, address: string) => string | null
}) {
  const key = [...wallets].map((w) => w.toLowerCase()).sort().join(',')
  const { data } = useQuery({
    queryKey: ['trade-history-recent', key],
    queryFn: () => loadTradeHistory(wallets, { fromMs: Date.now() - 30 * 86_400_000 }),
    enabled: wallets.length > 0,
    staleTime: 30_000,
    refetchOnMount: 'always', // landing back from a run must show the new trade
  })
  const rows = useMemo(() => {
    // ONE ROW SHAPE, TWO STREAMS (owner 2026-08-16: "should show all txs").
    // The on-chain basket trades stay the spine; the exec log adds what the
    // chain read can't attribute — batcher runs' per-asset legs and single
    // console swaps — flattened one row per moved asset. Dedupe drops an
    // exec row when a basket row already tells the same trade (same symbol,
    // within 15 minutes, within 2% of the dollars): on-chain truth wins.
    const basket: Row[] = (data?.history.rows ?? []).map((r) => ({
      ts: r.ts,
      symbol: symbolOf(r.chainId, r.basket) ?? `${r.basket.slice(0, 6)}…`,
      usd: r.settlementUsd,
      side: r.kind === 'buy' ? ('bought' as const) : ('sold' as const),
      chainId: r.chainId,
      address: r.basket,
      realizedUsd: r.kind === 'sell' ? r.realizedUsd : null,
    }))
    const exec: Row[] = wallets.length
      ? loadExecLogGroup([...wallets]).flatMap((e): Row[] => {
          if (e.simulated) return []
          const perAsset = (e.changes ?? []).filter((c) => Math.abs(c.deltaUsd) > 0.5)
          if (perAsset.length > 0)
            return perAsset.map((c) => ({
              ts: Math.floor(e.ts / 1000),
              symbol: c.symbol,
              usd: Math.abs(c.deltaUsd),
              side: c.deltaUsd >= 0 ? ('bought' as const) : ('sold' as const),
              chainId: null,
              address: null,
              realizedUsd: c.realizedUsd ?? null,
            }))
          // PRE-GETTER ROWS (owner 2026-08-16: "still don't see past ones?"):
          // runs logged before the changes-getter carry only the run's total
          // and time — real history, so it shows as ONE card per run with
          // what is actually known, never invented per-asset detail.
          if (e.totalUsd != null && e.totalUsd > 0.5)
            return [
              {
                ts: Math.floor(e.ts / 1000),
                symbol: e.kind === 'create' ? 'PORTFOLIO CREATED' : e.kind === 'publish' ? 'BASKET PUBLISHED' : 'PORTFOLIO RUN',
                usd: e.totalUsd,
                side: 'run' as const,
                chainId: null,
                address: null,
                realizedUsd: null,
              },
            ]
          return []
        })
      : []
    const kept = exec.filter(
      (x) =>
        !basket.some(
          (b) =>
            b.symbol.toLowerCase() === x.symbol.toLowerCase() &&
            b.ts != null &&
            x.ts != null &&
            Math.abs(b.ts - x.ts) < 900 &&
            b.usd != null &&
            x.usd != null &&
            Math.abs(b.usd - x.usd) <= Math.max(1, b.usd * 0.02),
        ),
    )
    return [...basket, ...kept].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, 12)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, key])

  if (rows.length === 0) return null

  return (
    <section className="mt-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="font-display text-[13px] font-bold uppercase tracking-[0.18em] text-ink-dim">Recent transactions</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          your basket trades, newest first
        </span>
      </div>
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:px-0">
        {rows.map((r, i) => {
          const buy = r.side === 'bought'
          const fresh = r.ts != null && Date.now() - r.ts * 1000 < FRESH_MS
          const body = (
            <>
              <div className="flex items-center justify-between gap-2">
                {/* the ticker shows WHOLE (owner 2026-08-16: "should be able
                    to see the ticker name without the …") — it wraps before
                    it ever ellipsizes */}
                <span className="flex min-w-0 items-center gap-2">
                  <BasketAvatar address={r.address ?? r.symbol} symbol={r.symbol} size={24} />
                  <span className="min-w-0 break-words font-display text-sm font-bold uppercase tracking-wide text-ink">
                    {r.side === 'run' ? r.symbol : `$${showSymbol(r.symbol)}`}
                  </span>
                </span>
                {r.chainId != null && <ChainBadge chainId={r.chainId} size="sm" />}
              </div>
              <div className="mt-3 font-num text-2xl font-light leading-none tabular-nums text-ink">
                {r.usd != null ? usd(r.usd) : '—'}
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.12em]">
                <span className={r.side === 'run' ? 'text-cyan' : buy ? 'text-teal' : 'text-magenta'}>{r.side}</span>
                <span className="text-ink-faint">{fresh ? 'just landed ✓' : ago(r.ts)}</span>
              </div>
              {!buy && r.realizedUsd != null && (
                <div className={`mt-1 font-mono text-[10px] tabular-nums ${r.realizedUsd >= 0 ? 'text-teal' : 'text-magenta'}`}>
                  {r.realizedUsd >= 0 ? '+' : '−'}
                  {usd(Math.abs(r.realizedUsd))} realized
                </div>
              )}
            </>
          )
          const shell = `press group relative min-w-0 shrink-0 basis-[240px] snap-start rounded-2xl border p-4 transition-colors hover:border-cyan/50 ${
            fresh ? 'border-teal/45 shadow-[0_0_24px_-8px_rgba(62,240,200,0.55)]' : 'border-white/10'
          } bg-white/[0.03]`
          const rowKey = `${r.chainId ?? 'x'}:${r.address ?? r.symbol}:${r.ts ?? 'undated'}:${i}`
          // an exec-log row has no on-chain identity to link — a plain card
          return r.address != null && r.chainId != null ? (
            <Link key={rowKey} to={basketHref({ chainId: r.chainId, address: r.address, symbol: r.symbol })} className={shell}>
              {body}
            </Link>
          ) : (
            <div key={rowKey} className={shell}>
              {body}
            </div>
          )
        })}
      </div>
    </section>
  )
}
