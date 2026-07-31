import { InfoDot } from './InfoDot'

// "Why did my trade revert?" — the ⓘ that rides a surfaced LegMinNotMet
// (owner 2026-07-31: show the LIKELIHOOD ranking, not just the decoded name).
// The error text itself stays friendlyRevert's; this only appends causes,
// most-likely first, so a buyer can self-diagnose instead of blind-retrying.
// Display-only — no trade path is touched.
const MATCH = /LegMinNotMet|per-leg minimum/i

export function RevertCauses({ error }: { error: string | null | undefined }) {
  if (!error || !MATCH.test(error)) return null
  return (
    <InfoDot>
      Most likely first: ① the pool for one constituent is thin, so your own trade moves its
      price past the tolerance — at a given size this fails every retry; a smaller amount is
      the test and the fix. ② The price moved between quoting and signing (busy pool; stock
      tokens also trade 24/7). ③ A sandwich attempt was refused — this floor existing is why
      it wasn&rsquo;t profitable. ④ Rare: a constituent rebased mid-trade. Raising slippage
      widens the tolerance but weakens the protection — prefer smaller size on thin pools.
    </InfoDot>
  )
}
