import { useQuery } from '@tanstack/react-query'
import { type Address, zeroAddress } from 'viem'
import { DEFAULT_CHAIN_ID } from '../chain/chains'
import { clientFor } from '../chain/rpc'
import { basketAbi } from './abis-v2'
import { getDeployer } from './basket-data'
import { FEE_BOUNDS, PROTOCOL_FEE_MODEL, type FeeBounds } from './fee-model'

// ─────────────────────────────────────────────────────────────────────────────
// Per-basket fee readout.
// The genuinely per-basket fee fields — `basketFeeBps` (the creator's chosen
// rate), `creatorShareBps`/`creatorPayout` (the capped, removable creator share),
// and `launcher` (the per-basket origination recipient) — are READ from the
// basket contract. The PRISM burn (10%), interface (≈5%) and launcher (≈5%)
// SHARES are FIXED protocol constants (fee-model.ts): identical on every basket,
// no per-basket getter, no ratchet. Holders take the rest of the remainder
// (guaranteed ≥70%), derived from the fixed cap — not a getter. Fee config is
// immutable per basket, so the readout is cached hard for the session.
// ─────────────────────────────────────────────────────────────────────────────

export type { FeeBounds }

export interface BasketFees {
  /** Total per-mint/redeem/swap fee, in bps. Set by the creator at launch; immutable. */
  basketFeeBps: number
  /** Fixed PRISM burn share (BURN_SHARE_BPS) — a protocol constant, uniform on every basket. */
  burnShareBps: number
  /** Fixed interface-kickback slice of the post-burn remainder (INTERFACE_SHARE_BPS). */
  interfaceShareBps: number
  /** Fixed launcher/origination slice of the post-burn remainder (LAUNCHER_SHARE_BPS). */
  launcherShareBps: number
  /** Creator's share of the post-burn-interface-launcher remainder, in bps (0..MAX). Read on-chain. */
  creatorShareBps: number
  /** Cap on the creator share ⇒ holder floor = (1 − cap/BPS) of the remainder. */
  maxCreatorShareBps: number
  /** Creator payout recipient, or null when there is no creator share. */
  creatorPayout: string | null
  /** Per-basket launcher recipient, or null when none was named at deploy. */
  launcher: string | null
  /** The basket's recorded deployer (for the creator-label derivation). */
  deployer: string | null
}

const isZero = (a?: string | null) => !a || a.toLowerCase() === zeroAddress

async function fetchBasketFees(address: Address, chainId: number): Promise<BasketFees | null> {
  if (import.meta.env.DEV) {
    const { devBasketFees } = await import('./dev-fixture')
    const mock = devBasketFees(address, chainId)
    if (mock) return mock
  }

  const client = clientFor(chainId)

  // The headline rate is required — bail to null (panel hides) on failure. The
  // burn/interface/launcher shares are fixed protocol constants, not reads.
  let basketFeeBps: number
  try {
    const fee = await client.readContract({ address, abi: basketAbi, functionName: 'basketFeeBps' })
    basketFeeBps = Number(fee)
  } catch {
    return null
  }

  // Creator share + payout + launcher are immutable per-basket reads. They're
  // best-effort: a basket that predates these getters still shows its rate + the
  // fixed protocol slices (creator defaults to 0 / no payout).
  const [creatorShareBps, creatorPayout, launcher] = await Promise.all([
    client
      .readContract({ address, abi: basketAbi, functionName: 'creatorShareBps' })
      .then((v) => Number(v))
      .catch(() => 0),
    client
      .readContract({ address, abi: basketAbi, functionName: 'creatorPayout' })
      .then((a) => (isZero(a) ? null : (a as string)))
      .catch(() => null),
    client
      .readContract({ address, abi: basketAbi, functionName: 'launcher' })
      .then((a) => (isZero(a) ? null : (a as string)))
      .catch(() => null),
  ])

  // Deployer for the creator-label derivation — via the shared, persisted
  // basket-data cache (one factory read per basket per browser, ever).
  const deployer = await getDeployer(address, chainId)

  return {
    basketFeeBps,
    burnShareBps: PROTOCOL_FEE_MODEL.BURN_SHARE_BPS,
    interfaceShareBps: PROTOCOL_FEE_MODEL.INTERFACE_SHARE_BPS,
    launcherShareBps: PROTOCOL_FEE_MODEL.LAUNCHER_SHARE_BPS,
    creatorShareBps,
    maxCreatorShareBps: PROTOCOL_FEE_MODEL.MAX_CREATOR_SHARE_BPS,
    creatorPayout,
    launcher,
    deployer,
  }
}

/** Immutable per-basket fee config — cached hard for the session. */
export function useBasketFees(address?: string, chainId: number = DEFAULT_CHAIN_ID) {
  return useQuery({
    queryKey: ['spectrum', 'basketFees', chainId, address?.toLowerCase()],
    queryFn: () => fetchBasketFees(address as Address, chainId),
    enabled: !!address,
    staleTime: Infinity,
    gcTime: Infinity,
  })
}

/** Protocol fee-model constants for the builder fee step (§6.5). These are fixed
 *  protocol constants, so they resolve synchronously from
 *  fee-model.ts — no chain read, and crucially available on an EMPTY marketplace
 *  (no basket exists yet to read a rate from). `data` is a stable reference. */
export function useFeeBounds(_chainId: number): { data: FeeBounds } {
  return { data: FEE_BOUNDS }
}
