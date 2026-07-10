import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import type { Address, Hex } from 'viem'
import { chainCfg } from '../chain/chains'
import { TRADING_ENABLED } from '../config/features'
import { basketAbi } from './abis-v2'

// ─────────────────────────────────────────────────────────────────────────────
// Write surfaces for the /flush creator console, bound to the
// same wagmi pattern as useDeployBasket: simulate (a doomed call fails before the
// wallet prompt, surfacing the contract's revert reason) → sign → wait for the
// receipt. Each action tracks its OWN lifecycle, keyed so several flush buttons
// can be in flight independently.
//
// Like every transactional surface, this is hard-gated on TRADING_ENABLED — the
// broadcast refuses regardless of any UI state (the last line of defense). The
// holder claim is a pull (no bounty); flushPrismBurn / flushFrontendFees are
// permissionless cranks that pay the caller CRANK_BOUNTY_BPS.
// ─────────────────────────────────────────────────────────────────────────────

export type TxStatus = 'idle' | 'signing' | 'confirming' | 'success' | 'error'

export interface TxState {
  status: TxStatus
  hash: Hex | null
  error: string | null
}

const INITIAL: TxState = { status: 'idle', hash: null, error: null }

/** Stable keys for the per-action state map. `frontend:<addr>` is per-recipient. */
export const CLAIM_KEY = 'claim'
export const BURN_KEY = 'burn'
export const REDEEM_KEY = 'redeem'
export const frontendKey = (fe: string) => `frontend:${fe.toLowerCase()}`

export function useFeeActions(basket: Address | undefined, chainId: number, onSuccess?: (key: string) => void) {
  const cfg = chainCfg(chainId) // throws on unsupported chains
  const { address, isConnected, chainId: walletChainId } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()

  const [states, setStates] = useState<Record<string, TxState>>({})
  const patch = useCallback(
    (key: string, p: Partial<TxState>) =>
      setStates((s) => ({ ...s, [key]: { ...(s[key] ?? INITIAL), ...p } })),
    [],
  )
  const stateOf = useCallback((key: string): TxState => states[key] ?? INITIAL, [states])
  const reset = useCallback((key: string) => patch(key, INITIAL), [patch])

  // A wallet on the right chain is needed to broadcast; everything is also
  // hard-gated on TRADING_ENABLED below, regardless of wallet state.
  const walletReady = isConnected && walletChainId === chainId
  const enabled = TRADING_ENABLED && walletReady && !!basket

  // Shared lifecycle. `send` does the (typed) simulate + write and returns the
  // tx hash; runTx owns the gating, the state machine, and the receipt wait.
  const runTx = useCallback(
    async (key: string, send: () => Promise<Hex>) => {
      if (!TRADING_ENABLED) {
        return patch(key, { status: 'error', error: 'Fee actions are disabled on this build (set VITE_ENABLE_TRADING).' })
      }
      if (!basket) return patch(key, { status: 'error', error: 'No basket selected.' })
      if (!walletReady) return patch(key, { status: 'error', error: `Connect a wallet on ${cfg.name} to continue.` })
      try {
        patch(key, { status: 'signing', error: null, hash: null })
        const hash = await send()
        patch(key, { status: 'confirming', hash })
        await (publicClient ?? throwNoClient()).waitForTransactionReceipt({ hash })
        patch(key, { status: 'success' })
        onSuccess?.(key)
      } catch (e) {
        patch(key, { status: 'error', error: messageOf(e) })
      }
    },
    [basket, cfg.name, onSuccess, patch, publicClient, walletReady],
  )

  /** Holder pull-claim of accrued USDC (claimFees, §5.4 — no bounty). */
  const claim = useCallback(
    () =>
      runTx(CLAIM_KEY, async () => {
        const target = basket as Address
        if (address && publicClient) {
          await publicClient.simulateContract({ account: address, address: target, abi: basketAbi, functionName: 'claimFees' })
        }
        return writeContractAsync({ address: target, abi: basketAbi, functionName: 'claimFees', chainId })
      }),
    [address, basket, chainId, publicClient, runTx, writeContractAsync],
  )

  /** Permissionless burn crank (flushPrismBurn). `minEthOut` is the caller's
   *  slippage floor on the USDC→ETH swap, in wei (0 = no protection). */
  const flushBurn = useCallback(
    (minEthOut: bigint) =>
      runTx(BURN_KEY, async () => {
        const target = basket as Address
        if (address && publicClient) {
          await publicClient.simulateContract({ account: address, address: target, abi: basketAbi, functionName: 'flushPrismBurn', args: [minEthOut] })
        }
        return writeContractAsync({ address: target, abi: basketAbi, functionName: 'flushPrismBurn', args: [minEthOut], chainId })
      }),
    [address, basket, chainId, publicClient, runTx, writeContractAsync],
  )

  /** Permissionless frontend/launcher/creator crank (flushFrontendFees(fe)). */
  const flushFrontend = useCallback(
    (fe: Address) =>
      runTx(frontendKey(fe), async () => {
        const target = basket as Address
        if (address && publicClient) {
          await publicClient.simulateContract({ account: address, address: target, abi: basketAbi, functionName: 'flushFrontendFees', args: [fe] })
        }
        return writeContractAsync({ address: target, abi: basketAbi, functionName: 'flushFrontendFees', args: [fe], chainId })
      }),
    [address, basket, chainId, publicClient, runTx, writeContractAsync],
  )

  /** Permissionless maintenance crank (redeemClaims) — settles the lazy-burn queue. No bounty. */
  const redeemClaims = useCallback(
    () =>
      runTx(REDEEM_KEY, async () => {
        const target = basket as Address
        if (address && publicClient) {
          await publicClient.simulateContract({ account: address, address: target, abi: basketAbi, functionName: 'redeemClaims' })
        }
        return writeContractAsync({ address: target, abi: basketAbi, functionName: 'redeemClaims', chainId })
      }),
    [address, basket, chainId, publicClient, runTx, writeContractAsync],
  )

  return { enabled, walletReady, stateOf, reset, claim, flushBurn, flushFrontend, redeemClaims }
}

