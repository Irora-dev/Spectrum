import type { Address } from 'viem'
import { zeroAddress } from 'viem'
import { deploymentFor } from '../chain/deployments'
import { SIMULATED, type AllocationDraft } from './allocation'
import { isDevPreview } from './dev-preview'
import { ZEROEX_COMPOSE_ENABLED } from './portfolio-batcher'
import { showSymbol } from './safe-copy'
import { isDemoLegAddress } from './thesis-run-types'

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION ARMING — the one honest answer to "may THIS run be REAL?"
// (the owner 2026-08-12: "…is all working and doesnt use the demo, i need to be
// able to execute.")
//
// The execute station used to walk a SIMULATED timer for everyone. That walk
// is now the DEMO IDENTITY's walkthrough only; a real wallet gets this gate's
// verdict instead — armed, or a named refusal — so nothing ever pretends to
// buy. The verdict DERIVES from the real gates rather than restating them
// (the anti-drift law): the dark flag (`ZEROEX_COMPOSE_ENABLED`), the engine
// pin (`SIMULATED`), the per-chain batcher seating in deployments.json, and
// the demo-provenance checks. There is no second constant here to go stale.
//
// REFUSAL ORDER (refusal-first, most-specific first):
//   1. no wallet — nothing can sign;
//   2. the demo identity itself — a simulation must not reach a verdict that
//      could be mistaken for "armed";
//   3. a draft SEEDED from the demo book (desk-204, provenance half): the
//      draft carries `seedBookOwner` from the seeding seam, and a demo-seeded
//      plan refuses REAL execution even under an honest signer — a simulation
//      leaking toward a signature across a wallet connect;
//   4. demo/synthetic ASSETS in the plan (`isDemoLegAddress`) — they do not
//      exist on any chain, so no honest route can ever fill them;
//   5. the global arming flags — the compose path dark, the engine simulated
//      (checked BEFORE per-chain seating so the today-answer is deterministic
//      on every checkout, seated or not);
//   6. per-chain batcher seating — a network with no seated batcher is named.
//
// Armed today is UNREACHABLE by construction (both flags are pinned by the
// go-live interlock until its ruled preconditions land) — the branch exists so
// flip-day changes ONE fact, not this module.
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionArming =
  | { armed: true; chains: number[] }
  | { armed: false; reason: string; detail?: string[] }

/** The ceremony-seated batcher for a chain — null until deployments.json
 *  carries one (same reading as the runner hook's; a throw is "not seated",
 *  never a crash). */
export function batcherFor(chainId: number): Address | null {
  try {
    const b = deploymentFor(chainId).batcher
    return b && b !== zeroAddress ? b : null
  } catch {
    return null
  }
}

/** Injectable seams so the gate is testable on every checkout regardless of
 *  what the working-tree deployments.json seats, and so flip-day behaviour is
 *  provable before the flip exists. Production callers pass nothing. */
export interface ArmingSeams {
  batcherFor?: (chainId: number) => Address | null
  composeEnabled?: boolean
  simulated?: boolean
}

/** Is the simulated walkthrough allowed for this account? The DEMO identity
 *  only — the walk is the preview book's product; a real wallet must never
 *  see a fake execution. */
export function walkthroughAllowed(account: string | null | undefined): boolean {
  return account != null && isDevPreview(account)
}

export function realExecutionArming(
  draft: Pick<AllocationDraft, 'targets' | 'seedBookOwner'>,
  account: string | null | undefined,
  seams: ArmingSeams = {},
): ExecutionArming {
  const seated = seams.batcherFor ?? batcherFor
  const composeEnabled = seams.composeEnabled ?? ZEROEX_COMPOSE_ENABLED
  const simulated = seams.simulated ?? SIMULATED

  if (!account || !/^0x[0-9a-fA-F]{40}$/.test(account))
    return { armed: false, reason: 'Connect a wallet — real execution signs from your own wallet, and nothing runs without one.' }

  if (isDevPreview(account))
    return {
      armed: false,
      reason: 'This is the demo book — a simulation. Nothing here can be bought for real; connect your own wallet to build a portfolio.',
    }

  // desk-204, the provenance half: the seeding seam stamps the book's owner
  // on the draft, so a plan drafted from the demo holdings refuses here even
  // after a REAL wallet adopted it across a connect.
  if (draft.seedBookOwner && isDevPreview(draft.seedBookOwner))
    return {
      armed: false,
      reason:
        'This plan was drafted from the demo book’s holdings — a simulation. Rebuild it from your own wallet’s positions before executing for real.',
    }

  const demoLegs = draft.targets.filter((t) => isDemoLegAddress(t.asset.address))
  if (demoLegs.length > 0)
    return {
      armed: false,
      reason: 'This plan holds demo assets that do not exist on any network, so no honest route can fill them.',
      detail: demoLegs.map((t) => `$${showSymbol(t.asset.symbol)} is a demo asset — remove it to execute for real`),
    }

  const chains: number[] = []
  for (const t of draft.targets) if (!chains.includes(t.asset.chainId)) chains.push(t.asset.chainId)
  if (chains.length === 0) return { armed: false, reason: 'An empty plan has nothing to execute.' }

  // The global arming flags, before per-chain facts: the today-answer must be
  // the same sentence on every checkout, seated or not.
  if (!composeEnabled)
    return {
      armed: false,
      reason: 'Real execution is not switched on in this build yet, so nothing can be composed or signed — no funds were touched.',
      detail: [
        'the 0x compose path is dark (ZEROEX_COMPOSE_ENABLED, portfolio-batcher.ts) — the flip is held by the go-live interlock’s ruled preconditions (go-live-interlock.test.ts)',
      ],
    }
  if (simulated)
    return {
      armed: false,
      reason: 'The engine in this build is pinned simulated — it can rehearse a plan but cannot sign one.',
      detail: ['SIMULATED (allocation.ts) flips only with the go-live interlock’s preconditions met'],
    }

  const unseated = chains.filter((cid) => seated(cid) == null)
  if (unseated.length > 0)
    return {
      armed: false,
      reason: 'A network in this plan has no batch contract seated yet, so its buys cannot be composed.',
      detail: unseated.map((cid) => `chain ${cid} has no seated batcher in this deployment`),
    }

  return { armed: true, chains }
}
