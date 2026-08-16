// ─────────────────────────────────────────────────────────────────────────────
// ⚠ REHEARSAL — the 4663 FORK, never the real chain. Nothing here may be
// filed as a live record; every figure below is REHEARSAL-stamped.
//
// Proving-matrix rows 1/1b driven as a REHEARSAL (contracts stood the fork up
// 2026-08-04: the real batcher deployed against forked Robinhood state with 13
// seeded baskets) — so the first run against the REAL ceremony becomes a
// re-run. What this file measures, with MY OWN encoder (the app's modules,
// not re-implemented checks):
//
//   1. THE DISCIPLINE GATE — the fork shares chain id 4663 with the real
//      chain, so a chain-id check cannot tell them apart. web3_clientVersion
//      MUST answer anvil/…; nitro/… is Robinhood mainnet with real money and
//      this suite refuses to continue.
//   2. Deployed sanity read through my ABI (poolManager, NoLegs liveness).
//   3. THE FEE BASIS TRIPWIRE (readiness 1d): a known pull's feeEth must equal
//      the regime-1 formula EXACTLY, in raw (readiness 1e: never dollars).
//   4. The byte matrix row: my composed bytes execute, the recipient's balance
//      moves by ≥ the floor I composed, conservation holds.
//   5. Row 1c: a REAL non-zero-integrator batch accrues a claimable fee (the
//      class their fee-split bug hid from green suites).
//   6. The RequiredLegFailed shape, measured against the deployed contract —
//      my client-side decode guess verified or corrected by evidence.
//   7. The slippage evidence table (sizes vs price impact on a real seeded
//      basket) — the measurement the slippage-default proposal cites.
//
//   npm run rehearse:4663      (plain `vitest run` skips this file)
//
// Restand if gone (contracts' runbook): anvil --fork-url <ALCHEMY ARCHIVE> \
//   --port 8550 --silent &   — then redeploy the batcher or ping contracts.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeAll, describe, expect, it } from 'vitest'
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  parseAbi,
  parseEther,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { BATCH_FEE_BPS } from './lib/spectrum/allocation'
import { asFundingRaw, batcherAbi, composeBatchBuy, type BatchSimResult, type ComposedBatchBuy } from './lib/spectrum/batcher'
import { revertDataOf } from './lib/spectrum/decode-revert'

const LIVE = import.meta.env.MODE === 'rehearsal'
const T = 120_000

const RPC = 'http://127.0.0.1:8550'
const CHAIN_ID = 4663
// contracts' desk note, 2026-08-04 16:16 — the fork deployment
const BATCHER = '0x0fe4223AD99dF788A6Dcad148eB4086E6389cEB6' as Address
const EXPECTED_POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951'
const REVVED_BASKET = '0x9d95b0E6b63BD0cD7f8F69f945E41B24c1864088' as Address
const NO_LEGS_SELECTOR = '0x9528138c'
// anvil's canonical #0 key — REHEARSAL money on a fork, worthless anywhere real
const ANVIL0 = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')

const chain = {
  id: CHAIN_ID,
  name: 'REHEARSAL-4663 (anvil fork)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const

const pub = createPublicClient({ chain, transport: http(RPC) })
const wallet = createWalletClient({ chain, transport: http(RPC), account: ANVIL0 })

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
])
const batcherViews = parseAbi(['function poolManager() view returns (address)'])
const requiredLegFailedAbi = parseAbi(['error RequiredLegFailed(uint256 index)'])

/** One basket leg spending the whole spendable of `totalRaw` native. */
function composeOneBasketLeg(totalRaw: bigint, opts: { quotedOutRaw: bigint; slippageBps: number; hubMinOutRaw: bigint; deadlineSec: number; integrator?: Address; minOutOverride?: bigint }): ComposedBatchBuy {
  const spendable = totalRaw - (totalRaw * BigInt(BATCH_FEE_BPS)) / 10_000n
  const composed = composeBatchBuy({
    chainId: CHAIN_ID,
    legs: [
      {
        symbol: 'REVVED',
        asset: REVVED_BASKET,
        route: 'basket',
        budgetRaw: asFundingRaw(spendable),
        quotedOutRaw: opts.quotedOutRaw,
        // the legacy haircut law, applied where the floor now arrives —
        // opts.slippageBps is a controlled fixture value (0/50), pre-clamped
        minOutRaw: (opts.quotedOutRaw * BigInt(10_000 - opts.slippageBps)) / 10_000n,
        optional: false,
      },
    ],
    fundingAsset: zeroAddress, // native — the 3.2 critical-path shape
    fundingTotalRaw: asFundingRaw(totalRaw),
    recipient: ANVIL0.address,
    owner: ANVIL0.address,
    deadlineSec: opts.deadlineSec,
    hubMinOutRaw: opts.hubMinOutRaw,
    integrator: opts.integrator ?? zeroAddress,
  })
  if (opts.minOutOverride != null) {
    // drive a deliberate floor breach (the RequiredLegFailed measurement)
    composed.args[0][0].minOut = opts.minOutOverride
  }
  return composed
}

