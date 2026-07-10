import { useCallback, useState } from 'react'
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi'
import type { Address, Hex } from 'viem'
import { chainCfg } from '../chain/chains'
import { deploymentFor } from '../chain/deployments'
import { SWAP_ENABLED } from '../config/features'
import { encodeMintHookData, encodeRedeemHookData } from './hook-data'
import { getStoredRef } from './referral'
import { friendlyRevert } from './decode-revert'
import { erc20ApproveAbi, swapRouterAbi } from './abis-v2'
import type { BasketData } from './basket-data'

// ─────────────────────────────────────────────────────────────────────────────
// The buy/sell broadcast surface — the FIRST real caller of the hook-data.ts
// encoder (until now it had zero callers; TradePanel only PREVIEWED the math).
//
// A Spectrum basket has no USDC buy/sell method; buy/sell is an external V4
// swap into the basket's own _beforeSwap hook, which carries the (minOut,
// legMins[], frontend) hookData this hook encodes. The swap goes through the
// operator's first-party swap router (DRAFT §2.6 — see swapRouterAbi); the router
// pulls tokenIn via transferFrom, so the trader approves the router first
// (exact-amount, never infinite). Both directions ride one `swapExactIn`:
//   buy  → tokenIn = USDC,   minOut/out = basket shares
//   sell → tokenIn = basket, minOut/out = USDC
//
// Same wagmi state machine as useFeeActions / useDeployBasket — simulate (a
// doomed call fails before the wallet prompt, surfacing the revert reason) →
// sign → wait for the receipt. Buy/sell is its OWN risk surface (it needs a
// separately-deployed router), so it has its own flag: it is HARD-gated on
// SWAP_ENABLED inside the send path (the last line of defense, regardless of any
// UI state) AND inert until the operator configures the router address
// (deployments.ts ships it empty). The contract reverting on empty/zero hookData
// is the backstop; this hook never invites that — the encoder throws instead.
// ─────────────────────────────────────────────────────────────────────────────

export type Side = 'buy' | 'sell'

export type TxStatus = 'idle' | 'signing' | 'confirming' | 'success' | 'error'
export interface TxState {
  status: TxStatus
  hash: Hex | null
  error: string | null
}
const INITIAL: TxState = { status: 'idle', hash: null, error: null }

export interface SwapArgs {
  side: Side
  /** tokenIn amount, raw units (USDC raw on a buy, basket shares raw on a sell). */
  amountRaw: bigint
  /** BUY only: per-leg quoted amounts (raw, asset decimals) as of the last render — the
   *  basis for the per-leg legMins (the per-leg slippage floor). The basket data is background-polled,
   *  not re-read on click; the click-time simulate reverts if a committed minimum can no
   *  longer be met. The mint encoder refuses any non-positive leg. Empty on a sell. */
  quotedLegAmounts: bigint[]
  /** On-chain basket length — the redeem (sell) encoder zero-fills legMins to this. */
  legCount: number
  /** Aggregate out floor, raw (basket shares on a buy, USDC on a sell). On a BUY it mirrors
   *  hookData.minOut as a second backstop to the per-leg minimums; on a SELL it IS the
   *  binding protection (the basket reverts SlippageExceeded below it). */
  minOutRaw: bigint
  /** Slippage tolerance, bps — drives the BUY legMins = quotedLeg × (1 − slippage). */
  slippageBps: number
}

export const APPROVE_KEY = 'approve'
export const SWAP_KEY = 'swap'

