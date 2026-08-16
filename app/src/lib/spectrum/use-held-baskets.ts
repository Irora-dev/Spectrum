import { useMemo } from 'react'
import { useAccount } from 'wagmi'
import { usePortfolio } from './hooks'
import { useWalletGroup } from './use-wallet-group'
import { indexHeldBaskets, type HeldIndex } from './held-baskets'
import { DEV_PREVIEW_ADDRESS } from './dev-preview'

// ─────────────────────────────────────────────────────────────────────────────
// "You hold this" for a WHOLE PAGE of cards (QOL round 2026-08-05).
//
// A THIN COMPOSITION, NEVER A SECOND READ PATH — the same posture as
// use-book-total.ts: the same wallet group, the same usePortfolio, the same query
// keys. Two consequences that are the whole point:
//   · LINKED WALLETS READ AS ONE BOOK (wallet-links.ts): a basket held by a
//     linked wallet is held, exactly as the portfolio page counts it, so the
//     discovery page and the portfolio cannot disagree about what you own.
//   · The nav's book total already runs this query for the connected wallet, so a
//     page calling this adds ZERO network reads — it joins a read in flight.
//
// CALL IT ONCE, AT THE PAGE, and pass each card its own resolved position
// (held-baskets.ts). Per-card calls would dedupe at the query layer but still run
// N subscriptions and N folds over the whole catalogue for one answer the page
// already has.
// ─────────────────────────────────────────────────────────────────────────────

/** Held positions keyed by heldKey(), for the whole page. Empty with no wallet
 *  connected, which is exactly "no marker anywhere" — the cards need no second
 *  flag for it. */
export function useHeldBaskets(): HeldIndex {
  const { address, isConnected } = useAccount()
  // The documented dev fallback (dev-preview.ts): with no wallet connected, a
  // local build reads the preview identity so the marker is reviewable at all.
  // Impossible in production — `import.meta.env.DEV` is statically false and the
  // stand-in answers for this one address only, so a real wallet is always read
  // as itself.
  const viewer = isConnected && address ? address : import.meta.env.DEV ? DEV_PREVIEW_ADDRESS : undefined
  const group = useWalletGroup(viewer)
  const addresses = viewer ? group.addresses : undefined
  const { data } = usePortfolio(addresses)
  return useMemo(() => indexHeldBaskets(data?.holdings), [data])
}
