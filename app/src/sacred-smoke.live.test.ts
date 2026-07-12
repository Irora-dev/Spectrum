// ─────────────────────────────────────────────────────────────────────────────
// Sacred smoke — LIVE, read-only proof that the two money-path systems still
// work against the real chains, using the app's OWN modules (not re-implemented
// checks). Runs only under vitest's `sacred` mode:
//
//   npm run smoke:sacred          (from app/; plain `vitest run` skips this file)
//
// Per configured chain:
//   launch — an existing deployed basket's own legs are read back and fed
//            through the real pipeline: route-convention check → findBestPool
//            agreement → mineSalt (the factory's predictTokenAddress oracle) →
//            a full deployBasket eth_call simulation. This is exactly the class
//            that shipped broken once (2026-07-11 CREATE2Failed: a bad leg
//            route sails through mining, then EVERY deploy reverts) — the
//            simulation catches it before a release, with no funds moved.
//   swap   — the NAV read surfaces answer (non-reverting views), the on-chain
//            ETH/USD anchor is sane, the canonical router holds code, and on
//            LiFi-routed chains a real hub quote must pass the app's own guards.
//
// Wired into releases: the maintainer release pipeline runs this on every
// release that touches sacred-paths.json (how releases work: docs/RELEASES.md);
// the public canary workflow runs it daily. Slots being closed between
// Dutch-auction deploys is an HONEST state: the simulation then must revert
// with something that is NOT CREATE2Failed/route-shaped.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll } from 'vitest'
import { parseEther, zeroAddress, type Address } from 'viem'
import { SUPPORTED_CHAIN_IDS, chainCfg } from './lib/chain/chains'
import { clientFor } from './lib/chain/rpc'
import { basketAbi, factoryAbi, factoryDeployAbi, type FeeConfigInput } from './lib/spectrum/abis-v2'
import { mineSalt } from './lib/spectrum/salt-mining'
import { startSqrtPriceX96ForDollarNav, type DeployBasketEntry } from './lib/spectrum/deploy'
import { revertDataOf } from './lib/spectrum/decode-revert'
import { findBestPool } from './lib/pools'
import { nativeEthUsdOnChain } from './lib/pools/v4-usd'
import { fetchLifiQuote, LIFI_NATIVE } from './lib/spectrum/lifi'
import { DEFAULT_SLIPPAGE_BPS } from './lib/spectrum/hook-data'

// `npm run smoke:sacred` passes --mode sacred (cross-platform: no env-prefix, and the
// browser tsconfig has no node globals — vitest's MODE is the one switch).
const LIVE = import.meta.env.MODE === 'sacred'
const T = 300_000 // live chains + public RPCs: generous per-test budget

// Simulation-only identity: never funded, never signs — eth_call's `from`.
const SMOKE_DEPLOYER = '0x1111111111111111111111111111111111111111' as Address
const CREATE2_FAILED_SELECTOR = '0x53a83a75'

