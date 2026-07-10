import type { PublicClient } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// Gas headroom for basket-touching writes (swapExactIn buy / mintInKind).
//
// eth_estimateGas UNDER-shoots the basket's acquire flow: one swapExactIn expands
// into a USDC→ETH hub swap + one ETH→asset swap per leg, all behind V4 hookData
// the estimator can't fully trace. An honest compound reverted OUT OF GAS at the
// wallet's estimate (used 225k of a 237k limit; the same call needs ~600k+ and
// succeeds with more). So we set the limit ourselves: 2× a fresh estimate, floored
// generously. Unused gas is refunded, so over-provisioning only costs balance
// headroom, never spent gas — the safe side for a mint that must not die mid-flight.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_FLOOR = 1_500_000n

/** A gas limit with headroom for a basket-mint write, or the floor when the
 *  estimate is unavailable/too low. Pass the SAME call params used for the write. */
export async function gasWithHeadroom(
  client: PublicClient,
  params: Parameters<PublicClient['estimateContractGas']>[0],
  floor: bigint = DEFAULT_FLOOR,
): Promise<bigint> {
  try {
    const est = await client.estimateContractGas(params)
    const doubled = est * 2n
    return doubled > floor ? doubled : floor
  } catch {
    return floor
  }
}
