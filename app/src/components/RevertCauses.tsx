import { InfoDot } from './InfoDot'

// "Why did my trade revert?" — the ⓘ that rides a surfaced LegMinNotMet
// (owner 2026-07-31: show the LIKELIHOOD ranking, not just the decoded name).
// The error text itself stays friendlyRevert's; this only appends causes,
// most-likely first, so a buyer can self-diagnose instead of blind-retrying.
// Display-only — no trade path is touched.
//
// ⛔ THREE causes share this one error and their remedies are OPPOSITE
// (contracts, measured on the live registry 2026-08-04): TWAP lag heals in
// ~30 min (retry) · a thin pool fails at THIS size forever (size down) · a
// structurally dead leg fails at EVERY size forever (retrying is futile —
// the constituent has no market until someone provides liquidity). The old
// copy said "never stuck", which was true for the first cause and actively
// misleading for the third — a dead-leg buyer would retry on our advice
// forever. The discriminator below is the user-side test for which case
// they're in; the pre-flight (leg-health) is the kit-side answer.
const MATCH = /LegMinNotMet|per-leg minimum/i

export function RevertCauses({ error }: { error: string | null | undefined }) {
  if (!error || !MATCH.test(error)) return null
  return (
    <InfoDot>
      One error, three causes — and you can tell them apart: ① after a burst of buying,
      the protection floor lags the moved price and refuses honestly — measured to heal on
      its own in ~30 minutes with no one doing anything. <strong className="text-ink">If the
      same amount works half an hour later, this was it; nothing is wrong.</strong> ② The pool
      for one constituent is thin, so your own trade moves its price past the tolerance.{' '}
      <strong className="text-ink">If a smaller amount works right now, this is it</strong> —
      size down; this size will fail every retry. ③{' '}
      <strong className="text-ink">If no amount ever works, one constituent has no tradeable
      market at all</strong> (its pool is empty or missing) — retrying will never help, at any
      size, on any day. That basket can&rsquo;t be bought until someone provides liquidity for
      that constituent; if you created it, that&rsquo;s yours to fix or re-point. Rarer: the
      price moved between quoting and signing (busy pool; stock tokens also trade 24/7) · a
      sandwich attempt was refused (this floor existing is why it wasn&rsquo;t profitable) · a
      constituent rebased mid-trade. Raising slippage widens the tolerance but weakens the
      protection — prefer smaller size on thin pools.{' '}
      <strong className="text-ink">On a SELL, that tolerance is the only protection there is</strong>{' '}
      (a sell has no per-leg floors, just one aggregate floor), so widening it there is exactly
      what a sandwich takes — measured at 7% of a seller&rsquo;s fill. Smaller size, not wider
      tolerance, on the sell side.
    </InfoDot>
  )
}
