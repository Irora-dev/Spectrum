import { useMintHealth } from '../lib/spectrum/use-mint-health'
import { InfoDot } from './InfoDot'

// A symbol is whatever a deployer typed, and THIS banner is where hostile ones
// will land (a garbage token is both the likeliest dead leg and the likeliest
// hostile symbol — specallocator's redteam D4: shown text is a money surface).
// Bounded (clipped with a VISIBLE ellipsis) + inert (controls, bidi overrides,
// zero-width stripped; whitespace collapsed) + never empty. Local on purpose:
// safe-copy.ts (the shared module) rides the allocator absorption — swap this
// for its showSymbol when that lands; do not grow this helper.
function boundSymbol(raw: string): string {
  const inert = raw
    // C0/C1 controls, zero-widths + BOM, and bidi embeddings/overrides/isolates
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\ufeff\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!inert) return 'this constituent'
  return inert.length > 12 ? `$${inert.slice(0, 12)}\u2026` : `$${inert}`
}

// The mint pre-flight's face: when a constituent's routing pool is missing or
// empty, NO buy of this basket can succeed — at any size, on any retry — until
// someone provides liquidity there. Saying so above the console turns the most
// mystifying LegMinNotMet cause (contracts' live dead-leg case) into a plain
// statement before money is typed in. Renders NOTHING while healthy, unknown,
// or still loading: 'unknown' never gates, and this banner never blocks the
// console — the contract stays the final arbiter; this is honesty, not a lock.
export function DeadLegNotice({ address, chainId }: { address: string; chainId: number }) {
  const { data } = useMintHealth(address, chainId)
  const dead = data?.dead ?? []
  if (dead.length === 0) return null
  const names = dead.map((l) => (l.symbol ? boundSymbol(l.symbol) : `${l.asset.slice(0, 6)}…${l.asset.slice(-4)}`))
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return (
    <div className="rounded-2xl border border-amber-400/30 bg-amber-400/[0.06] p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200/90">
        This basket can&rsquo;t be bought right now
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-dim">
        {names.length === 1 ? (
          <>
            <strong className="text-ink">{list}</strong> has no tradeable market — its trading pool{' '}
            {dead[0].reason === 'no-pool' ? 'doesn’t exist' : 'holds no liquidity'}.
          </>
        ) : (
          <>
            <strong className="text-ink">{list}</strong> have no tradeable market — their trading pools are
            missing or hold no liquidity.
          </>
        )}{' '}
        A buy has to acquire every constituent, so no amount, retry, or slippage setting changes this. It
        becomes buyable when that market gains liquidity — if you created this basket, that&rsquo;s yours to
        provide or re-point.
        <InfoDot>
          Checked against the same pool each constituent actually trades through, moments ago. This is a
          property of the constituent&rsquo;s market, not of your wallet or settings — and not a bug in the
          basket contract: it is refusing honestly rather than filling a leg with nothing.
        </InfoDot>
      </p>
    </div>
  )
}