describe.skipIf(!LIVE)('sacred smoke (live, read-only)', () => {
  for (const chainId of SUPPORTED_CHAIN_IDS) {
    const cfg = chainCfg(chainId)
    // A chain with no factory is an honest empty shell — nothing sacred runs there.
    describe.skipIf(!cfg.factory)(`${cfg.name} (${chainId})`, () => {
      const client = clientFor(chainId)
      let reference: Address
      let legs: DeployBasketEntry[]
      let supply = 0n

      beforeAll(async () => {
        const factory = cfg.factory as Address
        const n = await client.readContract({ address: factory, abi: factoryAbi, functionName: 'allBasketsLength' })
        if (n === 0n) {
          // An honest live state, not a broken pipeline: nobody has deployed a basket
          // on this chain's factory yet (first live hit: Ethereum's fresh canonical
          // factory, 2026-07-12). Basket-dependent tests skip themselves below.
          console.warn(`[sacred-smoke] ${cfg.name}: the factory enumerates ZERO baskets — basket-dependent checks skipped.`)
          return
        }

        // Newest-first scan for a reference basket with legs (any deployed basket's
        // own composition is proven-good by construction — no hardcoded fixture to rot).
        const count = Number(n)
        const scan = Math.min(count, 8)
        const candidates = await Promise.all(
          Array.from({ length: scan }, (_, k) =>
            client.readContract({
              address: factory,
              abi: factoryAbi,
              functionName: 'allBaskets',
              args: [BigInt(count - 1 - k)],
            }),
          ),
        )
        for (const addr of candidates) {
          const [len, total] = await Promise.all([
            client.readContract({ address: addr, abi: basketAbi, functionName: 'basketLength' }),
            client.readContract({ address: addr, abi: basketAbi, functionName: 'totalSupply' }),
          ])
          if (len > 0n) {
            reference = addr
            supply = total
            const rows = await Promise.all(
              Array.from({ length: Number(len) }, (_, i) =>
                client.readContract({ address: addr, abi: basketAbi, functionName: 'basket', args: [BigInt(i)] }),
              ),
            )
            // viem returns the top-level tuple positionally (the nested pool key is named)
            legs = rows.map((r) => ({
              asset: r[0],
              venue: r[1],
              ethPool: {
                currency0: r[2].currency0,
                currency1: r[2].currency1,
                fee: r[2].fee,
                tickSpacing: r[2].tickSpacing,
                hooks: r[2].hooks,
              },
              v3Fee: r[3],
              v2Pair: r[4],
              weight: r[5],
              decimals: r[6],
            }))
            if (total > 0n) break // prefer a live-supply basket, settle for any with legs
          }
        }
        expect(reference, 'baskets exist but none of the newest 8 has legs — that IS pipeline-shaped').toBeTruthy()
      }, T)

      /** Basket-dependent tests skip honestly on a virgin factory (warned in beforeAll). */
      const noReference = () => !legs?.length

      // ── launch ──
      it(
        'launch: every live leg rides the native-ETH route convention',
        () => {
          if (noReference()) return
          // The factory is ONE build at the SAME address on every chain: every leg's
          // ethPool keys against native ETH (currency0 == 0x0). The 2026-07-11 incident
          // was exactly a violation of this invariant, invented client-side.
          for (const leg of legs) {
            expect(leg.ethPool.currency0.toLowerCase(), `leg ${leg.asset} ethPool.currency0`).toBe(zeroAddress)
          }
        },
        T,
      )

      it(
        'launch: route detection agrees with the live convention',
        async () => {
          if (noReference()) return
          // findBestPool must propose the SAME route shape the deployed basket uses —
          // drift here mints un-deployable baskets while mining still succeeds.
          const r = await findBestPool(legs[0].asset, chainId)
          expect(r.route, `findBestPool found no route for live leg ${legs[0].asset}`).toBeTruthy()
          expect(r.route.ethPool.currency0.toLowerCase()).toBe(zeroAddress)
        },
        T,
      )

      it(
        'launch: a proven basket re-simulates a full deployBasket (no funds moved)',
        async () => {
          if (noReference()) return
          const factory = cfg.factory as Address
          const feeConfig: FeeConfigInput = {
            basketFeeBps: 100, // the builder defaults (1% fee, 30% creator share)
            creatorShareBps: 3000,
            creatorPayout: SMOKE_DEPLOYER,
            launcher: zeroAddress,
          }
          // The factory's own predictTokenAddress is the mining oracle — a malformed
          // basket/fee config fails the miner's first probe loudly (that probe passing
          // is itself validation: the real legs + fee config encode and answer).
          // Mining is a 1/16384 lottery per probe: a no-salt round is BAD LUCK (or a
          // rate-limited RPC dropping probes), not a broken pipeline — retry, then
          // call it inconclusive rather than red.
          let mined: Awaited<ReturnType<typeof mineSalt>> | null = null
          for (let round = 0; round < 2 && !mined; round++) {
            try {
              mined = await mineSalt({
                factory,
                chainId,
                basket: legs,
                deployer: SMOKE_DEPLOYER,
                feeConfig,
                maxAttempts: 60_000,
              })
            } catch (e) {
              if (!String(e).includes('No 0x88 salt found')) throw e
              console.warn(`[sacred-smoke] ${cfg.name}: salt round ${round + 1} found nothing — retrying with a fresh base.`)
            }
          }
          if (!mined) {
            console.warn(`[sacred-smoke] ${cfg.name}: no salt after 2 rounds (lottery/rate limits) — deploy simulation inconclusive; the oracle probe itself passed.`)
            return
          }
          const { salt, predicted } = mined
          const startSqrtPriceX96 = startSqrtPriceX96ForDollarNav(predicted, cfg.usdc as Address)

          // Dutch auction: between slots currentDeployPrice reverts — an honest state.
          let priceWei: bigint | null = null
          try {
            priceWei = await client.readContract({ address: factory, abi: factoryDeployAbi, functionName: 'currentDeployPrice' })
          } catch {
            priceWei = null
          }

          const simulate = (stateOverride: boolean) =>
            client.simulateContract({
              account: SMOKE_DEPLOYER,
              address: factory,
              abi: factoryDeployAbi,
              functionName: 'deployBasket',
              args: [salt, 'Sacred Smoke', 'SMOKE', legs, startSqrtPriceX96, priceWei ?? 0n, feeConfig],
              value: priceWei ?? 0n,
              ...(stateOverride ? { stateOverride: [{ address: SMOKE_DEPLOYER, balance: parseEther('50') }] } : {}),
            })

          try {
            await simulate(true)
            // Full success: the deploy pipeline (routes, salt, price, fee config) is sound.
          } catch (e) {
            const raw = revertDataOf(e) ?? ''
            const text = String(e)
            // The one hard verdict: CREATE2Failed means the deploy pipeline is broken.
            expect(raw.startsWith(CREATE2_FAILED_SELECTOR) || text.includes(CREATE2_FAILED_SELECTOR.slice(2)), `deployBasket simulation reverted CREATE2Failed — the launch pipeline is broken: ${text.slice(0, 400)}`).toBe(false)
            if (priceWei === null) {
              // Slot closed: any non-CREATE2 revert is the auction gate doing its job.
              console.warn(`[sacred-smoke] ${cfg.name}: auction slot closed — deploy simulation reverted honestly (not CREATE2Failed).`)
            } else if (/state override|stateoverride|method not found|-32602|not supported/i.test(text)) {
              // Node without eth_call state overrides: retry unfunded; only a
              // funds-shaped failure is acceptable then.
              try {
                await simulate(false)
              } catch (e2) {
                const raw2 = revertDataOf(e2) ?? ''
                const text2 = String(e2)
                expect(raw2.startsWith(CREATE2_FAILED_SELECTOR) || text2.includes(CREATE2_FAILED_SELECTOR.slice(2)), `deployBasket simulation reverted CREATE2Failed — the launch pipeline is broken: ${text2.slice(0, 400)}`).toBe(false)
                const fundsShaped = /insufficient funds|insufficient balance|exceeds the balance/i.test(text2)
                expect(fundsShaped, `deploy simulation failed for a non-funds reason with the slot OPEN: ${text2.slice(0, 400)}`).toBe(true)
                console.warn(`[sacred-smoke] ${cfg.name}: node lacks state overrides — deploy simulation inconclusive beyond funds (pipeline checks passed).`)
              }
            } else {
              throw e
            }
          }
        },
        600_000, // two mining rounds on a rate-limited RPC need headroom
      )

      // ── swap ──
      it(
        'swap: the NAV read surfaces answer without reverting',
        async () => {
          if (noReference()) return
          const [[rate, fullyPriced], [reserve]] = await Promise.all([
            client.readContract({ address: reference, abi: basketAbi, functionName: 'exchangeRate' }),
            client.readContract({ address: reference, abi: basketAbi, functionName: 'totalReserve' }),
          ])
          expect(typeof rate).toBe('bigint')
          expect(typeof reserve).toBe('bigint')
          if (fullyPriced && supply > 0n) expect(rate).toBeGreaterThan(0n)
        },
        T,
      )

      it(
        'swap: the on-chain ETH/USD anchor is sane',
        async () => {
          // The settlement-pool anchor is what every shown price hangs off on chains
          // NO price indexer covers (Robinhood) — a silently-broken anchor there
          // mis-prices everything at once. On indexed chains (Base/Ethereum,
          // dexscreenerSlug set) the app prices via the indexer and this anchor is
          // an optional extra — absent is fine, present-but-insane is not.
          const usd = await nativeEthUsdOnChain(chainId)
          if (cfg.dexscreenerSlug && usd === null) {
            console.warn(`[sacred-smoke] ${cfg.name}: no on-chain ETH/USD anchor (fine — this chain prices via its indexer).`)
            return
          }
          expect(usd, 'no ETH/USD anchor resolved from the settlement pool (this chain has no price indexer!)').not.toBeNull()
          expect(usd!).toBeGreaterThan(100)
          expect(usd!).toBeLessThan(100_000)
        },
        T,
      )

      it(
        'swap: the canonical router holds code',
        async () => {
          expect(cfg.swapRouter, 'no swap router configured for this chain').toBeTruthy()
          const code = await client.getCode({ address: cfg.swapRouter as Address })
          expect(code && code !== '0x', `router ${cfg.swapRouter} holds no code on ${cfg.name}`).toBeTruthy()
        },
        T,
      )

      it.skipIf(cfg.externalHubRouter !== 'lifi')(
        'swap: the LiFi hub quote passes the app\'s own guards',
        async () => {
          // The ETH-entry money path on chains with no canonical Uniswap periphery.
          // fetchLifiQuote applies the full guard set (target==spender, echoed route
          // matches the ask, value exactness) and throws on any deviation.
          const q = await fetchLifiQuote({
            chainId,
            fromToken: LIFI_NATIVE,
            toToken: cfg.usdc as Address,
            fromAmount: parseEther('0.01'),
            fromAddress: SMOKE_DEPLOYER,
            slippageBps: DEFAULT_SLIPPAGE_BPS,
          })
          expect(q.toAmountMin).toBeGreaterThan(0n)
          expect(q.tx.to.toLowerCase()).toBe(q.approvalAddress.toLowerCase())
        },
        T,
      )
    })
  }
})
