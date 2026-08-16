import type { DeployStatus } from '../../lib/spectrum/use-deploy'
import { friendlyRevert } from '../../lib/spectrum/decode-revert'

// ─────────────────────────────────────────────────────────────────────────────
// THE SINGLE-BASKET DEPLOY'S TWO MISSING SIGNALS, as pure functions.
//
// Both were greenlit by the owner on 2026-08-13 alongside the launch-journey
// ruling, and both are about the same moment: the seconds between "I have
// finished building this" and "I have paid for it".
//
//  (C) THE VERDICT. use-deploy already simulates before it ever lets a wallet
//      sign — reaching `ready` REQUIRES a successful publicClient
//      .simulateContract of the actual deploy call. The flow just never said
//      so. `ready` is therefore not a guess dressed as reassurance; it is a
//      report of a simulation that already ran, which is the only reason this
//      copy is allowed to be as confident as it is. Everything short of it says
//      what is actually happening instead, and a refusal quotes the chain's own
//      reason through friendlyRevert rather than inventing a cause.
//
//  (B) THE AUTO-SWITCH ARGUMENTS. The two sequential ceremonies got auto-switch
//      today ("can we auto switch them to the next chain, save them a click to
//      switch to eth/base etc"). The law lives in reshape/auto-switch.ts and
//      the call in reshape/use-auto-switch.ts, and NEITHER is re-implemented
//      here: this only translates a single-basket deploy's status into the lane
//      vocabulary those two already speak, so the four laws (once per lane ·
//      never while a signature is out · the observation remains the truth · a
//      walkthrough never asks) hold for the single deploy by construction
//      rather than by a second copy of them agreeing.
// ─────────────────────────────────────────────────────────────────────────────

// ── (C) the verdict ──────────────────────────────────────────────────────────

export type VerdictTone = 'none' | 'working' | 'simulated' | 'refused'

export interface DeployVerdict {
  tone: VerdictTone
  /** The line itself. Empty for `none` — the surface renders nothing. */
  line: string
}

/**
 * What to say about this deploy BEFORE any gas is spent.
 *
 * The one claim that matters — "simulated" — is made at exactly one status, and
 * only because reaching that status is what a successful simulation MEANS here.
 */
export function deployVerdict(input: {
  status: DeployStatus
  /** The flow's own error text, when it has one. */
  error?: string | null
  /** The raw thrown value, when the caller still holds it — friendlyRevert
   *  turns a custom-error selector into a sentence. Optional; the flow's own
   *  `error` string is the fallback. */
  cause?: unknown
}): DeployVerdict {
  switch (input.status) {
    case 'mining':
      return { tone: 'working', line: 'Finding your basket’s address…' }
    case 'preparing':
      return { tone: 'working', line: 'Simulating the deploy against the chain…' }
    case 'ready':
      // The simulation ALREADY RAN to get here. This is a report, not a promise.
      return { tone: 'simulated', line: 'Simulated — this will deploy. Nothing has been spent yet.' }
    case 'error': {
      const reason = input.cause != null ? friendlyRevert(input.cause, input.error || '') : input.error || ''
      return {
        tone: 'refused',
        // Never a cause we did not read: with no reason to give, say that.
        line: reason ? `Won’t deploy: ${reason}` : 'Won’t deploy — the chain refused, without saying why.',
      }
    }
    // Past the point this signal is about: the wallet has it now.
    default:
      return { tone: 'none', line: '' }
  }
}

// ── (B) the auto-switch arguments ────────────────────────────────────────────

/** The lane vocabulary reshape/auto-switch.ts decides on, as a single deploy
 *  produces it. Nothing here decides anything — autoSwitchVerdict does. */
export interface LaneShape {
  shipping: boolean
  laneChainId: number | null
  laneState: string | null
  signing: boolean
}

/**
 * A single-basket deploy, in lane terms.
 *
 * `ready` is the ONE status that maps to the switch step, and it is the correct
 * one: prepare/simulate run against the target chain's public client and need
 * no wallet, while `deploy()` refuses outright unless the wallet is on that
 * chain. So the wrong-network moment is precisely the gap between a finished
 * simulation and a signature — which is where a click was being spent.
 *
 * Everything from `signing` onward reports `signing: true`, because law (b)
 * must cover the whole window in which a wallet is busy with this flow, not
 * just the instant the prompt appears.
 */
export function deployLaneShape(status: DeployStatus, targetChainId: number | null): LaneShape {
  const busy = status === 'signing' || status === 'confirming' || status === 'seeding'
  return {
    shipping: status === 'ready',
    laneChainId: targetChainId,
    laneState: status === 'ready' ? 'switch' : status,
    signing: busy,
  }
}