// ── claim-all (owner 2026-07-07): one button on the Portfolio that sweeps every
// claimable row instead of clicking each. Each basket is its own contract, so
// there's no single-tx aggregate — this SEQUENCES the SAME calls the per-row
// actions use (claimFees / flushFrontendFees), simulate→write→wait per item,
// continue-on-error so one bad basket doesn't block the rest. Scoped to the
// wallet's CURRENT chain (a claim only broadcasts there); cross-chain items are
// reported as skipped so the user can switch and re-run. Hard-gated on TRADING.
//
// ⚠️ MONEY-PATH, UNTESTED ON-CHAIN as a batch — the individual claimFees /
// flushFrontendFees calls are the tested ones; the first real multi-claim
// validates the sequencing. Guarded: simulate before every prompt.
export interface ClaimAllItem {
  address: Address
  chainId: number
  kind: 'claim' | 'flush'
}
export interface ClaimAllState {
  running: boolean
  total: number
  done: number
  failed: number
  skippedOtherChain: number
  error: string | null
}
const CLAIM_ALL_INITIAL: ClaimAllState = { running: false, total: 0, done: 0, failed: 0, skippedOtherChain: 0, error: null }

export function useClaimAll() {
  const { address, isConnected, chainId: walletChainId } = useAccount()
  const publicClient = usePublicClient({ chainId: walletChainId })
  const { writeContractAsync } = useWriteContract()
  const qc = useQueryClient()
  const [state, setState] = useState<ClaimAllState>(CLAIM_ALL_INITIAL)
  // Re-entrancy guard: a second invocation while a sweep is in flight (e.g. a
  // double-click on a caller that forgot to disable its button) would run an
  // overlapping sequence of wallet prompts. Ref, not state, so the check is
  // synchronous and immune to the render/setState lag.
  const runningRef = useRef(false)

  const claimAll = useCallback(
    async (items: ClaimAllItem[]) => {
      if (runningRef.current) return
      if (!TRADING_ENABLED) return setState({ ...CLAIM_ALL_INITIAL, error: 'Fee actions are disabled on this build.' })
      if (!isConnected || !address) return setState({ ...CLAIM_ALL_INITIAL, error: 'Connect a wallet to claim.' })
      const onChain = items.filter((i) => i.chainId === walletChainId)
      const skipped = items.length - onChain.length
      if (onChain.length === 0) {
        return setState({ ...CLAIM_ALL_INITIAL, skippedOtherChain: skipped, error: skipped > 0 ? 'Switch network to claim these.' : 'Nothing to claim.' })
      }
      runningRef.current = true
      setState({ running: true, total: onChain.length, done: 0, failed: 0, skippedOtherChain: skipped, error: null })
      let done = 0
      let failed = 0
      try {
        for (const it of onChain) {
          try {
            const call =
              it.kind === 'claim'
                ? ({ address: it.address, abi: basketAbi, functionName: 'claimFees' as const, chainId: it.chainId })
                : ({ address: it.address, abi: basketAbi, functionName: 'flushFrontendFees' as const, args: [address] as const, chainId: it.chainId })
            // Doomed calls fail here, before the wallet prompt, surfacing the revert.
            if (publicClient) await publicClient.simulateContract({ account: address, ...call })
            const hash = await writeContractAsync(call)
            await (publicClient ?? throwNoClient()).waitForTransactionReceipt({ hash })
            done += 1
          } catch {
            failed += 1
          }
          setState((s) => ({ ...s, done, failed }))
          // refresh both the /flush + portfolio fee state AND the referral read (a
          // different query key) so claimed balances drop right away.
          void qc.invalidateQueries({ queryKey: ['spectrum', 'feeState', it.chainId, it.address.toLowerCase()] })
          void qc.invalidateQueries({ queryKey: ['spectrum', 'pendingFrontend', it.chainId, it.address.toLowerCase()] })
        }
      } finally {
        runningRef.current = false
      }
      setState((s) => ({ ...s, running: false, error: failed > 0 ? `${failed} claim(s) failed or were rejected.` : null }))
    },
    [address, isConnected, walletChainId, publicClient, writeContractAsync, qc],
  )

  const resetClaimAll = useCallback(() => setState(CLAIM_ALL_INITIAL), [])
  return { claimAll, resetClaimAll, walletChainId, ...state }
}

function throwNoClient(): never {
  throw new Error('No RPC client for the active chain.')
}

function messageOf(e: unknown): string {
  if (e && typeof e === 'object' && 'shortMessage' in e && typeof e.shortMessage === 'string') {
    return e.shortMessage
  }
  return e instanceof Error ? e.message : String(e)
}
