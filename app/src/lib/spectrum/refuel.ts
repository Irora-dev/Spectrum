import { parseEther } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// REFUEL SIZING POLICY — SpectrumContracts' rule, encoded (their desk answer,
// 2026-08-02): "compute live, clamp per chain."
//
//   needed = destBaseFee × GAS_BUDGET × HEADROOM, clamped to [floor, ceiling]
//
// GAS_BUDGET 3M = approve (~50k) + a 12-leg batch (MEASURED 725,974 on the
// built batcher, not estimated) + headroom for two BASKET legs (each runs the
// basket's full inner acquisition, ~1M). HEADROOM ×2 because an EIP-1559 base
// fee compounds at most 12.5%/block and fast bridges land within ~5 ETH blocks
// (≤1.8× drift). The live half owns freshness; the clamps own sanity — an RPC
// glitch or fee spike can neither under-refuel someone into the cannot-sign
// wall NOR silently convert half their bridge into gas. Over-refuel is not a
// loss: it is the user's own gas, spendable.
//
// UNITS — read this before wiring: the return value is DESTINATION-NATIVE WEI
// NEEDED. LiFi's `fromAmountForGas` (lifi.ts seam) takes FROM-TOKEN raw units,
// so a caller must convert dest-native → fromToken at a current price before
// passing it through. Do not hand this number to the seam directly unless the
// bridged asset IS the destination native token.
//
// The clamps are OPERATING VALUES (SpectrumContracts' starting numbers) —
// tune them here, never bake them into copy or contracts.
// ─────────────────────────────────────────────────────────────────────────────

export const REFUEL_GAS_BUDGET = 3_000_000n
export const REFUEL_HEADROOM_X = 2n

export const REFUEL_CLAMPS: Record<number, { floorWei: bigint; ceilingWei: bigint }> = {
  1: { floorWei: parseEther('0.005'), ceilingWei: parseEther('0.1') },
  8453: { floorWei: parseEther('0.0005'), ceilingWei: parseEther('0.01') },
  4663: { floorWei: parseEther('0.0005'), ceilingWei: parseEther('0.01') },
}

/**
 * Destination native gas a bridging user needs on arrival, in DEST-NATIVE WEI.
 * `null` = no refuel policy for this chain (an unknown destination gets no
 * refuel ask — the seam then omits the parameter entirely, which is the safe
 * direction). A failed base-fee read may be passed as 0n: the floor answers,
 * never zero — under-refuel is the failure this mechanism exists to close.
 */
export function computeRefuelGasWei(destChainId: number, destBaseFeeWei: bigint): bigint | null {
  const clamp = REFUEL_CLAMPS[destChainId]
  if (!clamp) return null
  const raw = destBaseFeeWei * REFUEL_GAS_BUDGET * REFUEL_HEADROOM_X
  if (raw < clamp.floorWei) return clamp.floorWei
  if (raw > clamp.ceilingWei) return clamp.ceilingWei
  return raw
}
