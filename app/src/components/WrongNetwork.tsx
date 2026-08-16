import { useEffect } from 'react'
import type { CSSProperties } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { ChainBadge } from './ChainBadge'

// ── SAY THE NETWORK BEFORE THE SIGNATURE, NOT AFTER IT ───────────────────────
// Owner's report (QOL round 2026-08-05): "nothing shows a wrong-network state
// until a transaction fails". A wallet parked on another network read normally
// all the way down to the action, and the first honest word came from the wallet
// at signing time. The notice below states the mismatch in words, before the
// action, with BOTH networks named: the wallet's and the one the action needs.
//
// ONE COMPONENT, SIX SURFACES (consolidation 2026-08-05). This started life
// inside TradePanel as a local `WrongNetworkGate`, while five other surfaces
// (the swap console, the deploy portal, the upgrade modal, cross-chain funding,
// crown withdrawals) each hand-wrote a DESTINATION-ONLY version of the same
// warning — they named where you had to be and left you guessing where you
// were. They all consume this now, so the qualities below hold everywhere and
// there is exactly one place to change the wording.
//
// Four deliberate rules live here:
//  1. Network identity comes from the app's OWN chain config (ChainBadge +
//     chainCfg) and nothing else. No second naming table, so this notice can
//     never disagree with the rest of the site about what a network is called.
//  2. Only a network this build can actually name gets named and badged.
//     chainCfg throws on an unknown chain and ChainBadge silently paints one in
//     BASE's colours, so an unrecognised wallet network stays an honest
//     "another network" with no badge rather than a confident wrong label.
//  3. It never switches the wallet on its own. The wallet is the user's; the
//     switch is OFFERED (the button IS the offer), never taken.
//  4. A DECLINED switch is not a failure state and not a success one. The
//     mutation settles on the wallet's answer, so the button comes back out of
//     its pending label by itself (no spinner left running), the notice stays up
//     because the mismatch is still true, and the decline is acknowledged in
//     words instead of being swallowed or dressed up as done.
//
// It is also NOT rendered where no signature is possible (a preview-only build,
// no router/factory configured): a network warning there is a false alarm. Each
// host keeps that gate, because each host knows its own flag — see `enabled`.

/** A chain this build configures, or null when it cannot be named honestly. */
function namedChain(chainId: number | undefined): number | null {
  return chainId != null && SUPPORTED_CHAIN_IDS.includes(chainId) ? chainId : null
}

/** The live switch offer for one surface. */
export interface NetworkSwitch {
  /** A wallet is connected, on a network that is not the one the action needs. */
  mismatch: boolean
  /** The switch is out for the wallet's answer (the pending label's trigger). */
  switching: boolean
  /** It came back without landing: declined in the wallet, or refused by it. */
  declined: boolean
  /** Offer, never take — call this from a click and nothing else. */
  switchNow: () => void
  /** The wallet's network as a chain this build can NAME, else null (no badge). */
  walletBadgeId: number | null
  /** Plain words for where the wallet is, safe when the chain is unrecognised. */
  walletWords: string
}

/** The switch state, for a surface whose OWN control performs the switch (a CTA
 *  state machine that hijacks its one button while the network is wrong). Call
 *  it once per surface and hand the result to <WrongNetworkNotice/>: one
 *  mutation per surface is what lets the notice speak for a declined switch. A
 *  surface with no such control uses <WrongNetwork/>, which owns this itself. */
export function useNetworkSwitch(requiredChainId: number): NetworkSwitch {
  const { isConnected, chainId: walletChainId } = useAccount()
  const { switchChain, isPending, error, reset } = useSwitchChain()
  const walletBadgeId = namedChain(walletChainId)

  // If the wallet moves on its own (the user changing networks in the wallet
  // instead of here), the last decline's wording no longer describes where they
  // are, so drop it and let the notice speak for the new state.
  useEffect(() => {
    reset()
  }, [walletChainId, reset])

  return {
    mismatch: isConnected && walletChainId !== requiredChainId,
    switching: isPending,
    // Held back while a fresh attempt is in flight, so a stale line never sits
    // under a pending button.
    declined: !!error && !isPending,
    switchNow: () => switchChain({ chainId: requiredChainId }),
    walletBadgeId,
    walletWords: walletBadgeId != null ? chainCfg(walletBadgeId).name : 'another network',
  }
}

