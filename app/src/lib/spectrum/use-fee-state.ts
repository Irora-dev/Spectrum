import { useQuery } from '@tanstack/react-query'
import { formatUnits, zeroAddress, type Address } from 'viem'
import { DEFAULT_CHAIN_ID } from '../chain/chains'
import { clientFor } from '../chain/rpc'
import { INTERFACE_TAG_ADDRESS } from '../config/operator'
import { basketAbi } from './abis-v2'
import { USDC_DECIMALS } from './deploy'

// ─────────────────────────────────────────────────────────────────────────────
// LIVE (mutable) fee state for the /flush creator console. Distinct from
// `use-basket-fees.ts`, which reads the IMMUTABLE per-basket config (cached hard
// for the session). These figures move on every mint/redeem, so they are read
// fresh and refetched. All amounts are USDC (the settlement asset).
//
//   • feeReserve            — USDC backing settled holder accruals (claimFees pulls from it)
//   • pendingPrismBurn      — USDC awaiting the permissionless flushPrismBurn() crank
//   • claimable             — the connected holder's claimable USDC (claimableFees(holder))
//   • frontend[]            — interface / launcher / creator pull accruals (pendingFrontendFees[fe]),
//                             one row per KNOWN recipient with a non-zero balance
//
// The known recipients are the basket's own `creatorPayout` + `launcher` and the
// operator's optional interface tag. Any other address can still be flushed by
// hand (the crank is keyed by an arbitrary `fe`); the console exposes that too.
// ─────────────────────────────────────────────────────────────────────────────

export type FrontendRole = 'Creator' | 'Launcher' | 'Interface'

export interface FrontendAccrual {
  role: FrontendRole
  address: Address
  pendingUsdc: number
}

export interface FeeState {
  /** USDC backing settled holder accruals (the reserve claimFees draws from). */
  feeReserveUsdc: number
  /** USDC accrued to the PRISM burn, awaiting the flushPrismBurn() crank. */
  pendingBurnUsdc: number
  /** Basket tokens queued in the lazy-burn queue, settled by redeemClaims(). */
  pendingClaimsTokens: number
  /** The queried holder's claimable USDC (settled + unsettled), or 0 with no holder. */
  claimableUsdc: number
  /** Known interface/launcher/creator accruals with a pending balance > 0. */
  frontend: FrontendAccrual[]
}

const isZero = (a?: string | null) => !a || a.toLowerCase() === zeroAddress
const toUsdc = (v: bigint) => Number(formatUnits(v, USDC_DECIMALS))

export async function fetchFeeState(
  address: Address,
  chainId: number,
  holder?: Address,
): Promise<FeeState | null> {
  if (import.meta.env.DEV) {
    const { devFeeState } = await import('./dev-fixture')
    const mock = devFeeState(address, chainId, holder)
    if (mock) return mock
  }

  const client = clientFor(chainId)
  const base = { address, abi: basketAbi } as const

  // The two basket-level figures are required (a basket missing them isn't a V2
  // basket); the recipient lookups are best-effort.
  let feeReserveUsdc: number
  let pendingBurnUsdc: number
  let pendingClaimsTokens: number
  try {
    const [reserve, burn, claims] = await Promise.all([
      client.readContract({ ...base, functionName: 'feeReserve' }),
      client.readContract({ ...base, functionName: 'pendingPrismBurn' }),
      client.readContract({ ...base, functionName: 'pendingBasketBurn' }),
    ])
    feeReserveUsdc = toUsdc(reserve)
    pendingBurnUsdc = toUsdc(burn)
    pendingClaimsTokens = Number(formatUnits(claims, 18)) // basket token decimals
  } catch {
    return null
  }

  const [claimable, creatorPayout, launcher] = await Promise.all([
    holder
      ? client.readContract({ ...base, functionName: 'claimableFees', args: [holder] }).then(toUsdc).catch(() => 0)
      : Promise.resolve(0),
    client.readContract({ ...base, functionName: 'creatorPayout' }).then((a) => (isZero(a) ? null : a)).catch(() => null),
    client.readContract({ ...base, functionName: 'launcher' }).then((a) => (isZero(a) ? null : a)).catch(() => null),
  ])

  // De-dup recipients (a self-deployer may name themselves launcher == creator),
  // keep the first role's label, and read each one's pending balance.
  const candidates: { role: FrontendRole; address: Address }[] = []
  const push = (role: FrontendRole, a: Address | null) => {
    if (!a || candidates.some((c) => c.address.toLowerCase() === a.toLowerCase())) return
    candidates.push({ role, address: a })
  }
  push('Creator', creatorPayout)
  push('Launcher', launcher)
  push('Interface', INTERFACE_TAG_ADDRESS)

  const frontend = (
    await Promise.all(
      candidates.map((c) =>
        client
          .readContract({ ...base, functionName: 'pendingFrontendFees', args: [c.address] })
          .then((v): FrontendAccrual => ({ ...c, pendingUsdc: toUsdc(v) }))
          .catch((): FrontendAccrual => ({ ...c, pendingUsdc: 0 })),
      ),
    )
  ).filter((a) => a.pendingUsdc > 0)

  return { feeReserveUsdc, pendingBurnUsdc, pendingClaimsTokens, claimableUsdc: claimable, frontend }
}

/** Live fee state for the /flush console — short-lived cache (figures move on every trade). */
export function useFeeState(address?: string, chainId: number = DEFAULT_CHAIN_ID, holder?: string) {
  return useQuery({
    queryKey: ['spectrum', 'feeState', chainId, address?.toLowerCase(), holder?.toLowerCase()],
    queryFn: () => fetchFeeState(address as Address, chainId, holder as Address | undefined),
    enabled: !!address,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  })
}

/** Read a single arbitrary recipient's pending frontend-fee accrual (for the
 *  "flush any address" advanced control — the crank is keyed by an arbitrary fe). */
export async function readPendingFrontendFees(
  address: Address,
  chainId: number,
  fe: Address,
): Promise<number> {
  if (import.meta.env.DEV) {
    const { devFeeState } = await import('./dev-fixture')
    const mock = devFeeState(address, chainId)
    const hit = mock?.frontend.find((f) => f.address.toLowerCase() === fe.toLowerCase())
    if (mock) return hit?.pendingUsdc ?? 0
  }
  const v = (await clientFor(chainId).readContract({
    address,
    abi: basketAbi,
    functionName: 'pendingFrontendFees',
    args: [fe],
  })) as bigint
  return toUsdc(v)
}
