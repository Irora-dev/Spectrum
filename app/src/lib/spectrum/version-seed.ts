import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAddress, type Address } from 'viem'
import { chainCfg } from '../chain/chains'
import { clientFor } from '../chain/rpc'
import { hookedMarketDominates,
  findBestPool,
  isRetryableDetection,
  PoolDetectionError,
  Venue,
  ZERO_POOL_KEY,
  type BasketRoute,
} from '../pools'
import type { ReshapeDraft, ReshapeLeg, VersionSeedResult } from '../../components/reshape/reshape-types'
import type { FeeConfigInput } from './abis-v2'
import { LAUNCHER_ADDRESS } from '../config/operator'
import { useBasketData } from './hooks'
import { useBasketFees, type BasketFees } from './use-basket-fees'
import { shortAddr } from './format'
import { CAP, MIN, MIN_ASSETS } from './weights'

// ─────────────────────────────────────────────────────────────────────────────
// THE v1 → DRAFT RECIPE — BasketBuilder's version-mode prefill (its :968-1066
// effect), EXTRACTED so the reshape popup and the launch builder run ONE
// implementation (the reshape contract, reshape-types.ts). The recipe:
//
//   · re-resolve every predecessor leg against LIVE pools (never copy v1's
//     routing blindly). A retryable RPC failure aborts the WHOLE sweep — "could
//     not check" is a retry, never a verdict; dropping the leg shipped a
//     silently-shorter version with renormalized weights (verify pass F4). A
//     genuinely dead pool (pool infra configured, non-retryable refusal) drops
//     the leg — STATED in `dropped`, never silent to the popup.
//   · weights map by address under the weights.ts law: Math.max(MIN, round),
//     remainder pushed onto the largest leg so Σ = CAP exactly.
//   · name AND ticker carry VERBATIM — keep-same is the default for an edit
//     (owner 2026-08-12). bumpVersionTicker stays an OFFERED convenience
//     behind the UIs' change-ticker toggle; the seed never applies it.
//   · fees carry VERBATIM (rate · creator share · payout). The launcher is
//     NEVER carried: it is live wallet/referral state, re-derived at deploy
//     (deriveLauncher below — the one derivation, shared with the builder).
//
// TWO CONSUMERS, TWO POSTURES (both served honestly, one recipe):
//   · the reshape popup reads the VersionSeedResult contract fields — a draft
//     only when the WHOLE seed is honest (an unreadable fee config is an error
//     there: the popup carries fees silently, so defaulting them would ship a
//     money config the creator never saw).
//   · BasketBuilder reads the builder-fidelity extras (builderLegs with
//     venue/depth/warnings, raw predFees) and keeps its own postures: a null
//     fee read seasons nothing but never blocks the assets/weights prefill,
//     and a <2-holdings predecessor stays silent.
// ─────────────────────────────────────────────────────────────────────────────

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const

// ── The per-leg resolution (moved here from BasketBuilder.tsx, 2026-08-10 —
//    the builder re-exports these so its importers keep their path) ───────────

export interface BuilderAsset {
  address: string
  symbol: string
  decimals: number
  venueLabel: string
  depthUsd: number | null
  warnings: string[]
  route: BasketRoute
}

const symbolAbi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const

async function readSymbol(addr: string, chainId: number): Promise<string> {
  try {
    const s = await clientFor(chainId).readContract({ address: addr as Address, abi: symbolAbi, functionName: 'symbol' })
    return (s as string) || shortAddr(addr)
  } catch {
    return shortAddr(addr)
  }
}

