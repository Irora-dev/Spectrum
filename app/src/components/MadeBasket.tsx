import { useMemo } from 'react'
import { Link } from 'react-router'
import { Bezel, Reveal } from './home/Spine'
import { BasketAvatar } from './BasketAvatar'
import { BasketBento } from './BasketBento'
import { formatUsdCompact, shortAddr } from '../lib/spectrum/format'
import { basketHref } from '../lib/spectrum/short-url'
import { showSymbol } from '../lib/spectrum/safe-copy'
import type { BasketSummary } from '../lib/spectrum/basket-data'

/** THE MADE BASKET — what crafting a thesis actually produces, shown whole and
 *  real: the basket with the most holders, its ticker, its contract address,
 *  its true composition as the bento, and the two facts that matter. Reads from
 *  chain only; no readable basket renders nothing, never a mock.
 *
 *  Moved verbatim from pages/HomeSpine.tsx (owner 1826: the Baskets page's
 *  intro shows the same real object) — ONE component on both mounts, so the
 *  two surfaces cannot drift apart. */
export function MadeBasket({ baskets }: { baskets: BasketSummary[] }) {
  const b = useMemo(() => {
    const candidates = baskets.filter((x) => (x.top?.length ?? 0) >= 2)
    return (
      [...candidates].sort(
        (x, y) => (y.holdersCount ?? 0) - (x.holdersCount ?? 0) || y.aumUsd - x.aumUsd,
      )[0] ?? null
    )
  }, [baskets])
  if (!b) return null
  const items = (b.top ?? []).map((t) => ({
    symbol: t.symbol,
    address: t.address,
    weightPct: t.weightPct || 1,
    chainId: b.chainId,
  }))
  return (
    <Reveal>
      <Bezel className="mx-auto w-full max-w-4xl" glow="var(--color-magenta)">
        <div className="p-6 sm:p-10">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <BasketAvatar address={b.address} symbol={b.symbol} size={56} />
            <Link to={basketHref(b)} className="group min-w-0">
              <span className="block truncate font-display text-2xl font-bold text-ink transition-colors group-hover:text-cyan">
                ${showSymbol(b.symbol)}
              </span>
              <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                {shortAddr(b.address)}
              </span>
            </Link>
            <span className="ml-auto flex items-center gap-8 text-right">
              {b.holdersCount != null && (
                <span>
                  <span className="block font-num text-2xl font-light tabular-nums text-ink">{b.holdersCount}</span>
                  <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                    holders
                  </span>
                </span>
              )}
              {b.aumUsd > 0 && (
                <span>
                  <span
                    className="block font-num text-2xl font-light tabular-nums"
                    style={{ color: 'var(--color-teal)' }}
                  >
                    {formatUsdCompact(b.aumUsd)}
                  </span>
                  <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                    trading through it
                  </span>
                </span>
              )}
            </span>
          </div>
          <div className="mt-6">
            <BasketBento items={items} aspect={2.2} />
          </div>
        </div>
      </Bezel>
    </Reveal>
  )
}
