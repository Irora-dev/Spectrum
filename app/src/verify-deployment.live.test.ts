// ─────────────────────────────────────────────────────────────────────────────
// POST-CEREMONY DEPLOYMENT VERIFICATION — read-only, by construction.
//
// The ceremony-evening tool (built 2026-08-05 for the Base batcher ceremony):
// the moment the address exists, this confirms the deployment through MY OWN
// ABI with eth_call ONLY. The discipline here is the INVERSE of the fork
// rehearsal's: that suite refuses any chain that is not a fork; this suite is
// safe on ANY chain — including mainnets — because it holds no signing
// capability at all (no wallet client, no key, no send path is even imported).
// The funded rows (byte matrix with a real send, integrator claim) are 3.2
// canary territory: the owner-driven, small money, never this suite.
//
//   VITE_VERIFY_BATCHER=0x… npm run verify:deployment     (pre-seating)
//   npm run verify:deployment                             (post-seating: reads
//                                                          deployments.json)
//
// The env var here does NOT violate the batcher's no-env S-pin: that pin
// forbids the APP resolving its money target from build environment. This is
// a test verifying a CANDIDATE address before it is seated — the app never
// sees it; seating remains a deployments.json source edit.
//
// Optional deeper row: VITE_VERIFY_BASKET=0x… adds a composed eth_call batchBuy
// against a real basket (fee-basis tripwire on the native path + outs>0),
// still read-only. Without it, identity + liveness rows verify alone.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from 'vitest'
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, parseEther, zeroAddress, type Address, type Hex } from 'viem'
import { base } from 'viem/chains'
import { asFundingRaw, batcherAbi, composeBatchBuy, type BatchSimResult } from './lib/spectrum/batcher'
import { BATCH_FEE_BPS } from './lib/spectrum/allocation'
import { revertDataOf } from './lib/spectrum/decode-revert'
import { deploymentFor } from './lib/chain/deployments'

const LIVE = import.meta.env.MODE === 'verify'
const T = 120_000
const CHAIN_ID = 8453
const NO_LEGS_SELECTOR = '0x9528138c'
const NOTHING_TO_CLAIM_SELECTOR = '0x969bf728'
// a read-only identity for eth_call `from` — never funded, never signs
const OBSERVER = '0x1111111111111111111111111111111111111111' as Address

// the browser tsconfig has no node globals (sacred-smoke's own lesson), so the
// candidate address arrives ONLY as a VITE_-prefixed var through import.meta.env
const envBatcher = import.meta.env.VITE_VERIFY_BATCHER as Address | undefined
const envBasket = import.meta.env.VITE_VERIFY_BASKET as Address | undefined

function target(): Address | null {
  if (envBatcher && /^0x[0-9a-fA-F]{40}$/.test(envBatcher)) return envBatcher
  try {
    return deploymentFor(CHAIN_ID).batcher
  } catch {
    return null
  }
}

const pub = createPublicClient({ chain: base, transport: http() })

