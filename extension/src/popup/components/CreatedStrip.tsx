// Baskets this address created — the creator's reason to keep the lens
// installed. Compact: symbol, AUM, 24h. Rows deep-link to the basket on the
// operator site (intent only; the site recomputes everything).

import { BasketAvatar } from '@app/components/BasketAvatar'
import { formatUsdCompact } from '@app/lib/spectrum/format'
import type { SnapshotCreated } from '../../shared/portfolio'
import { tokenUrl } from '../../shared/deeplink'
import { chainLabel, SectionRule, SignedFigure } from './bits'

export function CreatedStrip({ created, base }: { created: SnapshotCreated[]; base: string | null }) {
  if (created.length === 0) return null
  return (
    <section className="px-4 pt-6">
      <div className="mb-2">
        <SectionRule>your baskets</SectionRule>
      </div>
      <ul className="divide-y divide-white/5">
        {created.map((b) => {
          const row = (
            <>
              {/* The site's own basket mark (deterministic spectral gradient),
                  so a basket looks like ITSELF in both places. */}
              <BasketAvatar address={b.address} symbol={b.symbol} size={20} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-mono text-[12px] font-medium text-ink">{b.symbol}</span>
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                    {chainLabel(b.chainId)}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">{b.name}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-display text-[13px] font-semibold text-ink tnum">{formatUsdCompact(b.aumUsd)}</div>
                <div className="font-mono text-[10px]">
                  {b.change24hPct == null ? (
                    <span className="text-ink-faint">—</span>
                  ) : (
                    <SignedFigure value={b.change24hPct} suffix="%" />
                  )}
                </div>
              </div>
            </>
          )
          return (
            <li key={`${b.chainId}:${b.address}`}>
              {base ? (
                <a
                  href={tokenUrl(base, b.address, b.chainId)}
                  target="_blank"
                  rel="noreferrer"
                  className="press flex h-12 items-center gap-3 rounded-md px-1 -mx-1 hover:bg-white/[0.04]"
                >
                  {row}
                </a>
              ) : (
                <div className="flex h-12 items-center gap-3">{row}</div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
