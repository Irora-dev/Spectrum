import { useCallback, useRef, useState } from 'react'
import { useAccount, useConfig } from 'wagmi'
import { getAccount, getPublicClient, sendTransaction, switchChain } from 'wagmi/actions'
import type { Address, Hex } from 'viem'
import { SIMULATED } from './allocation'
import type { ComposedBatchBuy } from './batcher'
import type { Eip1193Like } from './batch-calls'
import type { ShownStepReview } from './displayed-vs-signed'
import { deploymentFor, settlementDecimalsFor } from '../chain/deployments'
import { appendExec, type ExecLogEntry } from './exec-log'
import { initialRunState, runFundingPlan, type RunState } from './execution-runner'
import type { FundingPlan, FundingStep } from './funding-plan'
import { createRunnerEffects, planExecutable } from './runner-effects'
import { burnAssetFor, emptyPlanGate } from './portfolio-run-wiring'
import type { ComposedPortfolioBatchBuy } from './portfolio-batcher'

// ─────────────────────────────────────────────────────────────────────────────
// THE RUNNER'S WAGMI WIRING (2026-08-04) — the thin React shell around
// runner-effects.ts. Everything lawful lives below this file: the runner owns
// sequencing (13 laws), the effects factory owns the wallet boundary (P-laws);
// this hook only ACQUIRES — the account, the provider, the clients — and maps
// the exec-log entry. It is deliberately too small to hide a bug in.
//
// While SIMULATED is true the runner refuses at the door (law 7), so mounting
// this hook is safe on every build — the wallet is never contacted.
// ─────────────────────────────────────────────────────────────────────────────

export interface RunnerLogShape {
  kind: ExecLogEntry['kind']
  /** NET NEW MONEY this run brings in when it COMPLETES (exec-log's one
   *  semantic). Null when unknown. */
  totalUsd: number | null
  /** Exact recorded ends for the legs the run moves — the exec-log's changes.
   *  A GETTER is accepted because the shape is captured when the hook mounts,
   *  BEFORE the review exists (owner 2026-08-16: batcher runs were invisible
   *  in recent-transactions — every runner row shipped without changes); the
   *  getter reads the live review at write time instead. */
  changes?: ExecLogEntry['changes'] | (() => ExecLogEntry['changes'])
}

export interface UseExecutionRunnerArgs {
  /** The flow's plan context: one funding step → the exact composed batch
   *  (assemble-batch.ts). Throws review-grade refusals. */
  composeStep: (step: FundingStep) => Promise<ComposedBatchBuy>
  /** THE PORTFOLIO ENGINE's composer (the executor migration, 2026-08-13):
   *  one funding step → the SpectrumPortfolioBatcher composition through the
   *  0x path (assembleZeroExBatchBuyLive → composed). Supplying it does NOT
   *  select the engine — `engine` below does, explicitly; a composer with no
   *  engine flag is inert, and an engine flag with no composer refuses in the
   *  effects layer's own sentence. */
  composePortfolioStep?: (step: FundingStep) => Promise<ComposedPortfolioBatchBuy>
  /** Which contract this run speaks. Absent = 'legacy' (byte-identical to the
   *  pre-migration behavior). The CALLER wires this from
   *  ZEROEX_COMPOSE_ENABLED — the interlock's own flag — so the engine choice
   *  is the flip commit's to make, never this hook's. */
  engine?: 'legacy' | 'portfolio'
  /** What the review RENDERED for each step (law P8) — built from the same
   *  values the station's rows read, frozen at confirm. The effects layer
   *  decodes the prepared bytes back and refuses on the first divergence;
   *  null refuses too (the gate is not skippable by omission). */
  shownFor: (step: FundingStep) => ShownStepReview | null
  /** Exact-amount approvals a step needs (ERC-20 funding). Omit for native. */
  approvalsFor?: (step: FundingStep) => { token: Address; amountRaw: bigint }[]
  /** USD per whole native token — feeds the measured gasCostUsd the route
   *  comparator consumes. Null/omitted = unreadable, never zero. */
  nativeUsd?: (chainId: number) => number | null
  logShape: RunnerLogShape
}

/** The runner's exec-log mapping, PURE AND PINNED (a law is not allowed to
 *  hide in a hook closure): a partial row may not claim money that did not
 *  finish moving — `totalUsd` goes null on any partial entry unless exact
 *  per-leg `changes` back the figure (the exec-log's audit-round-3 law,
 *  enforced at write time, not just at read-back). `failedLegIndex` passes
 *  through on `!= null` deliberately: leg 0 is a real leg, and a truthiness
 *  guard would silently drop the first leg's failure. */
export function execEntryFor(
  logShape: RunnerLogShape,
  entry: { partial: boolean; stoppedAt?: string; failedLegIndex?: number; completedSteps: string[] },
  ts: number,
): ExecLogEntry {
  const changes = typeof logShape.changes === 'function' ? logShape.changes() : logShape.changes
  return {
    ts,
    kind: logShape.kind,
    totalUsd: entry.partial && !changes?.length ? null : logShape.totalUsd,
    ...(changes?.length ? { changes } : {}),
    simulated: SIMULATED,
    ...(entry.partial ? { partial: true as const } : {}),
    ...(entry.stoppedAt ? { stoppedAt: entry.stoppedAt } : {}),
    ...(entry.failedLegIndex != null ? { failedLegIndex: entry.failedLegIndex } : {}),
  }
}

