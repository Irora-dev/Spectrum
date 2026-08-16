import { useCallback, useEffect, useRef, useState } from 'react'
import { formatUnits, type Address, type Hex } from 'viem'
import { useSendTransaction, useWriteContract } from 'wagmi'
import { chainCfg } from '../chain/chains'
import { deploymentFor } from '../chain/deployments'
import { clientFor } from '../chain/rpc'
import { nativeEthUsdOnChain } from '../pools/v4-usd'
import { erc20ApproveAbi } from './abis-v2'
import { addBridge } from './bridge-pending'
import { DEFAULT_SLIPPAGE_BPS } from './hook-data'
import { fetchLifiQuote, LIFI_NATIVE } from './lifi'
import { approvalPlan } from './migrate-math'

// ─────────────────────────────────────────────────────────────────────────────
// THE BRIDGE-LEG EXECUTOR — BridgeFund's proven cross-chain money path,
// extracted so the thesis run rides the SAME code (owner, three times over:
// take the real thing, never a lookalike copy that drifts). One hook instance
// drives one transfer at a time. The laws it carries, verbatim from BridgeFund:
//   • fresh quote at send time — routes go stale in minutes;
//   • approve exactly the quote's approvalAddress for exactly the amount,
//     zero-first where the allowance demands it (approvalPlan);
//   • send the quoted transaction VERBATIM, with an explicit chainId on EVERY
//     wagmi write (the LimitTicket lesson: switchChainAsync resolves
//     optimistically on some wallets — the chainId on the WRITE is the guard);
//   • addBridge immediately after send, so arrival survives a reload;
//   • between the approval round-trip and the transfer signature, a closed
//     surface stops the flow — someone once paid for an approval and bridged
//     nothing (audit 2026-08-07).
// The wallet/chain boundary is injected (BridgeLegEffects) so the machine is
// testable in the node suite — the runner-effects precedent.
// ─────────────────────────────────────────────────────────────────────────────

export type BridgeLegPhase = 'idle' | 'quoting' | 'approving' | 'signing' | 'sent'

/** The thesis-run form: settlement → settlement. From/to tokens are each
 *  chain's settlement asset, resolved in here via deploymentFor — a run leg
 *  never names tokens. */
export interface BridgeLegParams {
  fromChainId: number
  toChainId: number
  /** Settlement-token amount to bridge, raw (6dp USDC-family). */
  amountRaw: bigint
  holder: Address
  /** Destination native wei the arriving wallet still needs as gas. > 0n rides
   *  LI.FI's fromAmountForGas, converted in here to from-token raw units
   *  (refuel.ts names that conversion as the caller's job). null/absent = no
   *  refuel leg. */
  refuelWeiNeeded?: bigint | null
}

/** BridgeFund's general form: an arbitrary source-side pay token (native
 *  included) → the destination chain's settlement asset. Carries no refuel:
 *  the refuel conversion below prices the from-token at $1, which only the
 *  settlement entry point can promise. */
export interface BridgeTokenLegParams {
  fromChainId: number
  toChainId: number
  fromToken: { address: Address; symbol: string; decimals: number }
  amountRaw: bigint
  holder: Address
}

/** The fully-resolved leg the executor runs. */
export interface BridgeLegExec extends BridgeTokenLegParams {
  toTokenAddress: Address
  /** Settlement pay only (decimals 6) — enforced in runBridgeLeg. */
  refuelWeiNeeded?: bigint | null
}

function chainName(chainId: number): string {
  try {
    return chainCfg(chainId).name
  } catch {
    return `chain ${chainId}`
  }
}

function settlementSymbol(chainId: number): string {
  try {
    return chainCfg(chainId).usdcSymbol
  } catch {
    return 'USDC'
  }
}

// ── refuel sizing at the unit seam refuel.ts:18-22 names ────────────────────
// computeRefuelGasWei answers in DEST-NATIVE WEI; LI.FI's fromAmountForGas
// takes FROM-TOKEN RAW UNITS. The bridge here pays in the settlement asset,
// which the app anchors at $1 (v4-usd.ts), so the conversion is wei → USD at
// the app's own on-chain native price → 6dp raw, rounded UP — under-refuel is
// the cannot-sign wall this mechanism exists to close.
//
// The USD clamp: an overshoot is NOT lost money — it arrives as the user's
// own native gas, spendable — but an UNBOUNDED value distorts the bridge (a
// bad price read could silently turn a slice of the transfer into gas), so
// [$2, $15] bounds the distortion in both directions. The cap CAN sit below a
// mainnet fee-spike need; a capped top-up beats a transfer that quietly
// becomes mostly gas. An unreadable price returns null — the caller REFUSES
// the leg rather than guessing (the read-failed law).
export const REFUEL_USD_MIN = 2
export const REFUEL_USD_MAX = 15

