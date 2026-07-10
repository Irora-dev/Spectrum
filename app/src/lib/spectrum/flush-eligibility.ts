import { useQuery } from '@tanstack/react-query'
import { encodeFunctionData, numberToHex, type Address } from 'viem'
import { DEFAULT_CHAIN_ID } from '../chain/chains'
import { clientFor } from '../chain/rpc'
import { basketAbi } from './abis-v2'
import { cacheGet, cacheSet } from './persist-cache'
import { revertDataOf } from './decode-revert'
import { USDC_DECIMALS } from './deploy'
import { formatUnits } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// PRISM-burn flush eligibility (owner 2026-07-07 16:06: "doesn't that need
// ~0.3 before it can be flushed? Show that per basket… rather than just have
// a transaction get reverted").
//
// The contract gates flushPrismBurn behind a SPOT-VALUE threshold (measured
// live on TBV3: pending must exceed ≈$556 ≈ 0.314 ETH at probe time) but
// exposes NO getter for it. So nothing is hardcoded here — two live probes:
//
//   • eligibility — eth_call flushPrismBurn(0): success = crankable now.
//     Exact by construction; also how the batch sequencer skips reverts.
//   • threshold  — binary-search the revert boundary via eth_call with a
//     stateDiff override on the pendingPrismBurn storage slot (slot 16 —
//     verified against the public getter on BOTH live baskets; the search
//     GUARDS on that equality per basket and returns null on any mismatch,
//     hiding the bar rather than drawing a wrong one).
//
// The threshold moves with the oracle's ETH price, so it caches briefly and
// the bar is labelled ≈. ~12 eth_calls per basket per 10 min, directory-sized.
// ─────────────────────────────────────────────────────────────────────────────

const PENDING_BURN_SLOT = 16n
const ETH_USD_TTL_MS = 10 * 60_000

/** Live ETH/USD (DexScreener WETH, deepest pair) — converts the gate's USDC
 *  reading into its native ETH terms for display. Cached; null on failure. */
async function fetchEthUsd(): Promise<number | null> {
  const cached = cacheGet<number>('eth-usd:v1')
  if (cached != null) return cached
  try {
    const r = await fetch('https://api.dexscreener.com/tokens/v1/ethereum/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', {
      headers: { Accept: 'application/json' },
    })
    if (!r.ok) return null
    const pairs = (await r.json()) as { priceUsd?: string; liquidity?: { usd?: number } }[]
    const best = (Array.isArray(pairs) ? pairs : [])
      .filter((x) => x.priceUsd)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]
    const v = best ? parseFloat(best.priceUsd!) : NaN
    if (!Number.isFinite(v) || v <= 0) return null
    cacheSet('eth-usd:v1', v, ETH_USD_TTL_MS)
    return v
  } catch {
    return null
  }
}
const THRESHOLD_TTL_MS = 10 * 60_000
const MAX_PROBE_USDC = 4_096_000_000n // $4,096 — way above any spot threshold we've seen

export interface BurnEligibility {
  /** flushPrismBurn(0) would succeed right now. */
  eligible: boolean
  /** ≈ USDC pending needed before the crank clears (null = couldn't be derived). */
  thresholdUsdc: number | null
  /** The same target in ETH terms — the gate is spot-value denominated, so this
   *  is the stable way to READ it (owner 16:23: "surely that needs to be 0.3
   *  ETH, right?" — right). Null when no live ETH price. */
  thresholdEth: number | null
}

// Revert selectors that mean "the threshold gate itself said no" — measured
// live on TBV3/TBV2 (0xacb715f1 = the below-threshold error; 0x98642b86 =
// NothingToBurn). Anything ELSE — success, or a revert deeper in the swap
// path (e.g. TransferFailed when an override fakes accounting the contract's
// USDC balance can't back) — means the gate itself passed at that value.
const BELOW_GATE_SELECTORS = new Set(['0xacb715f1', '0x98642b86'])

type ProbeResult = 'ok' | `0x${string}` | 'error'

async function probeAt(basket: Address, chainId: number, pendingOverride: bigint | null): Promise<ProbeResult> {
  const client = clientFor(chainId)
  const data = encodeFunctionData({ abi: basketAbi, functionName: 'flushPrismBurn', args: [0n] })
  try {
    await client.request({
      method: 'eth_call',
      params: pendingOverride == null
        ? [{ to: basket, data }, 'latest']
        : [
            { to: basket, data },
            'latest',
            { [basket]: { stateDiff: { [numberToHex(PENDING_BURN_SLOT, { size: 32 })]: numberToHex(pendingOverride, { size: 32 }) } } },
          ],
    })
    return 'ok'
  } catch (e) {
    // The revert selector must come from the error chain's DATA field — a
    // message regex once matched the CALL's own selector out of viem's "Raw
    // Call Arguments" echo, classifying every probe as past-the-gate and
    // collapsing the derived threshold to ~$1 (the owner's "41 cents = 41%"
    // catch, 2026-07-07 16:23).
    const data = revertDataOf(e)
    return data ? (data.slice(0, 10).toLowerCase() as `0x${string}`) : 'error'
  }
}

