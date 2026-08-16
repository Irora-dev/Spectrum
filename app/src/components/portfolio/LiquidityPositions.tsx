import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import { SUPPORTED_CHAIN_IDS, chainCfg } from '../../lib/chain/chains'
import { readLpPositions, type LpPositionsRead } from '../../lib/spectrum/lp-positions'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { MASKED_USD, moneyPrivacyOn } from '../../lib/spectrum/format'
import { ChainBadge } from '../ChainBadge'
import { Carousel } from '../Carousel'

// ─────────────────────────────────────────────────────────────────────────────
// LIQUIDITY POSITIONS — the portfolio book's display-only v3 LP rows (owner's
// third ask, greenlit 2026-08-15). Rows are POSITIONS, NEVER CONTROLS (the
// basket-vs-exposure ruling's shape): no add, no remove, no collect — the row
// says what exists, its range state and a spot value. Self-hides when the
// wallet holds none. Capped/unsupported chains are SAID, never silent.
// ─────────────────────────────────────────────────────────────────────────────

const feePct = (pips: number) => `${(pips / 10_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
// privacy mode masks LP dollars like every other holdings figure (the page's
// own $•••• law — these rows joined the book, so they join the mask)
const usd = (v: number) =>
  moneyPrivacyOn() ? MASKED_USD : `$${v.toLocaleString(undefined, { maximumFractionDigits: v >= 1000 ? 0 : 2 })}`
const amt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: v >= 100 ? 2 : 5 })

export function LiquidityPositions({ data: lifted }: { data?: LpPositionsRead }) {
  const { address } = useAccount()
  const { data: own } = useQuery({
    queryKey: ['lp-positions', address],
    queryFn: () => readLpPositions(address as Address, [...SUPPORTED_CHAIN_IDS]),
    // a parent that already reads passes the data down — one read, two surfaces
    enabled: !!address && lifted === undefined,
    staleTime: 60_000,
    refetchInterval: 120_000,
  })
  const data = lifted ?? own
  // ⚠ SELF-HIDE ONLY WHEN THERE IS TRULY NOTHING TO SAY (the first cut hid the
  // whole section when the v4 log scan was refused — swallowing the exact
  // "N positions exist that this connection cannot list" sentence the refusal
  // needs; the hide-nothing law, on my own component)
  if (!address || !data) return null
  if (data.positions.length === 0 && data.unreadableV4.length === 0) return null
  const total = data.positions.reduce((s, p) => s + (p.valueUsd ?? 0), 0)
  const anyPartial = data.positions.some((p) => p.partialPricing || p.valueUsd == null) || data.unreadableV4.length > 0

  return (
    <div className="mt-6">
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h2 className="font-display text-[13px] font-bold uppercase tracking-[0.18em] text-ink-dim">
          Liquidity positions
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          uniswap v3 + v4 · read from the chain · view only
        </span>
        <span className="ml-auto font-num text-sm tabular-nums text-ink-dim">
          {anyPartial ? '≥ ' : '≈ '}
          {usd(total)}
        </span>
      </div>
      {/* a rail at EVERY width (owner 2026-08-16: "lp positions should be a
          slideshow/carousel") — gridFrom never keeps the snap slideshow on
          desktop too, matching the recent-transactions card beside it */}
      <Carousel label="Liquidity positions" gridFrom="never" peek="320px">
        {data.positions.map((p) => {
          // the position's own page on Uniswap's interface — only where that
          // interface serves the chain (a dead link is worse than none)
          const uniSlug = p.chainId === 1 ? 'ethereum' : p.chainId === 8453 ? 'base' : null
          const uniHref = uniSlug ? `https://app.uniswap.org/positions/v${p.version}/${uniSlug}/${p.tokenId}` : null
          // EQUAL HEIGHTS (owner 2026-08-16): the card is a full-height column
          // and the money row seats on the shared bottom line via mt-auto —
          // the partial-pricing note grows the column, never staggers the rail
          return (
            <div key={`${p.chainId}:${p.tokenId}`} className="flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <ChainBadge chainId={p.chainId} size="sm" />
                <span className="min-w-0 truncate font-display text-sm font-bold uppercase tracking-wide text-ink">
                  {showSymbol(p.token0.symbol)} / {showSymbol(p.token1.symbol)}
                </span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                  v{p.version} · {feePct(p.fee)}
                </span>
                {/* one line, always (owner 2026-08-16) */}
                <span
                  className={`ml-auto shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] ${
                    p.inRange ? 'border-teal/30 text-teal' : 'border-amber-300/30 text-amber-200/90'
                  }`}
                >
                  {p.inRange ? 'in range' : 'out of range'}
                </span>
              </div>
              <div className="mt-3 flex items-end justify-between gap-3 pt-1 [margin-top:auto]">
                <span className="font-mono text-[11px] leading-relaxed text-ink-dim">
                  {amt(p.amount0)} {showSymbol(p.token0.symbol)} · {amt(p.amount1)} {showSymbol(p.token1.symbol)}
                </span>
                <span className="font-num text-[15px] tabular-nums text-ink">
                  {p.valueUsd != null ? `${p.partialPricing ? '≥ ' : ''}${usd(p.valueUsd)}` : 'unpriced'}
                </span>
              </div>
              {p.partialPricing && (
                <p className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
                  one side unpriced — the value shows the readable half only
                </p>
              )}
              {uniHref && (
                <a
                  href={uniHref}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block font-mono text-[10px] uppercase tracking-[0.12em] text-cyan hover:underline"
                >
                  manage on uniswap ↗
                </a>
              )}
            </div>
          )
        })}
      </Carousel>
      {(data.cappedChains.length > 0 || data.unsupportedChains.length > 0 || data.unreadableV4.length > 0) && (
        <p className="mt-2.5 font-mono text-[10px] leading-relaxed text-ink-faint">
          {data.cappedChains.length > 0 &&
            `showing the first 40 per network on ${data.cappedChains.map((c) => chainCfg(c).name).join(', ')} — more exist. `}
          {data.unreadableV4.map(
            (u) =>
              `${u.count} v4 position${u.count === 1 ? '' : 's'} exist${u.count === 1 ? 's' : ''} on ${chainCfg(u.chainId).name} that this connection cannot list (the log scan was refused — an RPC key fixes it). `,
          )}
          {data.unsupportedChains.length > 0 &&
            `${data.unsupportedChains.map((c) => chainCfg(c).name).join(', ')}: position reading not wired yet on this network.`}
        </p>
      )}
    </div>
  )
}
