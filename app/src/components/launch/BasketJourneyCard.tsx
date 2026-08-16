import { useAccount } from 'wagmi'
import { useBasketJourney } from '../../lib/spectrum/use-launch-journey'
import { LaunchJourneyCard } from './LaunchJourneyCard'

// ─────────────────────────────────────────────────────────────────────────────
// THE POST-DEPLOY FACE of the launch journey — "your basket is live → seed it →
// write its thesis → share it", on the basket's own page.
//
// It is the SAME card the creator page shows, fed the same judged journey, so
// the two surfaces cannot disagree about whether a basket has been seeded. What
// changes here is only where the doors point: this page already hosts the buy
// console, the thesis editor and the share modal, so each step scrolls to the
// thing in place instead of navigating to a copy of this page.
//
// WHAT IT REPLACED, AND WHY THAT WAS A FIX (2026-08-13). The block that used to
// stand here — "Your basket is live but empty" — gated on `ix.aumUsd <= 0`.
// aumUsd is 0 on an unseeded basket AND on a seeded basket whose pricing simply
// failed to come back, so a live, fully-seeded basket on a quiet RPC was told
// its creator it held nothing. That is the exact class of lie the journey model
// exists to stop: the seed step now reads `effectiveSupply`, the only value
// that distinguishes "empty" (0) from "could not read" (null), and an
// unreadable one draws as "couldn't read" rather than as either answer.
//
// Self-contained and creator-only: a visitor's basket page renders nothing
// here, and neither does a finished basket's.
// ─────────────────────────────────────────────────────────────────────────────

export function BasketJourneyCard({
  chainId,
  address,
  name,
  symbol,
  effectiveSupply,
  deployer,
  anchors,
  className = '',
}: {
  chainId: number
  address: string
  name: string
  symbol: string
  /** From the page's own BasketData: `null` = the view reverted, `undefined` =
   *  not read yet. The distinction is the whole point — see the header. */
  effectiveSupply: number | null | undefined
  deployer: string | null
  anchors?: { seed?: string; thesis?: string; share?: string }
  className?: string
}) {
  const { address: viewer } = useAccount()
  const isDeployer = !!viewer && !!deployer && viewer.toLowerCase() === deployer.toLowerCase()

  const { journey } = useBasketJourney({
    chainId,
    address,
    name,
    symbol,
    // Held back until the viewer is known to be the creator: nobody else's
    // page should be paying for a note-registry scan they will never see.
    effectiveSupply: isDeployer ? effectiveSupply : undefined,
    deployer,
  })

  if (!isDeployer || !journey) return null
  // A finished journey says nothing: the card is for the loose ends, and a
  // creator whose basket is live, seeded and written does not need a banner
  // telling them so on every visit.
  if (journey.complete && journey.next == null) return null

  return (
    <LaunchJourneyCard
      journey={journey}
      eyebrow={journey.resumeAt ? 'finish your launch' : 'your basket is live'}
      anchors={anchors}
      className={className}
    />
  )
}
