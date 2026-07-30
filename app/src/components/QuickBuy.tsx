import { Link } from 'react-router-dom'
import { SWAP_ENABLED } from '../lib/config/features'
import { pageEnabled } from '../theme/brand'
import brand from '../brand.config'

// ─────────────────────────────────────────────────────────────────────────────
// QUICK BUY (owner 2026-07-29, ease-of-buying): a buy affordance ON the card,
// wherever a basket appears. It does NOT introduce a second buy path — it deep
// links into the one console (/swap?basket=&chain=&amt=) with the basket and a
// starting amount already filled, so the buyer lands on a quote instead of an
// empty form. Two clicks become one, and the money path stays single.
//
// Hidden unless trading is armed AND the operator ships the trade page, since
// the destination is that page.
// ─────────────────────────────────────────────────────────────────────────────

/** A sane opening amount. An empty field is a decision forced on the buyer. */
export const DEFAULT_BUY_USD = 100

export function QuickBuy({
  address,
  chainId,
  symbol,
  amountUsd = DEFAULT_BUY_USD,
  className = '',
}: {
  address: string
  chainId: number
  symbol?: string
  amountUsd?: number
  className?: string
}) {
  if (!SWAP_ENABLED || !pageEnabled(brand.pages, 'trade')) return null
  return (
    <Link
      to={`/swap?basket=${address}&chain=${chainId}&amt=${amountUsd}`}
      onClick={(e) => e.stopPropagation()}
      aria-label={symbol ? `Buy $${symbol}` : 'Buy this basket'}
      className={`press inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-cyan px-3.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-black transition-transform hover:scale-[1.03] ${className}`}
    >
      Buy
      <span aria-hidden>→</span>
    </Link>
  )
}