export function refuelFromTokenUnits(
  refuelWeiNeeded: bigint,
  nativeUsd: number | null | undefined,
): bigint | null {
  if (refuelWeiNeeded <= 0n) return 0n
  if (nativeUsd == null || !Number.isFinite(nativeUsd) || nativeUsd <= 0) return null
  const usd = Number(formatUnits(refuelWeiNeeded, 18)) * nativeUsd
  if (!Number.isFinite(usd)) return null
  const clamped = Math.min(REFUEL_USD_MAX, Math.max(REFUEL_USD_MIN, usd))
  return BigInt(Math.ceil(clamped * 1e6))
}

/** Resolve the thesis-run form to an executable leg: each end's settlement
 *  asset, 6dp. An unconfigured chain gets an honest refusal, never a throw. */
export function resolveSettlementLeg(
  p: BridgeLegParams,
): { ok: BridgeLegExec; error?: undefined } | { ok?: undefined; error: string } {
  const fromUsdc = deploymentFor(p.fromChainId).usdc
  const toUsdc = deploymentFor(p.toChainId).usdc
  if (!fromUsdc) return { error: `No settlement asset is configured on ${chainName(p.fromChainId)} — nothing was sent.` }
  if (!toUsdc) return { error: `No settlement asset is configured on ${chainName(p.toChainId)} — nothing was sent.` }
  return {
    ok: {
      fromChainId: p.fromChainId,
      toChainId: p.toChainId,
      fromToken: { address: fromUsdc, symbol: settlementSymbol(p.fromChainId), decimals: 6 },
      toTokenAddress: toUsdc,
      amountRaw: p.amountRaw,
      holder: p.holder,
      refuelWeiNeeded: p.refuelWeiNeeded,
    },
  }
}

/** The wallet/chain boundary, injected so the state machine runs in the node
 *  suite against a scripted fake. useBridgeLeg wires the real one. */
export interface BridgeLegEffects {
  fetchQuote: typeof fetchLifiQuote
  readAllowance(args: { chainId: number; token: Address; holder: Address; spender: Address }): Promise<bigint>
  /** MUST write with the explicit chainId it is given. */
  approve(args: { chainId: number; token: Address; spender: Address; value: bigint }): Promise<Hex>
  waitForReceipt(chainId: number, hash: Hex): Promise<unknown>
  /** MUST send with the explicit chainId it is given. */
  sendTransaction(tx: { to: Address; data: Hex; value: bigint; gas?: bigint; chainId: number }): Promise<Hex>
  recordBridge: typeof addBridge
  /** The app's own native-USD read (nativeEthUsdOnChain) — null = unreadable. */
  nativeUsd(chainId: number): Promise<number | null>
  /** True once the owning surface is gone — consulted between the approval
   *  round-trip and the transfer signature. */
  isClosed(): boolean
  setPhase(p: BridgeLegPhase): void
  now(): number
}

/** BridgeFund's executor, one law per step (see the header). Resolves to an
 *  honest {error} rather than throwing — every sentence is shown to a person. */
export async function runBridgeLeg(
  fx: BridgeLegEffects,
  p: BridgeLegExec,
): Promise<{ txHash: Hex } | { error: string }> {
  try {
    fx.setPhase('quoting')

    // REFUEL (the owner: smart gas routing from day 1) — sized here, before any
    // quote or wallet contact, so an unpriceable refuel refuses cleanly.
    let fromAmountForGas: bigint | undefined
    if (p.refuelWeiNeeded != null && p.refuelWeiNeeded > 0n) {
      if (p.fromToken.decimals !== 6) {
        // The conversion prices the from-token at $1 (settlement anchor) —
        // any other token would make the top-up a made-up number.
        fx.setPhase('idle')
        return { error: 'A gas top-up can only ride a settlement-asset bridge — this transfer was not sent.' }
      }
      const units = refuelFromTokenUnits(p.refuelWeiNeeded, await fx.nativeUsd(p.toChainId))
      if (units == null) {
        fx.setPhase('idle')
        return {
          error: `Could not read a native-gas price on ${chainName(p.toChainId)} to size the arrival gas top-up — nothing was sent. Retry, or fund gas there separately.`,
        }
      }
      if (units > 0n) fromAmountForGas = units
    }

    // Fresh quote at signing time (routes go stale in minutes). The guarded
    // parse (lifi.ts) refuses any route whose ends differ from what we asked.
    const q = await fx.fetchQuote({
      chainId: p.toChainId,
      fromChainId: p.fromChainId,
      fromToken: p.fromToken.address,
      toToken: p.toTokenAddress,
      fromAmount: p.amountRaw,
      fromAddress: p.holder,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
      ...(fromAmountForGas != null ? { fromAmountForGas } : {}),
    })

    if (p.fromToken.address !== LIFI_NATIVE) {
      fx.setPhase('approving')
      const allowance = await fx.readAllowance({
        chainId: p.fromChainId,
        token: p.fromToken.address,
        holder: p.holder,
        spender: q.approvalAddress,
      })
      const mode = approvalPlan(allowance, p.amountRaw)
      const values: bigint[] = mode === 'none' ? [] : mode === 'zero-first' ? [0n, p.amountRaw] : [p.amountRaw]
      for (const value of values) {
        const h = await fx.approve({
          chainId: p.fromChainId,
          token: p.fromToken.address,
          spender: q.approvalAddress,
          value,
        })
        await fx.waitForReceipt(p.fromChainId, h)
      }
    }

    // A surface closed during the approval round-trip must not surface a
    // contextless SECOND wallet popup — the transfer is stopped here, and the
    // caller (if anything still listens) is told plainly.
    if (fx.isClosed()) {
      fx.setPhase('idle')
      return { error: 'The transfer was not signed — this screen closed during the approval step.' }
    }

    fx.setPhase('signing')
    const h = await fx.sendTransaction({
      to: q.tx.to,
      data: q.tx.data,
      value: q.tx.value,
      gas: q.tx.gasLimit ?? undefined,
      chainId: p.fromChainId,
    })
    // Immediately, before anything can interrupt: the persisted row is what
    // lets arrival survive a reload (bridge-pending.ts).
    fx.recordBridge({
      txHash: h,
      fromChainId: p.fromChainId,
      toChainId: p.toChainId,
      holder: p.holder,
      fromSymbol: p.fromToken.symbol,
      fromAmountRaw: p.amountRaw,
      fromDecimals: p.fromToken.decimals,
      quotedToAmountRaw: q.toAmount,
      startedAt: fx.now(),
    })
    fx.setPhase('sent')
    return { txHash: h }
  } catch (e) {
    fx.setPhase('idle')
    return { error: e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e) }
  }
}

