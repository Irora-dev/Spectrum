import { useAccount } from 'wagmi'
import { DEV_PREVIEW_ADDRESS } from '../../lib/spectrum/dev-preview'
import { useLaunchJourneys } from '../../lib/spectrum/use-launch-journey'
import { LaunchJourneyCard } from './LaunchJourneyCard'

// ─────────────────────────────────────────────────────────────────────────────
// "CONTINUE YOUR LAUNCH" — the resume surface the owner's 2026-08-13 ruling names:
// "even if you accidentally refresh or click off you should always be able to
// resume from your creator page or /create."
//
// SELF-CONTAINED BY DESIGN. It takes no data props: it finds the wallet, finds
// the drafts, reads the chain, and either renders or renders NOTHING. That is
// what makes mounting it a one-line change on any surface — which matters,
// because /create's page files were owned by another lane while this was built.
//
// THE PRECEDENT IT FOLLOWS is already in this repo, and is the same ruling one
// step earlier. The Token page's post-deploy setup used to hang off `?deployed=1`
// until a live user refreshed between deploy and seeding and lost the whole
// ceremony (the owner, 2026-08-06 23:2x). The fix was to gate on DURABLE FACTS
// instead of navigation. This card is that fix generalised to the whole
// journey: it appears because there IS an unfinished launch, not because of how
// you got here — so a refresh, a new tab, or a different device all show it.
//
// It shows ONE journey, the most urgent (a draft first, then whatever is
// blocking a live basket — launchJourneys' own order). A creator with three
// loose ends does not need a wall; they need the next thing.
// ─────────────────────────────────────────────────────────────────────────────

export function ResumeLaunchCard({
  /** The page already restores the composer draft itself (the /create face
   *  does), so offering to "continue" it there would be a card pointing at the
   *  screen it is already on. Deployed baskets and studio drafts still show. */
  composerDraftRestoredHere = false,
  /** Scope to a specific wallet — the creator page passes the page's address so
   *  a visitor never sees the owner's unfinished business. Absent = the
   *  connected wallet. */
  wallet,
  className = '',
}: {
  composerDraftRestoredHere?: boolean
  wallet?: string
  className?: string
} = {}) {
  const { address, isConnected } = useAccount()
  // The house's dev stand-in (use-held-baskets' exact line): with no wallet on
  // a dev server the surfaces render populated, and the moment a REAL wallet
  // connects every read is real. Never in a shipped build.
  const connected = isConnected && address ? address : import.meta.env.DEV ? DEV_PREVIEW_ADDRESS : undefined
  const subject = wallet ?? connected
  // Someone else's page shows nobody's launches — the journey is private work.
  const isOwn = !!subject && !!connected && subject.toLowerCase() === connected.toLowerCase()

  const { journeys } = useLaunchJourneys(isOwn ? subject : undefined, {
    enabled: isOwn,
    skipComposerDraft: composerDraftRestoredHere,
  })

  const journey = journeys[0]
  // Nothing in flight is NOTHING on screen — never an empty card, never a
  // "you're all caught up" banner nobody asked for.
  if (!journey) return null

  return (
    <LaunchJourneyCard journey={journey} eyebrow="continue your launch" className={className} />
  )
}
