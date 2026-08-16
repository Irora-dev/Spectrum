import { useEffect, useRef, useState } from 'react'
import { usePublicClient } from 'wagmi'
import type { Address } from 'viem'
import { lensFactoryFor, resolveMintFunding, type MintFundingOutcome } from './mint-funding'
import { deploymentFor } from '../chain/deployments'

// Debounced read of the funding split a BUY payload must carry (see mint-funding.ts
// for WHY, and hook-data.ts for the measured revert that made it mandatory). Unlike
// use-swap-sim, this one is NOT optional: a buy whose funding has not resolved for the
// exact amount on screen must not be signed, because the two payload shapes are not
// interchangeable — a split on a pre-packing basket reverts LegMinNotMet, and no split
// on a D-R1 basket reverts NoOutput. So the caller gates the button on it.
const DEBOUNCE_MS = 350

export interface MintFundingState {
  outcome: MintFundingOutcome | null
  loading: boolean
  /** The amount `outcome` was resolved for. The caller MUST check it matches the trade
   *  it is about to encode: the split is read for a specific size. */
  forAmountRaw: bigint | null
}

const IDLE: MintFundingState = { outcome: null, loading: false, forAmountRaw: null }

export function useMintFunding(args: {
  enabled: boolean
  basket: Address
  chainId: number
  amountRaw: bigint
  legCount: number
  /** effectiveSupply() === 0 — the lens refuses there by design. */
  firstMint: boolean
  /** Bump to re-run the read after a retryable refusal (audit 2026-08-16: the
   *  outcomes say "try again" and carry retryable:true, but the hook only
   *  re-ran on amount/basket changes — the flag had no lever). */
  retryNonce?: number
}): MintFundingState {
  const { enabled, basket, chainId, amountRaw, legCount, firstMint, retryNonce = 0 } = args
  const publicClient = usePublicClient({ chainId })
  const [state, setState] = useState<MintFundingState>(IDLE)
  // Only the newest request may write state: an older split belongs to another size.
  const seq = useRef(0)

  useEffect(() => {
    const mySeq = ++seq.current
    if (!enabled || amountRaw <= 0n || legCount <= 0) {
      setState(IDLE)
      return
    }
    // A first mint on a PRE-PACKING deployment needs no read at all (the lens refuses at
    // supply 0 and nothing may ride the top bits), so resolve it synchronously rather
    // than making the operator's bootstrap buy wait on a round trip. On a packing
    // deployment it does need one — the basket's own weights — so it takes the path
    // below. Every live deployment today is pre-packing, so this stays the common case.
    if (firstMint && !deploymentFor(chainId).packsFundingSplit) {
      setState({
        outcome: { ok: true, packed: false, funding: { source: 'basket-weights', because: 'first-mint' } },
        loading: false,
        forAmountRaw: amountRaw,
      })
      return
    }
    if (!publicClient) {
      setState({
        outcome: { ok: false, reason: 'No connection to the network for this chain.', retryable: true },
        loading: false,
        forAmountRaw: amountRaw,
      })
      return
    }
    // Drop the previous answer immediately: it was read for a different size.
    setState({ outcome: null, loading: true, forAmountRaw: null })
    const t = setTimeout(() => {
      // The basket's OWN lineage factory owns the lens for it (mint-funding.ts).
      void lensFactoryFor(chainId, basket)
        .then((factory) =>
          factory == null
            ? ({
                ok: false,
                reason: 'Could not tell which contracts this basket belongs to. Refresh and try again.',
                retryable: true,
              } as MintFundingOutcome)
            : resolveMintFunding(publicClient, { chainId, factory, basket, amountIn: amountRaw, legCount, firstMint }),
        )
        .then((outcome) => {
          if (seq.current === mySeq) setState({ outcome, loading: false, forAmountRaw: amountRaw })
        })
        .catch(() => {
          // The lineage read can fail; resolveMintFunding cannot. Either way, swallowing
          // it silently would arm a buy with no funding, so it becomes a refusal.
          if (seq.current === mySeq) {
            setState({
              outcome: { ok: false, reason: 'Could not prepare this buy. Refresh and try again.', retryable: true },
              loading: false,
              forAmountRaw: amountRaw,
            })
          }
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [enabled, publicClient, chainId, basket, amountRaw.toString(), legCount, firstMint, retryNonce])

  return state
}
