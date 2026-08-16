import { ChainLogo, chainMeta } from './ChainBadge'
import { chainCfg } from '../lib/chain/chains'
import { formatUsdCompact } from '../lib/spectrum/format'

/** A chain mark shows no words by the owner's own ask, so the NAME has to
 *  reach the row some other way: hover text and the accessible name. A logo
 *  nobody recognises is a riddle, not a label. */
function chainName(chainId: number): string {
  try {
    return chainCfg(chainId).name
  } catch {
    return chainMeta(chainId).short
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MONEY, BROKEN DOWN BY A FACET (the owner 2026-08-06 12:53). One component because
// two surfaces describe the same thing and his ask named both in one breath:
//   · the hero, under the composition bar — money per CHAIN, logos not names;
//   · the reshape picture's foot — "total value on base… total value in defi…
//     total value in stocks", i.e. money per SPOTLIGHT CATEGORY, which is the
//     same row with a label where the chain logo goes.
//
// Facts only, in neutral ink: these are balances, not performance, so nothing
// here wears the teal/alert change palette. A row whose read failed says so in
// amber (caution semantics) and never shows a figure.
// ─────────────────────────────────────────────────────────────────────────────

export interface MoneyFacet {
  key: string
  /** Chain marks render as the logo alone (his ask); everything else is worded. */
  chainId?: number
  label?: string
  usd: number
  /** failed = the read did not answer · partial = read, but something on it is
   *  unpriced, so the figure is a floor rather than the total. */
  state?: 'ok' | 'partial' | 'failed'
  /** Recede while another facet is spotlit — the same light-bulb grammar the
   *  pills use on the tiles, so the foot reads as part of that gesture. */
  dim?: boolean
}

export function MoneyFacets({
  rows,
  size = 'md',
  className = '',
}: {
  rows: MoneyFacet[]
  /** md = the hero's line, one step up from the caption it replaced ·
   *  sm = the picture's foot, where it sits under a dense grid. */
  size?: 'sm' | 'md'
  className?: string
}) {
  if (rows.length === 0) return null
  const logo = size === 'md' ? 17 : 14
  const money = size === 'md' ? 'text-[15px]' : 'text-[13px]'
  const word = size === 'md' ? 'text-[10px]' : 'text-[9px]'
  return (
    <div className={`flex flex-wrap items-center gap-x-5 gap-y-2 ${className}`}>
      {rows.map((r) => {
        const failed = r.state === 'failed'
        const who = r.chainId != null ? chainName(r.chainId) : (r.label ?? '')
        return (
          <span
            key={r.key}
            title={failed ? `${who} — this network isn’t answering right now` : `${who} · ${formatUsdCompact(r.usd)}`}
            aria-label={failed ? `${who}: could not be read` : `${who}: ${formatUsdCompact(r.usd)}`}
            className={`inline-flex items-center gap-2 transition-opacity duration-300 ${r.dim ? 'opacity-35' : 'opacity-100'}`}
          >
            {r.chainId != null ? (
              <ChainLogo chainId={r.chainId} size={logo} className={failed ? 'opacity-40' : undefined} />
            ) : null}
            {r.label ? (
              <span className={`font-mono ${word} uppercase tracking-[0.14em] text-ink-faint`}>{r.label}</span>
            ) : null}
            {failed ? (
              <span className={`font-mono ${word} uppercase tracking-[0.14em] text-amber`}>couldn&rsquo;t read</span>
            ) : (
              <span className={`font-num ${money} font-semibold tabular-nums text-ink`}>
                {formatUsdCompact(r.usd)}
                {r.state === 'partial' && (
                  /* the figure is a floor, and the mark says which one is —
                     a page-wide caveat cannot point at a row */
                  <span className="ml-1 align-super font-mono text-[9px] font-normal text-amber" title="Something on this network has no readable price, so this is at least this much">
                    +
                  </span>
                )}
              </span>
            )}
          </span>
        )
      })}
    </div>
  )
}
