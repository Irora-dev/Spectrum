import type { Address } from 'viem'
import { erc20Abi } from 'viem'
import { chainCfg } from '../chain/chains'
import { deploymentFor } from '../chain/deployments'
import { clientFor } from '../chain/rpc'
import { starterSuggestionsFor } from '../chain/starter-suggestions'
import { stocksForChain } from '../chain/stocks'
import { findBestPool } from '../pools/find-best-pool'
import { nativeEthUsdOnChain } from '../pools/v4-usd'
import { PRISM_CLAIM_CHAIN_ID, PRISM_V2_HOOK } from '../prism/claim'
import { batcherFor } from './execution-arming'
import { spotReadsFor, isFactoryBasket } from './basket-data'
import { readHopReserveUsd } from './hop-reserve'
import { createProxyZeroExFetcher } from './zeroex-quote'
import { INTERFACE_TAG_ADDRESS } from '../config/operator'
import type { ComposeDeps, MarketReader, MarketRow } from './portfolio-run-wiring'

// ─────────────────────────────────────────────────────────────────────────────
// THE PRODUCTION READERS behind portfolio-run-wiring — every network seam the
// wiring injects, implemented over machinery this app already trusts:
// findBestPool (route + decimals + the V2-rejection lineage), basket-data's
// DexScreener spot cache, hop-reserve's fail-closed depth read, the pools
// lib's native-USD read, and the 0x proxy fetcher. Nothing here invents a
// second source for a number that already has one home.
// ─────────────────────────────────────────────────────────────────────────────

/** The app's own vetted set: the curated stock registry + the starter shelf.
 *  A curated token is vetted no-tax (0); anything else answers null, and the
 *  floor discipline REFUSES an unknown tax rather than assuming a reflection
 *  token is honest (its rule 4 — the silently-500-bps-loose case). */
export function curatedTaxBps(chainId: number, address: string): number | null {
  const a = address.toLowerCase()
  // PRISM v2 — the protocol's own self-hooked NAV token (the app's own named
  // constant, lib/prism/claim.ts; the claim machinery ships in this kit).
  // Vetted no-tax: the hook prices mints/redeems, transfers are standard.
  // (the owner live 2026-08-15: his PRISM buy refused on unknown tax.)
  if (chainId === PRISM_CLAIM_CHAIN_ID && a === PRISM_V2_HOOK.toLowerCase()) return 0
  for (const st of stocksForChain(chainId)) if (st.address.toLowerCase() === a) return 0
  for (const s of starterSuggestionsFor(chainId)) if (s.address.toLowerCase() === a) return 0
  return null
}

/** One PlanLegInput per target, or the named reason it cannot be budgeted.
 *  Price/liquidity ride the spot read (absent → null → planToLegs' own
 *  unpriceable/optional laws speak, in their own sentences); route + decimals
 *  ride findBestPool, whose refusals (no pool, V2-only on a rejecting chain)
 *  become the leg's reason verbatim. */
export const defaultMarketReader: MarketReader = async (targets) => {
  const out = new Map<string, MarketRow>()
  const chains = [...new Set(targets.map((t) => t.chainId))]
  await Promise.all(
    chains.map(async (chainId) => {
      const mine = targets.filter((t) => t.chainId === chainId)
      const spots = await spotReadsFor(mine.map((t) => t.address), chainId).catch(
        () => new Map<string, { priceUsd: number; liquidityUsd: number | null; atMs: number }>(),
      )
      await Promise.all(
        mine.map(async (t) => {
          const k = `${chainId}:${t.address.toLowerCase()}`
          try {
            const pool = await findBestPool(t.address, chainId)
            const spot = spots.get(t.address.toLowerCase())
            out.set(k, {
              ok: true,
              leg: {
                symbol: t.symbol,
                asset: t.address,
                decimals: pool.decimals,
                weightPct: t.weightPct,
                priceUsd: spot?.priceUsd ?? null,
                priceAgeMs: spot ? Date.now() - spot.atMs : null,
                liquidityUsd: spot?.liquidityUsd ?? null,
                // curated first; then FACTORY MEMBERSHIP — Spectrum's own
                // baskets are protocol bytecode, no transfer tax by
                // construction (isFactoryBasket's header). Everything else
                // stays null and the floor law refuses, as designed.
                buyTokenTaxBps: curatedTaxBps(chainId, t.address) ?? ((await isFactoryBasket(chainId, t.address)) ? 0 : null),
                route: pool.route,
              },
            })
          } catch (e) {
            out.set(k, {
              ok: false,
              symbol: t.symbol,
              reason: `$${t.symbol}: ${e instanceof Error ? e.message : 'this asset’s route could not be read'}`,
            })
          }
        }),
      )
    }),
  )
  return out
}

/** The chain's settlement token, or null — the wiring names the refusal. */
export function settlementFor(chainId: number): Address | null {
  try {
    return deploymentFor(chainId).usdc ?? null
  } catch {
    return null
  }
}

/** Every compose-time read, production-wired. Failures answer null (the
 *  assembler refuses null gas/native/hop in its own fail-closed sentences)
 *  or throw into the runner's refusal channel — never a guessed number. */
export function defaultComposeDeps(): ComposeDeps {
  return {
    batcherFor,
    // the ACTIVE signer's own settlement balance — the wallet that will send
    // this batch, not the linked group the page reads (see the check's note in
    // portfolio-run-wiring). Any read failure yields null, which SKIPS the
    // check rather than inventing an empty wallet.
    settlementBalance: async (chainId, account, token) => {
      try {
        return await clientFor(chainId).readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] })
      } catch {
        return null
      }
    },
    chainNowSec: async (chainId) => {
      const block = await clientFor(chainId).getBlock()
      return Number(block.timestamp)
    },
    gasPriceWei: (chainId) => clientFor(chainId).getGasPrice().catch(() => null),
    nativeUsd: (chainId) => nativeEthUsdOnChain(chainId),
    hopReserveUsd: async (chainId) => {
      const slug = chainCfg(chainId).dexscreenerSlug
      const funding = settlementFor(chainId)
      // no indexer or no settlement = no honest depth read; null refuses every
      // leg downstream (deriveLegFloors rule 3), which is the designed answer
      if (!slug || !funding) return null
      const weth = (() => {
        try {
          return deploymentFor(chainId).weth ?? null
        } catch {
          return null
        }
      })()
      const read = await readHopReserveUsd({ chainId, slug, funding, weth })
      return read?.reserveUsd ?? null
    },
    fetchQuote: createProxyZeroExFetcher(),
    feeRecipient: INTERFACE_TAG_ADDRESS,
  }
}