export async function resolveAsset(addr: string, chainId: number, knownSymbol?: string): Promise<BuilderAsset> {
  const [pool, symbol] = await Promise.all([
    findBestPool(addr as Address, chainId),
    knownSymbol ? Promise.resolve(knownSymbol) : readSymbol(addr, chainId),
  ])
  // THE HOOKED-MARKET REFUSAL, at the basket-leg funnel only (owner 2026-08-15,
  // after TEST10006's FWA leg died at the seed wall: "we should try to prevent
  // this happening as much as possible"). When a token's real market is a
  // hooked pool ≥20× deeper than its best routable pool, the leg would ride a
  // dust side pool — and hook-launched tokens often refuse trades outside
  // their own market (FWA did, with its own error). Refused HERE, with the
  // ticker, before any deploy money moves. Pricing/portfolio paths call
  // findBestPool directly and stay unaffected — a held token keeps pricing.
  if (pool.hookedMarket && hookedMarketDominates(pool.hookedMarket.hookedDepthEth, pool.hookedMarket.bestHooklessDepthEth)) {
    throw new PoolDetectionError(
      `$${symbol} lives in a hooked pool — baskets can't route those yet. Pick a token with an open pool.`,
      'HOOKED_MARKET',
    )
  }
  return {
    address: getAddress(addr),
    symbol,
    decimals: pool.decimals,
    venueLabel: pool.best.label,
    depthUsd: pool.best.depthUsd,
    warnings: pool.warnings,
    route: pool.route,
  }
}

// ── Pure parts (testable without wagmi/RPC) ──────────────────────────────────

/** The minimal slice of a predecessor holding the seed reads. */
export interface HoldingSeedInput {
  asset: string
  symbol: string
  name?: string | null
  decimals: number
  targetWeightPct: number
}

export interface DroppedLeg {
  address: string
  symbol: string
  reason: string
}

/** BasketBuilder's exact user-facing sentences (its :1041-1057 precedent) —
 *  single-sourced here; the builder surfaces them verbatim. They say "reload"
 *  because the builder's prefill latches once; the popup additionally offers
 *  retry(), which also works. */
export const SEED_UNRESOLVABLE_ERROR =
  'Couldn’t re-resolve the predecessor’s constituents against live pools.'
export const SEED_RPC_ERROR =
  'Couldn’t re-check every constituent against live pools (RPC error).'
/** Popup-facing sentences for the cases the builder handles silently /
 *  structurally (it stays virgin; the popup must SAY why nothing seeded). */
export const SEED_TOO_FEW_ERROR =
  'This basket has no readable constituents on-chain — there’s nothing to version.'
export const SEED_FEES_UNREADABLE_ERROR =
  'Couldn’t read the basket’s fee config on-chain, so it can’t be carried verbatim into the new version — retry.'
export const SEED_READ_FAILED_ERROR = 'Couldn’t read the basket on-chain — retry.'

/** The weight recipe, verbatim from BasketBuilder :1017-1024: map each surviving
 *  leg's v1 weight by address, clamp to the weights.ts floor
 *  (Math.max(MIN, Math.round(pct))), then push the remainder onto the LARGEST
 *  leg so Σ = CAP exactly. A dropped leg's mass therefore lands on the largest
 *  survivor, never renormalized pro-rata. (Pathological foreign-deployed
 *  predecessors — e.g. 21+ legs whose clamped floors alone exceed CAP — cannot
 *  reach Σ = CAP; the vector is returned as computed and the deploy gate's
 *  isValid() refuses it, exactly the builder's own posture.) */
export function seedWeightsFromPredecessor(
  legs: { address: string }[],
  holdings: { asset: string; targetWeightPct: number }[],
): number[] {
  const wByAddr = new Map(holdings.map((h) => [h.asset.toLowerCase(), h.targetWeightPct]))
  const w = legs.map((a) => Math.max(MIN, Math.round(wByAddr.get(a.address.toLowerCase()) ?? 0)))
  const total = w.reduce((s, x) => s + x, 0)
  if (total !== CAP && w.length > 0) {
    let mi = 0
    for (let i = 1; i < w.length; i++) if (w[i] > w[mi]) mi = i
    w[mi] = Math.max(MIN, w[mi] + (CAP - total))
  }
  return w
}

/** Honest reason line for a dropped leg. The drop path only admits
 *  non-retryable PoolDetectionErrors (isRetryableDetection filters everything
 *  else into the abort-the-batch path), and their messages are already
 *  user-facing prose in the builder's add flow. */
