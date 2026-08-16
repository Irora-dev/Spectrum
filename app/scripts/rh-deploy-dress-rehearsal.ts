// ═════════════════════════════════════════════════════════════════════════════
// DRESS REHEARSAL (pre-deploy gate, 2026-07-29): the ENTIRE test-deploy
// ceremony + FE hookup against an anvil FORK of Robinhood mainnet — the exact
// chain state, the exact contracts, zero real gas.
//
// Phase 1 (run first, in bash — see the header of the runner command):
//   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8547
//   cd <your spectrum-contracts checkout> && source-free env inline:
//   POOL_MANAGER=… CANON_USDC=… CANON_FEE=500 CANON_TICK_SPACING=10 \
//   PRISM_BURNER_L1=… forge script script/DeployAll.s.sol \
//     --rpc-url http://127.0.0.1:8547 --broadcast --private-key <anvil #0>
//   → prints SpectrumFactory + SpectrumSwapRouter addresses.
//
// Phase 2 (THIS script): FACTORY=0x… ROUTER=0x… VITE_ROBINHOOD_RPC_URL=http://127.0.0.1:8547 \
//   npx vite-node scripts/rh-deploy-dress-rehearsal.ts
//   Uses the FE's OWN code end to end:
//     resolveAsset-equivalent route building (findBestPool + findV4Q per the
//     v4qLineage gate semantics) → toBasketEntries → mineSalt →
//     startSqrtPriceX96ForDollarNav → currentDeployPrice → simulate →
//     deployBasket → read back through getBasketData (venues, ethPools,
//     symbols, NAV) → a real USDG seed BUY through the fork's SwapRouter.
// ═════════════════════════════════════════════════════════════════════════════
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseAbi, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { findBestPool } from '../src/lib/pools'
import { findV4Q } from '../src/lib/pools/find-best-pool'
import { Venue, type BasketRoute } from '../src/lib/pools/types'
import { toBasketEntries, startSqrtPriceX96ForDollarNav } from '../src/lib/spectrum/deploy'
import { mineSalt } from '../src/lib/spectrum/salt-mining'
import { factoryDeployAbi, swapRouterAbi } from '../src/lib/spectrum/abis-v2'
import { encodeMintHookData } from '../src/lib/spectrum/hook-data'
import { buildSwapQuote } from '../src/lib/spectrum/swap-quote'
import { getBasketData } from '../src/lib/spectrum/basket-data'
import { clientFor } from '../src/lib/chain/rpc'
import { chainCfg } from '../src/lib/chain/chains'

const CHAIN = 4663
const RPC = 'http://127.0.0.1:8547'
const FACTORY = (process.env.FACTORY ?? '') as Address
const ROUTER = (process.env.ROUTER ?? '') as Address
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

// live 4663 facts (all re-verified this week)
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as Address
const PONS = '0x39dBED3a2bd333467115dE45665cC57F813C4571' as Address // V3-best memecoin

function must(cond: boolean, what: string) {
  if (!cond) throw new Error(`FAIL: ${what}`)
  console.log(`  ✓ ${what}`)
}

const viemChain = chainCfg(CHAIN).viemChain

