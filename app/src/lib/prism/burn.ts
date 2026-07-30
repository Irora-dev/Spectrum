import { parseAbi, type Address } from 'viem'
import { PRISM_V2_HOOK } from './claim'

// ─────────────────────────────────────────────────────────────────────────────
// The L1 auction-burn machinery the Flush canvas drives — ONE seam for seating
// day (pre-staged 2026-07-30 while waiting on the new factory book).
//
// The NEW burner is ALREADY live and verified (first real burn observed;
// SpectrumContracts 35/35 read-back), but the CURRENT mainnet factory still
// sends auction proceeds to the INCUMBENT — re-pointing the canvas alone would
// split the flow (step 1 fills the incumbent, step 2 aims at the new burner).
// So the flip rides the new deployments.json book: when the re-mined factories
// are seated, set BURNER_V2 = true here and the canvas switches to the new
// address, its ABI, and PRISM v2 pricing in one move.
//
// The two burners are NOT ABI-compatible where it matters:
//   incumbent — flush(minPrismOut): caller-supplied floor (0 = UNPROTECTED),
//               whole-balance only. Buys the exploited v1 PRISM. SUPERSEDED.
//   v2        — minPrismOut is MANDATORY (flush(0)/flushAmount(x,0) REVERT);
//               flushAmount(ethIn, minPrismOut) sizes the burn (the pool is
//               thin — whole-balance reverts at size; drain in slices);
//               minOutFloor(ethIn) is a spot-derived SANITY VIEW, never the
//               quote (same-block spot is what a sandwich controls). A revert
//               is the contract refusing a bad burn: smaller slice or fresher
//               quote, never a looser floor.
// ─────────────────────────────────────────────────────────────────────────────

/** Flip to true WITH the new factory book — never before (see header). */
export const BURNER_V2 = false

/** The active burner. Literal ternary on purpose: scripts/verify-deployments.mjs
 *  parses both addresses out of this line and read-backs the active one. */
export const BURNER: Address = BURNER_V2
  ? '0x2E39Ae825C697BE3e15ACd003d1398287C83D4b6'
  : '0x9d2b5f051074CFdFc14da4430779857529739837'

/** What the active burner BUYS — the price-estimate source for the auto floor.
 *  Incumbent buys the exploited v1 token (its hardcoded immediate); v2 buys
 *  the community's v2 hook token. */
export const BURN_PRICE_TOKEN: Address = BURNER_V2
  ? PRISM_V2_HOOK
  : '0xbd3ab5859f244cc9f51ee0ca755c5cf663d80040'

export const incumbentBurnerAbi = parseAbi(['function flush(uint256 minPrismOut)'])

export const burnerV2Abi = parseAbi([
  'function flush(uint256 minPrismOut)',
  'function flushAmount(uint256 ethIn, uint256 minPrismOut)',
  'function minOutFloor(uint256 ethIn) view returns (uint256)',
])

/** v2 slice size — SpectrumContracts' keeper guidance against the live pool:
 *  0.1 ETH clears comfortably, 1 ETH exceeds the band. Proven on their fork:
 *  1 ETH refused whole, drained completely in slices. */
export const BURNER_V2_SLICE_WEI = 100_000_000_000_000_000n // 0.1 ETH