export function droppedReason(e: unknown): string {
  if (e instanceof PoolDetectionError) return e.message
  return 'No live pool could be found for this asset today.'
}

export type SeedResolveFn = (addr: string, chainId: number, knownSymbol?: string) => Promise<BuilderAsset>

/** Re-resolve every predecessor holding against live pools — BasketBuilder's
 *  :979-1013 per-leg semantics, verbatim:
 *   · retryable failure while pool infra exists → THROW (abort the whole sweep;
 *     "could not check" is never a verdict — the F4 rule: no silently-shorter
 *     basket, ever);
 *   · non-retryable refusal while pool infra exists → the pool is genuinely
 *     gone → dropped, with its reason;
 *   · no pool infra on this build (preview / not-yet-deployed chain) → carry
 *     the leg over marked 'unverified'; its routing must be re-checked before
 *     deploy.
 *  `resolve` is injectable for tests; production always uses resolveAsset. */
/** A two-slot serial gate. Not a generic pool — exactly the shape this file
 *  needs, so the burst bound is visible where it binds. */
function pLimit2<T>(): (fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: (() => void)[] = []
  const next = () => {
    active--
    queue.shift()?.()
  }
  return (fn) =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++
        fn().then(
          (v) => {
            next()
            resolve(v)
          },
          (e) => {
            next()
            reject(e)
          },
        )
      }
      if (active < 2) run()
      else queue.push(run)
    })
}

export async function resolveHoldingsForSeed(
  holdings: HoldingSeedInput[],
  chainId: number,
  opts: { poolReady?: boolean; resolve?: SeedResolveFn } = {},
): Promise<{ ok: BuilderAsset[]; dropped: DroppedLeg[] }> {
  const resolve = opts.resolve ?? resolveAsset
  const poolReady = opts.poolReady ?? !!chainCfg(chainId).poolManager
  type LegOutcome = { kind: 'ok'; asset: BuilderAsset } | { kind: 'dropped'; leg: DroppedLeg }
  // TWO AT A TIME, deliberately (measured 2026-08-10): each resolution is a
  // full findBestPool sweep (~10 RPC round-trips), and firing every leg at
  // once buried a USER-INITIATED add behind the burst — findBestPool measured
  // 1.3s alone and 8.3s while this seed ran unbounded, with the transport's
  // 429 backoff (400→3200ms) amplifying each collision. The seed's own
  // latency hides behind the popup's skeleton; the user's add does not.
  const limit = pLimit2<LegOutcome>()
  const outcomes = await Promise.all(
    holdings.map((h) => limit(async (): Promise<LegOutcome> => {
      try {
        return { kind: 'ok', asset: await resolve(h.asset, chainId, h.symbol) }
      } catch (first) {
        // ONE automatic retry on a transient failure BEFORE surfacing (owner
        // 2026-08-16, live: "it always breaks the first time, works on the
        // retry button" — the first attempt rides a cold cache and the
        // transport's 429 backoff window, and pressing Retry was doing
        // exactly this by hand). One retry, never a loop: a second transient
        // failure surfaces as before and the button remains.
        let e = first
        if (poolReady && isRetryableDetection(first)) {
          await new Promise((r) => setTimeout(r, 800))
          try {
            return { kind: 'ok', asset: await resolve(h.asset, chainId, h.symbol) }
          } catch (second) {
            e = second
          }
        }
        if (poolReady && isRetryableDetection(e)) throw e
        if (poolReady) return { kind: 'dropped', leg: { address: h.asset, symbol: h.symbol, reason: droppedReason(e) } }
        try {
          return {
            kind: 'ok',
            asset: {
              address: getAddress(h.asset),
              symbol: h.symbol,
              decimals: h.decimals,
              venueLabel: 'unverified',
              depthUsd: null,
              warnings: ['Routing not re-checked on this build, verify before deploy.'],
              route: { venue: Venue.V2, ethPool: ZERO_POOL_KEY, v3Fee: 0, v2Pair: ZERO_ADDR as Address },
            },
          }
        } catch {
          return { kind: 'dropped', leg: { address: h.asset, symbol: h.symbol, reason: 'Unparseable asset address.' } }
        }
      }
    })),
  )
  return {
    ok: outcomes.filter((o): o is Extract<LegOutcome, { kind: 'ok' }> => o.kind === 'ok').map((o) => o.asset),
    dropped: outcomes.filter((o): o is Extract<LegOutcome, { kind: 'dropped' }> => o.kind === 'dropped').map((o) => o.leg),
  }
}