export function useBasketSwap(ix: BasketData) {
  const chainId = ix.chainId
  const cfg = chainCfg(chainId) // throws on unsupported chains
  const dep = deploymentFor(chainId)
  const { address, isConnected, chainId: walletChainId } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()

  const router = dep.swapRouter
  const usdc = dep.usdc
  const basket = ix.address as Address
  // A live build needs both the router (the spender + swap entrypoint) and USDC
  // (the buy tokenIn). Absent either, buy/sell stays inert — same posture as the
  // empty-factory shell.
  const configured = !!router && !!usdc
  const walletReady = isConnected && walletChainId === chainId
  const enabled = SWAP_ENABLED && walletReady && configured

  const [states, setStates] = useState<Record<string, TxState>>({})
  const patch = useCallback(
    (key: string, p: Partial<TxState>) =>
      setStates((s) => ({ ...s, [key]: { ...(s[key] ?? INITIAL), ...p } })),
    [],
  )
  const stateOf = useCallback((key: string): TxState => states[key] ?? INITIAL, [states])
  const reset = useCallback(() => setStates({}), [])

  // Allowances the router needs to pull tokenIn. Read only when a live trade is
  // actually possible (no fetch storm on the inert/info build). Keyed per token.
  const usdcAllowance = useReadContract({
    address: usdc ?? undefined,
    abi: erc20ApproveAbi,
    functionName: 'allowance',
    args: address && router ? [address, router] : undefined,
    chainId,
    query: { enabled: enabled && !!address && !!router && !!usdc },
  })
  const basketAllowance = useReadContract({
    address: basket,
    abi: erc20ApproveAbi,
    functionName: 'allowance',
    args: address && router ? [address, router] : undefined,
    chainId,
    query: { enabled: enabled && !!address && !!router },
  })

  const allowanceFor = useCallback(
    (side: Side): bigint | undefined =>
      side === 'buy' ? (usdcAllowance.data as bigint | undefined) : (basketAllowance.data as bigint | undefined),
    [usdcAllowance.data, basketAllowance.data],
  )

  /** True when the router's allowance for tokenIn is below the trade amount. */
  const needsApproval = useCallback(
    (side: Side, amountRaw: bigint): boolean => {
      const a = allowanceFor(side)
      // Until the read resolves, assume an approval is needed (fail safe — never
      // route a swap that would revert on transferFrom).
      if (a == null) return true
      return a < amountRaw
    },
    [allowanceFor],
  )

  // Shared lifecycle: gate → simulate+sign (`send`) → confirm → refetch.
  const runTx = useCallback(
    async (key: string, send: () => Promise<Hex>, after?: () => void) => {
      if (!SWAP_ENABLED) {
        return patch(key, { status: 'error', error: 'Buy/sell is disabled on this build (set VITE_ENABLE_SWAP).' })
      }
      if (!configured) {
        return patch(key, { status: 'error', error: 'No swap router configured for this build.' })
      }
      if (!walletReady) {
        return patch(key, { status: 'error', error: `Connect a wallet on ${cfg.name} to continue.` })
      }
      try {
        patch(key, { status: 'signing', error: null, hash: null })
        const hash = await send()
        patch(key, { status: 'confirming', hash })
        await (publicClient ?? throwNoClient()).waitForTransactionReceipt({ hash })
        patch(key, { status: 'success' })
        after?.()
      } catch (e) {
        patch(key, { status: 'error', error: messageOf(e) })
      }
    },
    [cfg.name, configured, patch, publicClient, walletReady],
  )

  /** Exact-amount approve of tokenIn to the router (no infinite approve). */
  const approve = useCallback(
    (side: Side, amountRaw: bigint) =>
      runTx(
        APPROVE_KEY,
        async () => {
          const token = (side === 'buy' ? usdc : basket) as Address
          const spender = router as Address
          if (address && publicClient) {
            await publicClient.simulateContract({
              account: address,
              address: token,
              abi: erc20ApproveAbi,
              functionName: 'approve',
              args: [spender, amountRaw],
            })
          }
          return writeContractAsync({ address: token, abi: erc20ApproveAbi, functionName: 'approve', args: [spender, amountRaw], chainId })
        },
        // Refresh the relevant allowance so the UI flips approve → swap.
        () => void (side === 'buy' ? usdcAllowance.refetch() : basketAllowance.refetch()),
      ),
    [address, basket, chainId, publicClient, router, runTx, usdc, usdcAllowance, basketAllowance, writeContractAsync],
  )

  /** Broadcast the buy/sell. Encodes hookData from the caller's per-leg quotes
   *  (captured at the last render; throws on an empty/zero leg — there is no
   *  unprotected path) and routes the exact-input swap through the router, carrying
   *  that hookData verbatim. The pre-broadcast simulate reverts if a committed
   *  minimum can no longer be met, so a stale quote fails closed. */
  const swap = useCallback(
    (args: SwapArgs) =>
      runTx(SWAP_KEY, async () => {
        const to = address as Address
        const spender = router as Address
        const tokenIn = (args.side === 'buy' ? usdc : basket) as Address
        // BUY (mint-via-swap): per-leg legMins are the per-leg slippage floor — the mint encoder derives
        // them from the live quotes + slippage and refuses any empty/zero leg. SELL
        // (redeem-via-swap): the binding protection is the aggregate USDC minOut; the redeem
        // encoder ships length-correct zero per-leg floors (hook-data.ts explains why).
        // referral (owner 2026-07-07): a stored ?ref tags the interface slice to
        // the referrer; null → the operator's default tag.
        const interfaceTag = getStoredRef(address)
        const { hookData } =
          args.side === 'buy'
            ? encodeMintHookData({
                quotedLegAmounts: args.quotedLegAmounts,
                slippageBps: args.slippageBps,
                minOut: args.minOutRaw,
                interfaceTag,
              })
            : encodeRedeemHookData({ legCount: args.legCount, minOut: args.minOutRaw, interfaceTag })
        const callArgs = [basket, tokenIn, args.amountRaw, args.minOutRaw, hookData, to] as const
        if (address && publicClient) {
          await publicClient.simulateContract({ account: address, address: spender, abi: swapRouterAbi, functionName: 'swapExactIn', args: callArgs })
        }
        return writeContractAsync({ address: spender, abi: swapRouterAbi, functionName: 'swapExactIn', args: callArgs, chainId })
      }),
    [address, basket, chainId, publicClient, router, runTx, usdc, writeContractAsync],
  )

  return {
    /** Live build: trading flag on, wallet on the right chain, router+USDC set. */
    enabled,
    /** Router + USDC are configured for this chain (independent of wallet/flag). */
    configured,
    walletReady,
    approveState: stateOf(APPROVE_KEY),
    swapState: stateOf(SWAP_KEY),
    needsApproval,
    approve,
    swap,
    reset,
  }
}

function throwNoClient(): never {
  throw new Error('No RPC client for the active chain.')
}

function messageOf(e: unknown): string {
  const raw =
    e && typeof e === 'object' && 'shortMessage' in e && typeof e.shortMessage === 'string'
      ? e.shortMessage
      : e instanceof Error
        ? e.message
        : String(e)
  // Unwrap PoolManager-wrapped hook reverts + name the protocol's custom errors
  // ("signature 0x90bfb865" → "InsufficientFirstDeposit — first buy ≥ 10 USDC").
  return friendlyRevert(e, raw)
}
