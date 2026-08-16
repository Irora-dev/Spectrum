import { parseAbi, type Address, type PublicClient } from 'viem'
import { settlementDecimalsFor } from '../chain/deployments'

// ─────────────────────────────────────────────────────────────────────────────
// LAW S2b FOR THE CONSOLE LANES (SpectrumContracts' fast-re-read follow-up,
// 2026-08-16): the runner lanes verify configured settlement decimals against
// the token's own decimals() before money moves; the console lanes (basket
// buy/sell, the swap-route migration) trusted the config unverified — a
// config-8/token-6 slip would UNDER-floor the buy leg. Same law, one shared
// module: read once per (chain, token), cache only verified successes, refuse
// on mismatch/unreadable/absurd. The runner keeps its own reviewed copy
// (digest-set discipline); these lanes share THIS one.
// ─────────────────────────────────────────────────────────────────────────────

const erc20DecimalsAbi = parseAbi(['function decimals() view returns (uint8)'])
const confirmed = new Map<string, number>()

/** Exported for pins: the session cache must be resettable per test. */
export function resetVerifiedSettlementDecimals(): void {
  confirmed.clear()
}

/**
 * The chain's settlement decimals, VERIFIED against the token itself.
 * Throws (in review-grade words) on unreadable, absurd, or config-vs-chain
 * disagreement — the caller must refuse the send, never fall back to config.
 */
export async function verifiedSettlementDecimals(
  client: PublicClient,
  chainId: number,
  token: Address,
): Promise<number> {
  const key = `${chainId}:${token.toLowerCase()}`
  const hit = confirmed.get(key)
  if (hit != null) return hit
  const expected = settlementDecimalsFor(chainId)
  let onChain: number
  try {
    onChain = Number(await client.readContract({ address: token, abi: erc20DecimalsAbi, functionName: 'decimals' }))
  } catch {
    throw new Error('The settlement token’s decimals could not be read, so amounts cannot be converted safely. Nothing was sent.')
  }
  if (!Number.isInteger(onChain) || onChain < 2 || onChain > 36)
    throw new Error('The settlement token reports decimals no real token has, so amounts cannot be converted safely. Nothing was sent.')
  if (onChain !== expected)
    throw new Error(
      `This chain’s settlement token reports ${onChain} decimals but this app is configured for ${expected}. Converting money across that disagreement could mis-scale every amount, so nothing was sent. Fix the deployment config.`,
    )
  confirmed.set(key, onChain)
  return onChain
}