/** v1's fee config carried VERBATIM into a draft — except the launcher, which
 *  is live wallet/referral state and is NEVER carried (the ReshapeDraft
 *  contract): the zero address here is an explicit "not derived yet"
 *  placeholder. Deploy stages MUST replace it via deriveLauncher(). */
export function seedFeeConfig(
  fees: Pick<BasketFees, 'basketFeeBps' | 'creatorShareBps' | 'creatorPayout'>,
): FeeConfigInput {
  return {
    basketFeeBps: fees.basketFeeBps,
    creatorShareBps: fees.creatorShareBps,
    // On-chain payout is null exactly when the share is 0 (the contract's
    // BadCreatorShare invariant) — the zero address is the correct carry then.
    creatorPayout: (fees.creatorPayout ?? ZERO_ADDR) as `0x${string}`,
    launcher: ZERO_ADDR,
  }
}

/** The launcher derivation, verbatim from BasketBuilder :681-692 — extracted so
 *  the reshape deploy stage and the builder run ONE implementation of the
 *  referral money path. Rules preserved exactly:
 *   · first-basket gate defaults NOT-first until `allBaskets` has LOADED
 *     (undefined = loading; a loading state must never over-credit a referrer);
 *   · a self-referrer is never their own launcher;
 *   · the one-shot creator-ref flag closes the same-session race;
 *   · fallback is the operator's LAUNCHER_ADDRESS, else the zero address. */
export function deriveLauncher(args: {
  account: string | null | undefined
  /** All known baskets, or undefined while the read is in flight. */
  allBaskets: { deployer?: string | null }[] | undefined
  /** The stored ?ref referrer, if any (referral.ts getStoredRef). */
  referrer: Address | null
  /** hasCreatorRefBeenUsed() — the one-shot flag. */
  refAlreadyUsed: boolean
}): { launcher: Address; appliedReferrer: boolean; isFirstBasket: boolean } {
  const { account, allBaskets, referrer, refAlreadyUsed } = args
  const isFirstBasket =
    !!account && !!allBaskets && !allBaskets.some((b) => b.deployer?.toLowerCase() === account.toLowerCase())
  const appliedReferrer =
    !!referrer && isFirstBasket && !refAlreadyUsed && referrer.toLowerCase() !== account?.toLowerCase()
  const launcher = ((appliedReferrer ? referrer : LAUNCHER_ADDRESS) ?? ZERO_ADDR) as Address
  return { launcher, appliedReferrer, isFirstBasket }
}

/** Everything the sweep + predecessor reads determine, minus status/retry.
 *  Builder-fidelity fields (`legs`/`weights`/`name`/`symbol`) are populated
 *  whenever ≥2 legs resolved — even when the fee read failed and the popup
 *  projection (`draft`) must stay null. */
export interface AssembledSeed {
  legs: BuilderAsset[] | null
  weights: number[] | null
  name: string | null
  symbol: string | null
  dropped: DroppedLeg[]
  draft: ReshapeDraft | null
  errorKind: 'unresolvable' | 'too-few-holdings' | 'fees-unreadable' | null
  error: string | null
}