async function ethCallBatch(composed: ComposedBatchBuy): Promise<BatchSimResult> {
  const data = encodeFunctionData({ abi: batcherAbi, functionName: 'batchBuy', args: composed.args })
  const res = await pub.call({ to: BATCHER, data, value: composed.value, account: ANVIL0.address })
  if (!res.data) throw new Error('REHEARSAL: call returned no data')
  return decodeFunctionResult({ abi: batcherAbi, functionName: 'batchBuy', data: res.data }) as BatchSimResult
}

async function deadline(): Promise<number> {
  const block = await pub.getBlock()
  return Number(block.timestamp) + 600
}

/** Pin the NEXT block's timestamp just past the current head and return a
 *  deadline that clock will honor. THE MEASUREMENT THAT FORCED THIS: the fork
 *  head's timestamp sat ~5h ahead of the host's wall clock, and anvil stamped
 *  the execution block with a clock that made a head+600 deadline already
 *  dead — DeadlinePassed() on every send while every eth_call passed. This is
 *  P5's law observed from the other side (a deadline anchored to the wrong
 *  clock reverts); on a live chain the runner re-checks against getBlock at
 *  simulate time, and blocks arrive seconds apart, so the drift class cannot
 *  reach this size. Pinning is a REHEARSAL-only privilege of owning the fork. */
async function pinnedDeadline(): Promise<number> {
  const head = Number((await pub.getBlock()).timestamp)
  const next = head + 30
  await pub.request({ method: 'evm_setNextBlockTimestamp' as never, params: [`0x${next.toString(16)}`] as never })
  return head + 600
}

// measured state shared down the file (tests run serially within the file)
let probed: BatchSimResult | null = null
const PROBE_TOTAL = parseEther('0.01')

