import { useEffect, useRef, useState } from 'react'
import { usePublicClient } from 'wagmi'
import type { Address } from 'viem'
import { deploymentFor } from '../chain/deployments'
import { simulateSwapOut } from './swap-sim'
import type { Side } from './use-basket-swap'

// Debounced on-chain pricing of a buy or sell (see swap-sim.ts for WHY). Returns the
// realised tokenOut so floors are a haircut on what the chain will actually pay,
// instead of on a frictionless spot/NAV figure. `out: null` ⇒ the caller keeps its
// estimate (degraded but functional) — this hook never blocks a trade.
const DEBOUNCE_MS = 350

export interface SwapSimState {
  /** realised tokenOut, raw (shares on a buy, settlement on a sell); null when unpriced */
  out: bigint | null
  loading: boolean
  /** The (side, amountRaw) `out` was measured for. The caller MUST check this matches
   *  the trade it is about to encode: a realised figure from a DIFFERENT size is not a
   *  valid basis for a floor. Too low ⇒ the user is under-protected and the click-time
   *  simulate still passes (it only fails closed on a too-HIGH floor), so this guard is
   *  the thing that keeps a stale quote from being signed. */
  forAmountRaw: bigint | null
  forSide: Side | null
}

export function useSwapSim(args: {
  enabled: boolean
  side: Side
  basket: Address
  chainId: number
  amountRaw: bigint
  legCount: number
  holder: Address | undefined
  allowanceCovers: boolean
  /** BUY only — the payload's funding split, so the probe measures the trade that will
   *  actually be signed (swap-sim.ts: without it a D-R1 basket funds nothing).
   *  ⚠ This argument was once dropped by an auto-merge (the allocator line edited
   *  this file while the zero-split fix was adding it), which broke the typecheck
   *  while the tests stayed green. If it goes missing again, that is the shape. */
  fundingSplitBps?: readonly number[] | null
}): SwapSimState {
  const { enabled, side, basket, chainId, amountRaw, legCount, holder, allowanceCovers, fundingSplitBps } = args
  const publicClient = usePublicClient({ chainId })
  const dep = deploymentFor(chainId)
  const router = dep.swapRouter
  const settlement = dep.usdc
  const [state, setState] = useState<SwapSimState>({
    out: null,
    loading: false,
    forAmountRaw: null,
    forSide: null,
  })
  // Sequence guard: only the newest request may write state. A slow earlier quote
  // must never overwrite a newer one — that would sign a floor for the wrong size.
  const seq = useRef(0)

  useEffect(() => {
    const mySeq = ++seq.current
    if (!enabled || !publicClient || !router || !settlement || !holder || amountRaw <= 0n || legCount <= 0) {
      setState({ out: null, loading: false, forAmountRaw: null, forSide: null })
      return
    }
    // Drop the previous figure immediately: it was measured for a DIFFERENT size/side,
    // so carrying it while the new quote lands would let a stale basis be signed.
    setState({ out: null, loading: true, forAmountRaw: null, forSide: null })
    const t = setTimeout(() => {
      void simulateSwapOut(publicClient, {
        side,
        basket,
        settlement: settlement as Address,
        router: router as Address,
        amountIn: amountRaw,
        legCount,
        holder,
        allowanceCovers,
        fundingSplitBps,
      })
        .then((out) => {
          if (seq.current === mySeq) {
            setState({ out, loading: false, forAmountRaw: amountRaw, forSide: side })
          }
        })
        .catch(() => {
          if (seq.current === mySeq) {
            setState({ out: null, loading: false, forAmountRaw: null, forSide: null })
          }
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [
    enabled,
    side,
    publicClient,
    router,
    settlement,
    basket,
    amountRaw.toString(),
    legCount,
    holder,
    allowanceCovers,
    // The split is part of what is being measured: a new split is a new probe.
    fundingSplitBps?.join(',') ?? '',
  ])

  return state
}