const belowGate = (r: ProbeResult) => r !== 'ok' && r !== 'error' && BELOW_GATE_SELECTORS.has(r)

/** Lightweight "would flushPrismBurn(0) succeed right now" — the batch
 *  sequencer's skip test and the eligible-count's unit. */
export async function fetchBurnEligible(basket: Address, chainId: number): Promise<boolean> {
  return (await probeAt(basket, chainId, null)) === 'ok'
}

export async function fetchBurnEligibility(basket: Address, chainId: number): Promise<BurnEligibility> {
  const client = clientFor(chainId)
  const eligible = (await probeAt(basket, chainId, null)) === 'ok'

  // Threshold (cached): only re-derived when stale.
  // v2: v1 entries were poisoned by the selector-misread bug (a ~$1 threshold
  // cached client-side survived the code fix and kept rendering "41%" — owner
  // 16:29). The version bump makes every browser re-derive through the fixed
  // path; stale v1 keys expire on their own TTL and are never read again.
  const cacheKey = `burn-threshold:v2:${chainId}:${basket.toLowerCase()}`
  const cached = cacheGet<number>(cacheKey)
  if (cached != null) return { eligible, thresholdUsdc: cached, thresholdEth: await ethTermsOf(cached) }

  // GUARD: the slot must BE pendingPrismBurn for this basket, or no bar.
  try {
    const [getter, slotRaw] = await Promise.all([
      client.readContract({ address: basket, abi: basketAbi, functionName: 'pendingPrismBurn' }),
      client.getStorageAt({ address: basket, slot: numberToHex(PENDING_BURN_SLOT, { size: 32 }) }),
    ])
    if (BigInt(slotRaw ?? '0x0') !== getter) return { eligible, thresholdUsdc: null, thresholdEth: null }
  } catch {
    return { eligible, thresholdUsdc: null, thresholdEth: null }
  }

  // Binary-search the gate boundary: below → the gate's own selectors; at or
  // above → anything else (success, or swap-path reverts past the gate).
  const atMax = await probeAt(basket, chainId, MAX_PROBE_USDC)
  if (belowGate(atMax) || atMax === 'error') {
    // $4k still reads below-gate (or the RPC rejects overrides) — no honest bar.
    return { eligible, thresholdUsdc: null, thresholdEth: null }
  }
  let lo = 0n
  let hi = MAX_PROBE_USDC
  let sawBelow = false
  for (let i = 0; i < 13 && hi - lo > 1_000_000n; i++) {
    const mid = (lo + hi) / 2n
    const r = await probeAt(basket, chainId, mid)
    if (belowGate(r)) {
      lo = mid
      sawBelow = true
    } else if (r === 'error') return { eligible, thresholdUsdc: null, thresholdEth: null }
    else hi = mid
  }
  // Honesty gate: a boundary is only real if the search actually OBSERVED the
  // below side. A run where every probe read "above" (mis-decoded reverts,
  // zero-threshold contract) yields lo=0 — no bar over an unverified boundary.
  if (!sawBelow) {
    const nearZero = await probeAt(basket, chainId, 1n)
    if (!belowGate(nearZero)) return { eligible, thresholdUsdc: null, thresholdEth: null }
  }
  const threshold = Number(formatUnits(hi, USDC_DECIMALS))
  cacheSet(cacheKey, threshold, THRESHOLD_TTL_MS)
  return { eligible, thresholdUsdc: threshold, thresholdEth: await ethTermsOf(threshold) }
}

async function ethTermsOf(thresholdUsdc: number): Promise<number | null> {
  const ethUsd = await fetchEthUsd()
  return ethUsd != null ? thresholdUsdc / ethUsd : null
}

export function useBurnEligibility(basket?: string, chainId: number = DEFAULT_CHAIN_ID) {
  return useQuery({
    queryKey: ['spectrum', 'burnEligibility', chainId, basket?.toLowerCase()],
    queryFn: () => fetchBurnEligibility(basket as Address, chainId),
    enabled: !!basket, // fixture baskets fail closed (probe throws → not eligible, no bar)
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
}