describe.skipIf(!LIVE)('REHEARSAL — the deployed batcher on the 4663 fork, driven by my own encoder', () => {
  beforeAll(async () => {
    // ── THE DISCIPLINE GATE. A chain-id check cannot tell this fork from the
    // real chain; the client string can, and nothing runs until it has.
    const version = (await pub.request({ method: 'web3_clientVersion' as never, params: [] as never })) as string
    if (!/anvil/i.test(String(version))) {
      throw new Error(
        `NOT A REHEARSAL: web3_clientVersion answered "${version}" — nitro/* means REAL Robinhood mainnet with real money. Refusing to run.`,
      )
    }
    const id = await pub.getChainId()
    if (id !== CHAIN_ID) throw new Error(`wrong chain: ${id}`)
  }, T)

  it(
    'sanity through MY ABI: poolManager matches, and an empty-legs call reverts NoLegs (selector routed, _validate ran)',
    async () => {
      const pm = await pub.readContract({ address: BATCHER, abi: batcherViews, functionName: 'poolManager' })
      expect(pm.toLowerCase()).toBe(EXPECTED_POOL_MANAGER.toLowerCase())

      const empty = encodeFunctionData({
        abi: batcherAbi,
        functionName: 'batchBuy',
        args: [
          [],
          zeroAddress,
          1n,
          { recipient: ANVIL0.address, deadline: BigInt(await deadline()), hubMinOut: 1n, aggMinBps: 0, feeBps: BATCH_FEE_BPS, integrator: zeroAddress },
        ],
      })
      let data: Hex | null = null
      try {
        await pub.call({ to: BATCHER, data: empty, value: 1n, account: ANVIL0.address })
      } catch (e) {
        data = revertDataOf(e)
      }
      expect(data, 'empty legs must revert').toBeTruthy()
      expect(data!.slice(0, 10)).toBe(NO_LEGS_SELECTOR)
    },
    T,
  )

  it(
    'THE FEE-BASIS TRIPWIRE (readiness 1d): feeEth === floor(pull × 50bps / 10000), measured in RAW off the deployed code',
    async () => {
      const composed = composeOneBasketLeg(PROBE_TOTAL, {
        quotedOutRaw: 1n, // probe floors are permissive — an eth_call signs nothing
        slippageBps: 0,
        hubMinOutRaw: 1n,
        deadlineSec: await deadline(),
      })
      probed = await ethCallBatch(composed)
      // regime 1, the exact integer form — the answer their note read off
      // SpectrumBatcher.sol L352-353, now measured against deployed bytecode
      expect(probed.feeEth).toBe((PROBE_TOTAL * BigInt(BATCH_FEE_BPS)) / 10_000n)
      // conservation in RAW (readiness 1e)
      expect(probed.spentFunding <= PROBE_TOTAL).toBe(true)
      expect(probed.outs.length).toBe(1)
      expect(probed.outs[0] > 0n).toBe(true)
      expect(probed.hubOut > 0n).toBe(true)
      console.log(
        `REHEARSAL fee-basis: pull=${PROBE_TOTAL} feeEth=${probed.feeEth} spentFunding=${probed.spentFunding} hubOut=${probed.hubOut} outs[0]=${probed.outs[0]} ethRefunded=${probed.ethRefunded} usdcRefunded=${probed.usdcRefunded}`,
      )
    },
    T,
  )

  it(
    'THE BYTE MATRIX ROW: my composed bytes EXECUTE — recipient balance moves ≥ the floor I composed, on real floors',
    async () => {
      expect(probed, 'probe must have run').toBeTruthy()
      const quote = probed!.outs[0]
      const composed = composeOneBasketLeg(PROBE_TOTAL, {
        quotedOutRaw: quote, // the measured basis; floors now bite for real
        slippageBps: 50,
        hubMinOutRaw: (probed!.hubOut * 9_950n) / 10_000n,
        deadlineSec: await pinnedDeadline(),
      })
      const minOut = composed.args[0][0].minOut
      const before = await pub.readContract({ address: REVVED_BASKET, abi: erc20, functionName: 'balanceOf', args: [ANVIL0.address] })
      const data = encodeFunctionData({ abi: batcherAbi, functionName: 'batchBuy', args: composed.args })
      const hash = await wallet.sendTransaction({ to: BATCHER, data, value: composed.value })
      const receipt = await pub.waitForTransactionReceipt({ hash })
      expect(receipt.status).toBe('success')
      // forge-sim logs lie on end-revert; a receipt + a re-read do not
      const after = await pub.readContract({ address: REVVED_BASKET, abi: erc20, functionName: 'balanceOf', args: [ANVIL0.address] })
      const delta = after - before
      expect(delta >= minOut).toBe(true)
      console.log(`REHEARSAL byte-matrix: tx=${hash} sharesDelta=${delta} (floor ${minOut}) — MY ENCODER'S BYTES LANDED ON THE DEPLOYED STRUCT`)
    },
    T,
  )

  it(
    'ROW 1c: a REAL non-zero-integrator batch accrues a CLAIMABLE integrator fee (the path their green suites never drove)',
    async () => {
      // MEASURED SEMANTIC (first attempt failed NothingToClaim): the accrual is
      // keyed by the INTEGRATOR — claimIntegratorFees reads
      // integratorAccrual[msg.sender] and `to` is only the payout. So the
      // integrator in BatchParams is a CLAIM IDENTITY the integrator must
      // control, never a passive payout address. The flow's own integrator
      // wiring must use an address Spectrum can send from.
      const integrator = ANVIL0.address
      const payout = '0x2222222222222222222222222222222222222222' as Address
      const probe = composeOneBasketLeg(PROBE_TOTAL, {
        quotedOutRaw: 1n,
        slippageBps: 0,
        hubMinOutRaw: 1n,
        deadlineSec: await deadline(),
        integrator,
      })
      const sim = await ethCallBatch(probe)
      const composed = composeOneBasketLeg(PROBE_TOTAL, {
        quotedOutRaw: sim.outs[0],
        slippageBps: 50,
        hubMinOutRaw: (sim.hubOut * 9_950n) / 10_000n,
        deadlineSec: await pinnedDeadline(),
        integrator,
      })
      const data = encodeFunctionData({ abi: batcherAbi, functionName: 'batchBuy', args: composed.args })
      const hash = await wallet.sendTransaction({ to: BATCHER, data, value: composed.value })
      const receipt = await pub.waitForTransactionReceipt({ hash })
      expect(receipt.status).toBe('success')

      const payoutBefore = await pub.getBalance({ address: payout })
      const claim = await wallet.sendTransaction({
        to: BATCHER,
        data: encodeFunctionData({ abi: batcherAbi, functionName: 'claimIntegratorFees', args: [payout] }),
      })
      const claimReceipt = await pub.waitForTransactionReceipt({ hash: claim })
      expect(claimReceipt.status).toBe('success')
      const claimed = (await pub.getBalance({ address: payout })) - payoutBefore
      // the split their port pinned: INTEGRATOR_SHARE_BPS = 2000 (20% of feeEth)
      const expectedCut = (sim.feeEth * 2_000n) / 10_000n
      console.log(`REHEARSAL integrator: claimed=${claimed} expected 20% of feeEth=${expectedCut} (feeEth=${sim.feeEth})`)
      expect(claimed > 0n, 'the integrator slice must be claimable and non-zero').toBe(true)
      expect(claimed).toBe(expectedCut)
    },
    T,
  )

  it(
    'THE RequiredLegFailed SHAPE, measured: an unmeetable REQUIRED floor reverts with the error my client-side decode expects',
    async () => {
      expect(probed).toBeTruthy()
      const composed = composeOneBasketLeg(PROBE_TOTAL, {
        quotedOutRaw: probed!.outs[0],
        slippageBps: 50,
        hubMinOutRaw: 1n,
        deadlineSec: await deadline(),
        minOutOverride: probed!.outs[0] * 2n, // unmeetable, on a required leg
      })
      const data = encodeFunctionData({ abi: batcherAbi, functionName: 'batchBuy', args: composed.args })
      let revert: Hex | null = null
      try {
        await pub.call({ to: BATCHER, data, value: composed.value, account: ANVIL0.address })
      } catch (e) {
        revert = revertDataOf(e)
      }
      expect(revert, 'an unmeetable required floor must revert').toBeTruthy()
      try {
        const decoded = decodeErrorResult({ abi: requiredLegFailedAbi, data: revert! })
        expect(decoded.errorName).toBe('RequiredLegFailed')
        expect(Number(decoded.args?.[0])).toBe(0)
        console.log(`REHEARSAL RequiredLegFailed: selector ${revert!.slice(0, 10)} decodes with index 0 — my client-side guess is MEASURED CORRECT`)
      } catch {
        throw new Error(
          `REHEARSAL: the revert did NOT decode as RequiredLegFailed(uint256). Actual data: ${revert} — pin the real shape in runner-effects.ts before relying on failedLegIndex.`,
        )
      }
    },
    T,
  )

  it(
    'THE SLIPPAGE EVIDENCE TABLE: price impact by size on a real seeded basket — the measurement the default proposal cites',
    async () => {
      const dl = await deadline()
      const sizes = ['0.003', '0.01', '0.05', '0.2'].map((s) => parseEther(s))
      const rows: { native: string; outsPerEth: number }[] = []
      for (const total of sizes) {
        const sim = await ethCallBatch(
          composeOneBasketLeg(total, { quotedOutRaw: 1n, slippageBps: 0, hubMinOutRaw: 1n, deadlineSec: dl }),
        )
        const spendable = total - (total * BigInt(BATCH_FEE_BPS)) / 10_000n
        rows.push({ native: (Number(total) / 1e18).toFixed(3), outsPerEth: Number(sim.outs[0]) / Number(spendable) })
      }
      const base = rows[0].outsPerEth
      console.log('REHEARSAL slippage evidence (impact vs 0.003-ETH baseline):')
      for (const r of rows) {
        const impactBps = Math.round((1 - r.outsPerEth / base) * 10_000)
        console.log(`  ${r.native} native → ${r.outsPerEth.toExponential(4)} shares/wei-spendable · impact ${impactBps} bps`)
      }
      expect(rows.every((r) => Number.isFinite(r.outsPerEth) && r.outsPerEth > 0)).toBe(true)
    },
    T,
  )
})