export function assembleVersionSeed(args: {
  name: string
  symbol: string
  holdings: HoldingSeedInput[]
  ok: BuilderAsset[]
  dropped: DroppedLeg[]
  fees: BasketFees | null
}): AssembledSeed {
  const { name, symbol, holdings, ok, dropped, fees } = args
  // MIN_ASSETS is 1 (weights.ts — the owner's own ruling: "can't we allow a basket
  // to just have one asset?"), and this gate still said 2 (owner 2026-08-16,
  // hitting it live while editing a single-asset leg: "we dont need two
  // constituents anymore"). The branch ORDER survives: zero survivors from a
  // predecessor that HAS holdings is the poisoned-draft guard (say so, write
  // NOTHING — the 2026-07-07 wedge); zero holdings = nothing to version.
  if (ok.length < MIN_ASSETS) {
    if (holdings.length >= MIN_ASSETS) {
      return { legs: null, weights: null, name: null, symbol: null, dropped, draft: null, errorKind: 'unresolvable', error: SEED_UNRESOLVABLE_ERROR }
    }
    return { legs: null, weights: null, name: null, symbol: null, dropped, draft: null, errorKind: 'too-few-holdings', error: SEED_TOO_FEW_ERROR }
  }
  const weights = seedWeightsFromPredecessor(ok, holdings)
  // The ticker seeds as the predecessor's OWN symbol — keep-same is the
  // default for an edit (owner 2026-08-12). bumpVersionTicker is an offered
  // convenience behind the UIs' change-ticker toggle, never applied here.
  if (!fees) {
    // The popup carries fees SILENTLY (no fee step) — an unreadable fee config
    // there would mean deploying a money config the creator never saw, so no
    // draft exists. The builder still prefills legs/identity from the fields
    // below and falls back to its own visible, editable fee defaults.
    return { legs: ok, weights, name, symbol, dropped, draft: null, errorKind: 'fees-unreadable', error: SEED_FEES_UNREADABLE_ERROR }
  }
  const nameByAddr = new Map(holdings.map((h) => [h.asset.toLowerCase(), h.name ?? null]))
  const legs: ReshapeLeg[] = ok.map((a) => ({
    address: a.address as `0x${string}`,
    symbol: a.symbol,
    name: nameByAddr.get(a.address.toLowerCase()) ?? null,
    decimals: a.decimals,
    route: a.route,
  }))
  return {
    legs: ok,
    weights,
    name,
    symbol,
    dropped,
    draft: { name, symbol, legs, weights, feeConfig: seedFeeConfig(fees) },
    errorKind: null,
    error: null,
  }
}

// ── The hook ─────────────────────────────────────────────────────────────────

export type VersionSeedErrorKind =
  | 'rpc' // retryable failure aborted the sweep — builder shows SEED_RPC_ERROR
  | 'unresolvable' // <2 survivors of a ≥2-leg predecessor — builder shows SEED_UNRESOLVABLE_ERROR
  | 'too-few-holdings' // <2 holdings on-chain — the builder stays SILENT (its precedent)
  | 'fees-unreadable' // fee read null — builder prefills legs + its own fee defaults
  | 'read-failed' // an on-chain read query errored — builder keeps waiting (its old gate's posture)

export interface VersionSeedState extends VersionSeedResult {
  errorKind: VersionSeedErrorKind | null
  /** Builder-fidelity legs (venue label · depth · warnings — everything the
   *  weights step's liquidity tiers need). Populated whenever ≥2 legs resolved,
   *  including the fees-unreadable case where `draft` must stay null. */
  builderLegs: BuilderAsset[] | null
  builderWeights: number[] | null
  seedName: string | null
  seedSymbol: string | null
  /** v1's raw on-chain fee read; null = unreadable (the builder then keeps its
   *  own visible defaults — a null read seasons nothing but blocks nothing). */
  predFees: BasketFees | null
}

const NO_DROPS: DroppedLeg[] = []

type SweepOutcome = { kind: 'done'; ok: BuilderAsset[]; dropped: DroppedLeg[] } | { kind: 'rpc' }

/** The v1→draft seed for `address` on `chainId`. Callable with address
 *  null/undefined (status stays 'loading'; nothing fetches) — hooks-above-gates
 *  callers pass their address conditionally, never call the hook conditionally.
 *  The internal reads share query keys with useBasketData/useBasketFees, so a
 *  caller that also reads the basket costs no extra fetch. */