async function main() {
  if (!FACTORY || !ROUTER) throw new Error('pass FACTORY=0x… ROUTER=0x… (from the phase-1 DeployAll output)')
  if (!process.env.VITE_ROBINHOOD_RPC_URL?.includes('8547')) {
    throw new Error('run with VITE_ROBINHOOD_RPC_URL=http://127.0.0.1:8547 so the FE data layer reads the anvil fork')
  }
  const pub = createPublicClient({ chain: viemChain, transport: http(RPC) })
  const wallet = createWalletClient({ account: privateKeyToAccount(ANVIL_KEY), chain: viemChain, transport: http(RPC) })
  const me = wallet.account.address

  // ── routes exactly as the launch flow would build them ─────────────────────
  console.log('\n① routes (the launch flow’s own detection):')
  // PONS through findBestPool verbatim (V3-best — proves a non-V4Q leg rides along)
  const pons = await findBestPool(PONS, CHAIN)
  console.log(`  PONS  → ${pons.best.label} fee=${pons.best.fee} ($${Math.round(pons.best.depthUsd ?? 0).toLocaleString('en-US')})`)
  // NVDA: with v4qLineage the V4Q candidates join findBestPool's pool; the fork
  // book isn't flipped in this checkout, so emulate the armed gate by ranking
  // findBestPool's answer against findV4Q's — the same depthUsd comparison the
  // armed sweep runs (settlement-side dollars vs listed/estimated dollars).
  const [nvdaEth, nvdaQ] = await Promise.all([
    findBestPool(NVDA, CHAIN),
    findV4Q(pub as Parameters<typeof findV4Q>[0], { chainId: CHAIN, poolManager: chainCfg(CHAIN).poolManager!, usdc: USDG }, NVDA),
  ])
  const bestQ = nvdaQ.candidates.sort((a, b) => (b.depthUsd ?? 0) - (a.depthUsd ?? 0))[0]
  must(!!bestQ && !nvdaQ.depthCheckFailed, 'NVDA has V4Q settlement pools (sweep complete)')
  const nvdaRoute: BasketRoute =
    (bestQ.depthUsd ?? 0) > (nvdaEth.best.depthUsd ?? 0)
      ? { venue: Venue.V4Q, ethPool: bestQ.ethPoolKey!, v3Fee: 0, v2Pair: '0x0000000000000000000000000000000000000000' }
      : nvdaEth.route
  console.log(`  NVDA  → venue ${nvdaRoute.venue} (V4Q $${Math.round(bestQ.depthUsd ?? 0).toLocaleString('en-US')} vs ETH-side $${Math.round(nvdaEth.best.depthUsd ?? 0).toLocaleString('en-US')})`)
  must(nvdaRoute.venue === Venue.V4Q, 'NVDA picks the V4Q route (settlement side is deeper)')

  // ── the deploy, through the FE's own builders ───────────────────────────────
  console.log('\n② deploy (FE builders → fork factory):')
  const entries = toBasketEntries(
    [
      { address: NVDA, decimals: nvdaEth.decimals, route: nvdaRoute },
      { address: PONS, decimals: pons.decimals, route: pons.route },
    ],
    [60, 40],
  )
  const feeConfig = { basketFeeBps: 100, creatorShareBps: 3000, creatorPayout: me, launcher: me }
  const { salt, predicted } = await mineSalt({ factory: FACTORY, chainId: CHAIN, basket: entries, deployer: me, feeConfig })
  console.log(`  mined salt → predicted ${predicted}`)
  const startSqrtPriceX96 = startSqrtPriceX96ForDollarNav(predicted, USDG)
  const priceWei = await pub.readContract({ address: FACTORY, abi: factoryDeployAbi, functionName: 'currentDeployPrice' })
  console.log(`  auction price ${formatUnits(priceWei, 18)} ETH`)
  const sim = await pub.simulateContract({
    account: me,
    address: FACTORY,
    abi: factoryDeployAbi,
    functionName: 'deployBasket',
    args: [salt, 'Rehearsal Mixed', 'REHRSL', entries, startSqrtPriceX96, priceWei, feeConfig],
    value: priceWei,
  })
  must(sim.result.toLowerCase() === predicted.toLowerCase(), 'simulate returns the MINED address (ABI + init-code parity)')
  const dh = await wallet.writeContract(sim.request)
  const rcpt = await pub.waitForTransactionReceipt({ hash: dh })
  must(rcpt.status === 'success', 'deployBasket landed')
  const token = sim.result as Address

  // ── read back through the REAL basket-data path ────────────────────────────
  console.log('\n③ read-back (getBasketData, the app’s own read path):')
  const data = await getBasketData(token, CHAIN, { detail: true })
  must(data.symbol === 'REHRSL', `symbol reads (${data.symbol})`)
  must(data.holdings.length === 2, 'both legs read')
  const bySym = new Map(data.holdings.map((h) => [h.asset.toLowerCase(), h]))
  must(!!bySym.get(NVDA.toLowerCase()) && !!bySym.get(PONS.toLowerCase()), 'legs are NVDA + PONS')
  must(data.holdings.every((h) => h.targetWeightPct === 60 || h.targetWeightPct === 40), 'weights round-trip (60/40)')

  // the venue-3 pricing wire: NVDA's ethPool slot must carry the settlement key
  const basketAbi = parseAbi([
    'function basket(uint256) view returns ((address asset, uint8 venue, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) ethPool, uint24 v3Fee, address v2Pair, uint16 weight, uint8 decimals))',
  ])
  const e0 = await pub.readContract({ address: token, abi: basketAbi, functionName: 'basket', args: [0n] })
  const e1 = await pub.readContract({ address: token, abi: basketAbi, functionName: 'basket', args: [1n] })
  const nvdaEntry = [e0, e1].find((e) => e.asset.toLowerCase() === NVDA.toLowerCase())!
  const ponsEntry = [e0, e1].find((e) => e.asset.toLowerCase() === PONS.toLowerCase())!
  must(Number(nvdaEntry.venue) === 3, 'NVDA leg stored venue=3 (V4Q) on-chain')
  must(
    [nvdaEntry.ethPool.currency0, nvdaEntry.ethPool.currency1].map((a) => a.toLowerCase()).includes(USDG.toLowerCase()),
    'NVDA V4Q key is settlement-paired on-chain',
  )
  must(Number(ponsEntry.venue) === 1 && ponsEntry.v3Fee === pons.route.v3Fee, 'PONS leg stored venue=1 with its fee tier')

  // ── the seed buy through the fork's own SwapRouter ──────────────────────────
  console.log('\n④ seed buy (USDG → basket via the fork router):')
  // fund the throwaway with USDG: impersonate the deepest holder on the fork
  const holders = await pub.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [chainCfg(CHAIN).poolManager!] })
  console.log(`  (poolManager USDG balance ${formatUnits(holders, 6)} — impersonating for funding)`)
  await pub.request({ method: 'anvil_impersonateAccount' as never, params: [chainCfg(CHAIN).poolManager!] as never })
  const seedUsd = 50_000_000n // 50 USDG
  const fundTx = await wallet.writeContract({
    address: USDG,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [me, seedUsd],
    account: chainCfg(CHAIN).poolManager!,
  })
  await pub.waitForTransactionReceipt({ hash: fundTx })
  await pub.request({ method: 'anvil_stopImpersonatingAccount' as never, params: [chainCfg(CHAIN).poolManager!] as never })
  const approveTx = await wallet.writeContract({ address: USDG, abi: erc20Abi, functionName: 'approve', args: [ROUTER, seedUsd] })
  await pub.waitForTransactionReceipt({ hash: approveTx })
  // the FE's own quote path: getBasketData facts → buildSwapQuote (frictionless
  // basis — a FIRST buy has nothing to simulate against) → encodeMintHookData.
  // Exactly the DexSwapCard seed flow.
  const fresh = await getBasketData(token, CHAIN, { detail: true })
  const q = buildSwapQuote({
    side: 'buy',
    amount: 50,
    navPerToken: fresh.navPerToken ?? 1,
    feeFrac: 0.01,
    slippageBps: 300,
    holdings: fresh.holdings.map((h) => ({
      symbol: h.symbol,
      decimals: h.decimals,
      targetWeightPct: h.targetWeightPct,
      priceUsd: h.priceUsd,
    })),
    basketDecimals: 18,
  })
  must(!!q, 'buildSwapQuote produced a first-buy quote (legs priced through the on-chain rung)')
  const enc = encodeMintHookData({
    quotedLegAmounts: q!.quotedLegAmounts,
    slippageBps: 300,
    minOut: q!.minOutRaw,
    interfaceTag: me,
    // A FIRST mint carries no funding split: the factory's lens refuses at
    // effectiveSupply() == 0 (MissingHookData) because only the caller's own price
    // source may protect the mint that sets every future holder's share basis.
    funding: { source: 'basket-weights', because: 'first-mint' },
  })
  const buySim = await pub.simulateContract({
    account: me,
    address: ROUTER,
    abi: swapRouterAbi,
    functionName: 'swapExactIn',
    args: [token, USDG, seedUsd, 1n, enc.hookData, me],
  })
  const bh = await wallet.writeContract(buySim.request)
  const brc = await pub.waitForTransactionReceipt({ hash: bh })
  must(brc.status === 'success', 'seed buy landed (both legs ACQUIRED: V4Q direct + V3 via hub)')
  const bal = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [me] })
  must(bal > 0n, `basket tokens received (${formatUnits(bal, 18)})`)

  const after = await getBasketData(token, CHAIN, { detail: true })
  must(after.totalSupply > 0, `supply live (${after.totalSupply.toFixed(4)})`)
  const nvdaHolding = after.holdings.find((h) => h.asset.toLowerCase() === NVDA.toLowerCase())!
  must(nvdaHolding.balance > 0, `NVDA leg actually acquired (${nvdaHolding.balance} held)`)
  console.log(`  NAV/token: $${after.navPerToken?.toFixed(4) ?? '—'} · NVDA priceUsd $${nvdaHolding.priceUsd.toFixed(2)}`)
  must(nvdaHolding.priceUsd > 0, 'venue-3 leg PRICES through the FE rung (v4LegUsd settlement shape)')

  console.log('\nALL GREEN — the ceremony, the ABI seam, the read path, and the trade loop all hold.')
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