export function useExecutionRunner(args: UseExecutionRunnerArgs) {
  const config = useConfig()
  // ⚠ p3-groupguard (RUNNER LAW 1) — THE ACTIVE ACCOUNT, NEVER THE GROUP.
  // `useAccount().address` is the wallet's single active address. The wallet
  // GROUP (use-wallet-group.ts) merges addresses for DISPLAY ONLY and must
  // never reach this hook: an intent against holdings the active wallet
  // cannot move would stop being unrepresentable. Reviewed line.
  const { address, connector } = useAccount()

  const [state, setState] = useState<RunState | null>(null)
  const stopRef = useRef(false)

  /** The up-front capability gate — the panel disables its run button on a
   *  refusal here, BEFORE any step runs (a known incapacity refuses whole). */
  const gate = useCallback(
    (plan: FundingPlan) => {
      // The zero-step door first: planExecutable passes vacuously on an empty
      // plan, and an empty plan wearing a live Run button was the 2026-08-14
      // silent refusal. The panel renders this reason INSTEAD of the button.
      const empty = emptyPlanGate(plan)
      if (!empty.ok) return empty
      return planExecutable(plan.steps, {
        client: (chainId) => getPublicClient(config, { chainId: chainId as never }) ?? null,
        batcherAddress: (chainId) => batcherFor(chainId),
        settlementAddress: settlementFor,
      })
    },
    [config],
  )

  const stop = useCallback(() => {
    stopRef.current = true
  }, [])

  /** Clear a TERMINAL state so a rebuilt review may run — the retry doors'
   *  half of the auto-run law (one start per built review). Never call this
   *  on a running run: stop is the running run's exit. */
  const clear = useCallback(() => {
    stopRef.current = false
    setState(null)
  }, [])

  const run = useCallback(
    async (plan: FundingPlan): Promise<RunState> => {
      const refuse = (message: string): RunState => {
        const s = initialRunState(plan)
        s.phase = 'refused'
        s.notes.push(message)
        setState(s)
        return s
      }
      if (!address || !connector) return refuse('Connect a wallet to run this plan. Nothing was sent.')
      const upfront = gate(plan)
      if (!upfront.ok) return refuse(upfront.reason)

      let provider: Eip1193Like
      try {
        provider = (await connector.getProvider()) as Eip1193Like
      } catch {
        return refuse('The wallet did not hand us a connection, so nothing could be sent. Reconnect and try again.')
      }

      stopRef.current = false
      const account = address
      const effects = createRunnerEffects({
        account,
        // The LIVE single-account read (law 1's per-step re-check): wagmi's
        // current active account, read fresh at each step boundary.
        activeAccount: () => getAccount(config).address ?? null,
        wallet: {
          provider,
          sendTransaction: async (chainId, tx) => {
            // THE WALLET FOLLOWS THE PLAN'S CHAIN (the owner live 2026-08-15: his
            // Ethereum sale refused with "current chain 8453 does not match
            // target chain 1" — the wallet sat on Base after Base activity,
            // and viem refuses a mismatched send outright). A multi-chain
            // run must switch per step, exactly like the bundle ceremony's
            // lanes do: ask once, quietly; the wallet prompts if it must,
            // and a declined switch surfaces as the wallet's own refusal.
            if (getAccount(config).chainId !== chainId) {
              await switchChain(config, { chainId: chainId as never })
            }
            return sendTransaction(config, {
              chainId: chainId as never,
              account,
              to: tx.to,
              data: tx.data as Hex,
              value: tx.value,
            })
          },
        },
        client: (chainId) => getPublicClient(config, { chainId: chainId as never }) ?? null,
        batcherAddress: (chainId) => batcherFor(chainId),
        settlementAddress: settlementFor,
        settlementDecimals: settlementDecimalsFor,
        composeStep: args.composeStep,
        composePortfolioStep: args.composePortfolioStep,
        engine: args.engine,
        shownFor: args.shownFor,
        burnComposable: (cid) => burnAssetFor(cid) != null,
        approvalsFor: args.approvalsFor,
        nativeUsd: args.nativeUsd,
        writeExecLog: (entry) => appendExec(account, execEntryFor(args.logShape, entry, Date.now())),
        onState: setState,
        shouldStop: () => stopRef.current,
      })

      return runFundingPlan({ account, plan, effects, simulated: SIMULATED })
    },
    [address, connector, config, gate, args],
  )

  return { run, stop, clear, state, gate }
}

/** The ceremony-seated batcher for a chain — null until deployments.json
 *  carries it (json-only by S-pin; the runner refuses null chains by name). */
function batcherFor(chainId: number): Address | null {
  try {
    return deploymentFor(chainId).batcher
  } catch {
    return null
  }
}

/** The chain's settlement token — what bridge steps move. Same fail-null
 *  posture as batcherFor: an unconfigured chain refuses by name upstream. */
function settlementFor(chainId: number): Address | null {
  try {
    return deploymentFor(chainId).usdc ?? null
  } catch {
    return null
  }
}
