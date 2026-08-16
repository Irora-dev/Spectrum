import { useQuery } from '@tanstack/react-query'
import { encodeFunctionData, numberToHex, type Address } from 'viem'
import { DEFAULT_CHAIN_ID } from '../chain/chains'
import { clientFor } from '../chain/rpc'
import { basketAbi } from './abis-v2'
import { cacheGet, cacheSet } from './persist-cache'
import { revertDataOf } from './decode-revert'
import { settlementDecimalsFor } from '../chain/deployments'
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
//   • eligibility — eth_call flushPrismBurn(1 wei): success = crankable now
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
 *  reading into its native ETH terms for display, and gives the pipeline
 *  runner a basis for a REAL minEthOut floor (zero floors revert, F8).
 *  Cached; null on failure. */
export async function fetchEthUsd(opts: { fresh?: boolean } = {}): Promise<number | null> {
  // fresh: SKIP the read-side cache (still writes it). A slippage floor derived
  // from a 10-minute-old price silently widens or over-tightens the haircut —
  // the display bars want the cache, the money paths want the wire.
  if (!opts.fresh) {
    const cached = cacheGet<number>('eth-usd:v1')
    if (cached != null) return cached
  }
  try {
    const r = await fetch('https://api.dexscreener.com/tokens/v1/ethereum/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', {
      headers: { Accept: 'application/json' },
      // A black-holed connection must not wedge a "Pricing…" button or an armed
      // run for the browser's full network timeout.
      signal: AbortSignal.timeout(8_000),
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
  /** flushPrismBurn(1 wei) would succeed right now (post-F8: zero floors revert). */
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
// Per-lineage: 0xacb715f1 = BelowBurnThreshold (mainnet incumbent legs) ·
// 0x6ceb35f7 = BelowBridgeThreshold (Base + Robinhood legs — LIVE-probed on
// three RH baskets 2026-08-02; the old set carried only the mainnet selector,
// so the threshold search returned null on every basket this kit actually
// lists) · 0x98642b86 = NothingToBurn.
const BELOW_GATE_SELECTORS = new Set(['0xacb715f1', '0x6ceb35f7', '0x98642b86'])

type ProbeResult = 'ok' | `0x${string}` | 'error'

// eth_call with NO `from` runs as msg.sender = 0x0 — and a SUCCESSFUL flush
// ends by paying the bounty to msg.sender, which every settlement token
// refuses for the zero address. Past-gate probes therefore reverted at the
// bounty transfer and eligibility could never read true. A dead-but-nonzero
// sender keeps the probe read-only while letting the full path succeed.
const PROBE_FROM = '0x000000000000000000000000000000000000dEaD'

async function probeAt(basket: Address, chainId: number, pendingOverride: bigint | null): Promise<ProbeResult> {
  const client = clientFor(chainId)
  // 1 wei, not 0: post-F8 legs (src/base + src/mainnet — F8 never touched the
  // robinhood lineage, so today's LIVE RH legs accept 0 and behave identically
  // at 0 vs 1, probed) revert CrankFloorRequired() on a zero floor before any
  // gate check. 1 wei passes that check on every lineage and sits below any
  // real output, so the gate selectors stay the test everywhere.
  const data = encodeFunctionData({ abi: basketAbi, functionName: 'flushPrismBurn', args: [1n] })
  try {
    await client.request({
      method: 'eth_call',
      params: pendingOverride == null
        ? [{ from: PROBE_FROM, to: basket, data }, 'latest']
        : [
            { from: PROBE_FROM, to: basket, data },
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

/** Lightweight "would flushPrismBurn(1 wei) succeed right now" — the batch
 *  sequencer's skip test and the eligible-count's unit. */
export async function fetchBurnEligible(basket: Address, chainId: number): Promise<boolean> {
  return (await probeAt(basket, chainId, null)) === 'ok'
}

export async function fetchBurnEligibility(basket: Address, chainId: number): Promise<BurnEligibility> {
  const client = clientFor(chainId)
  const eligible = (await probeAt(basket, chainId, null)) === 'ok'

  // Threshold (cached): only re-derived when stale.
  // v3: v2 entries were derived through the 0n probe that post-F8 contracts
  // refuse outright (CrankFloorRequired before any gate), so every cached
  // threshold from that era is garbage — same class as v1's selector misread,
  // same cure: bump the key IN the fix, let stale entries TTL out unread.
  const cacheKey = `burn-threshold:v3:${chainId}:${basket.toLowerCase()}`
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
  const threshold = Number(formatUnits(hi, settlementDecimalsFor(chainId)))
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