export interface UseBridgeLegResult {
  /** Thesis-run form: bridge settlement → settlement, refuel converted in here. */
  quoteAndSend(p: BridgeLegParams): Promise<{ txHash: `0x${string}` } | { error: string }>
  /** BridgeFund's form: arbitrary source pay token → destination settlement. */
  quoteAndSendToken(p: BridgeTokenLegParams): Promise<{ txHash: `0x${string}` } | { error: string }>
  phase: BridgeLegPhase
  reset(): void
}

export function useBridgeLeg(): UseBridgeLegResult {
  const { sendTransactionAsync } = useSendTransaction()
  const { writeContractAsync } = useWriteContract()
  const [phase, setPhase] = useState<BridgeLegPhase>('idle')
  // Everything between the first wallet popup and the signed transfer is where
  // leaving costs money (approval paid, nothing bridged). Latched on the
  // owning component's unmount; reset on (re)mount so StrictMode's rehearsal
  // unmount cannot leave it stuck true.
  const closedRef = useRef(false)
  useEffect(() => {
    closedRef.current = false
    return () => {
      closedRef.current = true
    }
  }, [])
  // One transfer at a time: phase is async state, so the running call holds a
  // synchronous latch.
  const activeRef = useRef(false)

  const exec = useCallback(
    async (p: BridgeLegExec): Promise<{ txHash: Hex } | { error: string }> => {
      if (activeRef.current) return { error: 'A transfer is already in flight here — wait for it to finish.' }
      activeRef.current = true
      try {
        return await runBridgeLeg(
          {
            fetchQuote: fetchLifiQuote,
            readAllowance: ({ chainId, token, holder, spender }) =>
              clientFor(chainId).readContract({
                address: token,
                abi: erc20ApproveAbi,
                functionName: 'allowance',
                args: [holder, spender],
              }),
            approve: ({ chainId, token, spender, value }) =>
              writeContractAsync({
                address: token,
                abi: erc20ApproveAbi,
                functionName: 'approve',
                args: [spender, value],
                chainId,
              }),
            waitForReceipt: (chainId, hash) => clientFor(chainId).waitForTransactionReceipt({ hash }),
            sendTransaction: (tx) => sendTransactionAsync(tx),
            recordBridge: addBridge,
            nativeUsd: nativeEthUsdOnChain,
            isClosed: () => closedRef.current,
            setPhase,
            now: Date.now,
          },
          p,
        )
      } finally {
        activeRef.current = false
      }
    },
    [sendTransactionAsync, writeContractAsync],
  )

  const quoteAndSend = useCallback(
    (p: BridgeLegParams): Promise<{ txHash: Hex } | { error: string }> => {
      const leg = resolveSettlementLeg(p)
      if (!leg.ok) return Promise.resolve({ error: leg.error })
      return exec(leg.ok)
    },
    [exec],
  )

  const quoteAndSendToken = useCallback(
    (p: BridgeTokenLegParams): Promise<{ txHash: Hex } | { error: string }> => {
      const toUsdc = deploymentFor(p.toChainId).usdc
      if (!toUsdc) return Promise.resolve({ error: `No settlement asset is configured on ${chainName(p.toChainId)} — nothing was sent.` })
      return exec({ ...p, toTokenAddress: toUsdc })
    },
    [exec],
  )

  const reset = useCallback(() => {
    // Mid-flight the machine's word stands; reset only settles idle/sent.
    if (!activeRef.current) setPhase('idle')
  }, [])

  return { quoteAndSend, quoteAndSendToken, phase, reset }
}