export function useVersionSeed(address: string | null | undefined, chainId: number): VersionSeedState {
  const addr = address || undefined
  const basketQ = useBasketData(addr, chainId)
  const feesQ = useBasketFees(addr, chainId)
  const [attempt, setAttempt] = useState(0)
  const [sweep, setSweep] = useState<{ key: string; outcome: SweepOutcome } | null>(null)
  const key = addr ? `${chainId}:${addr.toLowerCase()}:${attempt}` : null
  const predData = basketQ.data
  const predFees = feesQ.data

  useEffect(() => {
    if (!key) return
    if (sweep?.key === key) return
    // The builder's exact prefill timing: gate ONLY on the constituent data;
    // wait for the fee query to SETTLE (undefined = in flight) but never for it
    // to SUCCEED — a null fee read must not block the assets/weights seed (it
    // once wedged the whole version flow).
    if (!predData || predFees === undefined) return
    let cancelled = false
    void (async () => {
      try {
        const res = await resolveHoldingsForSeed(predData.holdings, chainId)
        if (!cancelled) setSweep({ key, outcome: { kind: 'done', ok: res.ok, dropped: res.dropped } })
      } catch {
        // A retryable per-leg refusal aborted the batch: clean-retry posture —
        // nothing partial, nothing dropped.
        if (!cancelled) setSweep({ key, outcome: { kind: 'rpc' } })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [key, chainId, predData, predFees, sweep])

  // retry() re-arms the sweep and re-fetches whichever on-chain read failed
  // (the fee read caches a null HARD — session-long — so it needs the explicit
  // refetch; a transient blip there must not permanently blank the popup).
  const basketQRef = useRef(basketQ)
  basketQRef.current = basketQ
  const feesQRef = useRef(feesQ)
  feesQRef.current = feesQ
  const retry = useCallback(() => {
    const bq = basketQRef.current
    const fq = feesQRef.current
    if (bq.isError) void bq.refetch()
    if (fq.isError || fq.data === null) void fq.refetch()
    setAttempt((a) => a + 1)
  }, [])

  const predecessor = useMemo<`0x${string}` | null>(() => {
    if (!addr) return null
    try {
      return getAddress(addr)
    } catch {
      return addr as `0x${string}`
    }
  }, [addr])

  return useMemo<VersionSeedState>(() => {
    const empty = {
      draft: null,
      dropped: NO_DROPS,
      builderLegs: null,
      builderWeights: null,
      seedName: null,
      seedSymbol: null,
    }
    if (!addr || !key) {
      return { status: 'loading', error: null, errorKind: null, predFees: null, predecessor, retry, ...empty }
    }
    if (basketQ.isError || feesQ.isError) {
      return { status: 'error', error: SEED_READ_FAILED_ERROR, errorKind: 'read-failed', predFees: null, predecessor, retry, ...empty }
    }
    if (!predData || predFees === undefined || sweep?.key !== key) {
      return { status: 'loading', error: null, errorKind: null, predFees: null, predecessor, retry, ...empty }
    }
    if (sweep.outcome.kind === 'rpc') {
      return { status: 'error', error: SEED_RPC_ERROR, errorKind: 'rpc', predFees: predFees ?? null, predecessor, retry, ...empty }
    }
    const a = assembleVersionSeed({
      name: predData.name,
      symbol: predData.symbol,
      holdings: predData.holdings,
      ok: sweep.outcome.ok,
      dropped: sweep.outcome.dropped,
      fees: predFees ?? null,
    })
    return {
      status: a.draft ? ('ready' as const) : ('error' as const),
      draft: a.draft,
      predecessor,
      dropped: a.dropped,
      error: a.error,
      errorKind: a.errorKind,
      retry,
      builderLegs: a.legs,
      builderWeights: a.weights,
      seedName: a.name,
      seedSymbol: a.symbol,
      predFees: predFees ?? null,
    }
  }, [addr, key, predecessor, retry, basketQ.isError, feesQ.isError, predData, predFees, sweep])
}