describe.skipIf(!LIVE)('BASE BATCHER VERIFICATION — read-only, through my own ABI', () => {
  const BATCHER = target()

  it(
    'a target exists (env candidate pre-seating, deployments.json after)',
    () => {
      expect(
        BATCHER,
        'no batcher to verify: pass VITE_VERIFY_BATCHER=0x… before the seating, or seat deployments.json',
      ).toBeTruthy()
    },
    T,
  )

  it(
    'bytecode is DEPLOYED at the address, and poolManager() matches the app’s own book',
    async () => {
      if (!BATCHER) return
      const code = await pub.getCode({ address: BATCHER })
      expect(code && code.length > 2, 'no bytecode at the address').toBe(true)
      console.log(`VERIFY: runtime ${((code!.length - 2) / 2).toLocaleString()} bytes at ${BATCHER}`)
      const pm = await pub.readContract({
        address: BATCHER,
        abi: [{ type: 'function', name: 'poolManager', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const,
        functionName: 'poolManager',
      })
      const expected = deploymentFor(CHAIN_ID).poolManager
      expect(expected, 'the app book has no poolManager for Base').toBeTruthy()
      expect(pm.toLowerCase()).toBe(expected!.toLowerCase())
      console.log(`VERIFY: poolManager ${pm} matches deployments.json`)
    },
    T,
  )

  it(
    'batchBuy ROUTES through my encoding: an empty-legs call reverts NoLegs (selector + _validate liveness)',
    async () => {
      if (!BATCHER) return
      const data = encodeFunctionData({
        abi: batcherAbi,
        functionName: 'batchBuy',
        args: [
          [],
          zeroAddress,
          1n,
          { recipient: OBSERVER, deadline: 9_999_999_999n, hubMinOut: 1n, aggMinBps: 0, feeBps: BATCH_FEE_BPS, integrator: zeroAddress },
        ],
      })
      let revert: Hex | null = null
      try {
        await pub.call({ to: BATCHER, data, value: 1n, account: OBSERVER })
      } catch (e) {
        revert = revertDataOf(e)
      }
      expect(revert, 'empty legs must revert — a silent success means the selector did not route').toBeTruthy()
      expect(revert!.slice(0, 10)).toBe(NO_LEGS_SELECTOR)
      console.log('VERIFY: NoLegs() liveness — my ABI and the deployed struct agree')
    },
    T,
  )

  it(
    'claimIntegratorFees ROUTES: a fresh integrator reverts NothingToClaim (read-only claim-identity check)',
    async () => {
      if (!BATCHER) return
      const data = encodeFunctionData({ abi: batcherAbi, functionName: 'claimIntegratorFees', args: [OBSERVER] })
      let revert: Hex | null = null
      try {
        await pub.call({ to: BATCHER, data, account: OBSERVER })
      } catch (e) {
        revert = revertDataOf(e)
      }
      expect(revert).toBeTruthy()
      expect(revert!.slice(0, 10)).toBe(NOTHING_TO_CLAIM_SELECTOR)
      console.log('VERIFY: claimIntegratorFees routes; accrual keyed by msg.sender as measured')
    },
    T,
  )

  it(
    'OPTIONAL (VERIFY_BASKET): a composed one-basket-leg batchBuy eth_calls clean — fee basis exact on the native path, outs > 0',
    async () => {
      if (!BATCHER) return
      if (!envBasket || !/^0x[0-9a-fA-F]{40}$/.test(envBasket)) {
        console.log('VERIFY: no VERIFY_BASKET given — composed-call row skipped (identity + liveness rows stand alone)')
        return
      }
      const totalRaw = parseEther('0.002') // eth_call only: nothing is pulled, nothing is signed
      const spendable = totalRaw - (totalRaw * BigInt(BATCH_FEE_BPS)) / 10_000n
      const block = await pub.getBlock()
      const composed = composeBatchBuy({
        chainId: CHAIN_ID,
        legs: [
          { symbol: 'BASKET', asset: envBasket, route: 'basket', budgetRaw: asFundingRaw(spendable), quotedOutRaw: 1n, minOutRaw: 1n, optional: false },
        ],
        fundingAsset: zeroAddress,
        fundingTotalRaw: asFundingRaw(totalRaw),
        recipient: OBSERVER,
        owner: OBSERVER,
        deadlineSec: Number(block.timestamp) + 600,
        hubMinOutRaw: 1n,
        integrator: zeroAddress,
      })
      const data = encodeFunctionData({ abi: batcherAbi, functionName: 'batchBuy', args: composed.args })
      const res = await pub.call({ to: BATCHER, data, value: composed.value, account: OBSERVER })
      expect(res.data, 'the composed call returned no data').toBeTruthy()
      const result = decodeFunctionResult({ abi: batcherAbi, functionName: 'batchBuy', data: res.data! }) as BatchSimResult
      // THE FEE-BASIS TRIPWIRE on the real deployment (native path is exact;
      // settlement path would float with the hub — contracts 2026-08-04 eve)
      expect(result.feeEth).toBe((totalRaw * BigInt(BATCH_FEE_BPS)) / 10_000n)
      expect(result.outs[0] > 0n).toBe(true)
      console.log(
        `VERIFY: composed batchBuy executes in eth_call — feeEth=${result.feeEth} (exact), outs[0]=${result.outs[0]}, hubOut=${result.hubOut}`,
      )
    },
    T,
  )
})
