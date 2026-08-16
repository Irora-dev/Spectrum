import type { DeployStatus } from '../../lib/spectrum/use-deploy'
import type { NetworkSwitch } from '../WrongNetwork'
import { useLaneAutoSwitch } from '../reshape/use-auto-switch'
import { deployLaneShape } from './deploy-flow-signals'

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-SWITCH FOR THE SINGLE-BASKET DEPLOY (the owner 2026-08-13, greenlit with the
// launch-journey ruling; the ruling itself is the ceremonies' — "can we auto
// switch them to the next chain, save them a click to switch to eth/base etc").
//
// THIS IS A TRANSLATION, NOT AN IMPLEMENTATION. Every one of the four laws is
// still decided in reshape/auto-switch.ts and still called from
// reshape/use-auto-switch.ts; this file's whole content is turning a deploy
// status into the lane vocabulary they already speak (deployLaneShape, pure and
// tested). A second implementation is exactly what would let the single deploy
// and the ceremonies drift on consent, which is the one thing that must not
// drift.
//
// WHAT MAKES IT SAFE IS UNCHANGED: consent does not move. The wallet still
// shows its own prompt and that prompt is still the only thing that changes a
// network — the call goes through the app's own useNetworkSwitch (wagmi
// switchChain), never a raw window.ethereum. We save OUR click, never the
// wallet's.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask the wallet — ONCE — for the chain this basket is being deployed to, at
 * the one moment it is needed: after the simulation has passed and before the
 * signature is requested.
 */
export function useDeployAutoSwitch({
  sw,
  status,
  targetChainId,
  connected,
  walletChainId,
  demo = false,
}: {
  /** The deploy surface's ONE switch mutation. */
  sw: NetworkSwitch
  status: DeployStatus
  /** The chain this deploy targets; null when it is not yet known. */
  targetChainId: number | null
  connected: boolean
  walletChainId: number | undefined
  /** A walkthrough — law (d): nothing about a demo may touch a wallet. */
  demo?: boolean
}): void {
  const lane = deployLaneShape(status, targetChainId)
  useLaneAutoSwitch({
    sw,
    demo,
    connected,
    walletChainId,
    shipping: lane.shipping,
    laneChainId: lane.laneChainId,
    laneState: lane.laneState,
    signing: lane.signing,
  })
}