export interface WrongNetworkProps {
  /** The chain THIS action needs. Sourced per surface (a basket's chain, a
   *  bridge's source chain, a league's chain, the deploy's chain) — the notice
   *  never assumes the active chain. */
  requiredChainId: number
  /** Plain-words clause naming what needs the network. It lands as
   *  "{action} on {network}", e.g. "This basket buys and sells". */
  action: string
  /** false = no signature is possible here (preview-only build, nothing
   *  configured), so the warning would be a false alarm: render nothing. */
  enabled?: boolean
  /** One-line treatment for a layout that cannot host the full notice (the
   *  quick-buy strip, the crown card's footer row). Same facts, no button. */
  compact?: boolean
  /** Render the switch offer with the host's own button chrome. Omit when the
   *  host's existing control already performs the switch. */
  button?: { className: string; style?: CSSProperties }
  /** Host spacing (mt-*), kept at the host like every other notice here. */
  className?: string
}

/** The notice, driven by a switch the HOST owns (see useNetworkSwitch). */
export function WrongNetworkNotice({
  requiredChainId,
  action,
  sw,
  enabled = true,
  compact = false,
  button,
  className = '',
}: WrongNetworkProps & { sw: NetworkSwitch }) {
  const requiredBadgeId = namedChain(requiredChainId)
  // Nothing to say when there is no mismatch, no signature possible, or no
  // honest name for the destination (rule 2 — an unconfigured required chain
  // cannot be named OR switched to, so a notice about it would be noise).
  if (!enabled || !sw.mismatch || requiredBadgeId == null) return null
  const requiredWords = chainCfg(requiredBadgeId).name
  const shell = `rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-amber-200/90 ${className}`
  const declinedWords = `Your wallet stayed on ${sw.walletWords}, so nothing was sent. Try the switch again when you are ready, or change the network in your wallet.`

  if (compact) {
    return (
      <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${shell}`}>
        {sw.walletBadgeId != null && (
          <>
            <ChainBadge chainId={sw.walletBadgeId} />
            <span aria-hidden="true">→</span>
          </>
        )}
        <ChainBadge chainId={requiredBadgeId} />
        <span className="min-w-0">
          Your wallet is on {sw.walletWords}. {action} on {requiredWords}. Switching networks signs
          nothing.
          {sw.declined && <> {declinedWords}</>}
        </span>
      </div>
    )
  }

  return (
    <>
      {/* ONE line (owner 0903: "I don't want three lines") — badges and words
          share the row; the switch leads, the signs-nothing honesty stays. */}
      <div className={shell}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {sw.walletBadgeId != null && (
            <>
              <ChainBadge chainId={sw.walletBadgeId} />
              <span aria-hidden="true">→</span>
            </>
          )}
          <ChainBadge chainId={requiredBadgeId} />
          <span className="min-w-0">
            Switch to {requiredWords} first — your wallet is on {sw.walletWords}. Switching signs
            nothing.
          </span>
        </div>
      </div>
      {button && (
        <button
          type="button"
          onClick={sw.switchNow}
          disabled={sw.switching}
          className={`${button.className} press disabled:cursor-not-allowed disabled:opacity-60`}
          style={button.style}
        >
          {sw.switching ? 'Confirm in wallet…' : `Switch wallet to ${requiredWords}`}
        </button>
      )}
      {sw.declined && (
        <div className="mt-2 text-center font-mono text-[10px] leading-relaxed text-amber-300/90">
          {declinedWords}
        </div>
      )}
    </>
  )
}

/** The notice AND the switch offer, for a surface with no control of its own to
 *  hijack. Owns one switch mutation; pass `button` to render the offer. */
export function WrongNetwork(props: WrongNetworkProps) {
  const sw = useNetworkSwitch(props.requiredChainId)
  return <WrongNetworkNotice {...props} sw={sw} />
}
