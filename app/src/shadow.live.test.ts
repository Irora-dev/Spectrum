import { describe, expect, it } from 'vitest'
import { createPublicClient, http, zeroAddress, type Address } from 'viem'
import { base } from 'viem/chains'
import { assembleBatchBuy } from './lib/spectrum/assemble-batch'
import { runShadowPass, shadowSummary, type ShadowRecord } from './lib/spectrum/shadow-pipeline'
import { deploymentFor } from './lib/chain/deployments'
import { Venue, type PoolKey } from './lib/pools/types'
import type { PlanLegInput } from './lib/spectrum/plan-legs'
import type { StorageLike } from './lib/spectrum/allocation'

// node's fs, reached past the browser-shaped tsconfig (src has no node types;
// the literal-free specifier skips TS module resolution — vitest resolves it
// at runtime). Only the four calls this file makes are typed.
type MiniFs = {
  existsSync(p: string): boolean
  mkdirSync(p: string, o: { recursive: boolean }): void
  readFileSync(p: string, e: string): string
  writeFileSync(p: string, v: string): void
}
const fsP = import('node' + ':fs') as unknown as Promise<MiniFs>

// ─────────────────────────────────────────────────────────────────────────────
// SHADOW MODE, RUNNING (§6b — the silent real-pipeline pass; certainty item 3).
//
// `npm run shadow:pass` — the fourth live mode beside sacred/rehearsal/verify.
// It drives the REAL pipeline (plan → floors → compose) over a fixed shadow
// portfolio, eth_calls the EXACT bytes the runner would sign against the LIVE
// chain as a throwaway observer, and appends the honest classification to a
// FILE-BACKED log that persists across runs (app/.shadow/log.jsonl —
// git-ignored; evidence, not source). A DIVERGENCE FAILS THE RUN, so the
// scheduler surfaces red instead of a log line nobody reads.
//
// WHAT REALITY VOTES ON here: the deployed batcher accepting our composition
// end-to-end — ABI drift, revert-shape drift, a redeploy nobody told us
// about, hostile RPC answers. would-have-refused (e.g. the observer holds no
// funding) is a PIPELINE outcome and counts as healthy.
//
// STATED RESIDUAL: the shadow portfolio's prices/liquidity are FIXED, not
// live reads — so this proves the chain seam, not the pricing seam. Upgrading
// to live reads means teaching the runner's data layer to run headless; worth
// it, not this commit.
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = import.meta.env.MODE === 'shadow'
const T = 120_000
const OBSERVER = '0x1111111111111111111111111111111111111111' as Address
const KEY: PoolKey = { currency0: zeroAddress, currency1: '0x4200000000000000000000000000000000000006', fee: 3000, tickSpacing: 60, hooks: zeroAddress }

/** Real Base assets, plausible static marks — the chain seam is the subject. */
const SHADOW_TARGETS: PlanLegInput[] = [
  { symbol: 'AERO', asset: '0x940181a94a35a4569e4529a3cdfb74e38fd98631', decimals: 18, weightPct: 40, priceUsd: 1.2, priceAgeMs: 5_000, liquidityUsd: 5_000_000, buyTokenTaxBps: 0, route: { venue: Venue.V4, ethPool: KEY, v3Fee: 3000, v2Pair: zeroAddress } },
  { symbol: 'DEGEN', asset: '0x4ed4e862860bed51a9570b96d89af5e1b0efefed', decimals: 18, weightPct: 35, priceUsd: 0.004, priceAgeMs: 5_000, liquidityUsd: 2_000_000, buyTokenTaxBps: 0, route: { venue: Venue.V4, ethPool: KEY, v3Fee: 3000, v2Pair: zeroAddress } },
  { symbol: 'WELL', asset: '0xa88594d404727625a9437c3f886c7643872296ae', decimals: 18, weightPct: 25, priceUsd: 0.03, priceAgeMs: 5_000, liquidityUsd: 1_000_000, buyTokenTaxBps: 0, route: { venue: Venue.V4, ethPool: KEY, v3Fee: 3000, v2Pair: zeroAddress } },
]

/** The persistent log: a file wearing the StorageLike coat, so the module's
 *  own append/load/summary run unchanged. Lives in app/.shadow (git-ignored —
 *  evidence, not source); vitest's cwd is app/. */
async function fileStorage(dir: string): Promise<StorageLike> {
  const fs = await fsP
  fs.mkdirSync(dir, { recursive: true })
  const keyPath = (k: string) => `${dir}/${k.replace(/[^a-z0-9-]/gi, '_')}.json`
  return {
    getItem: (k: string) => (fs.existsSync(keyPath(k)) ? fs.readFileSync(keyPath(k), 'utf8') : null),
    setItem: (k: string, v: string) => fs.writeFileSync(keyPath(k), v),
    removeItem: () => {},
  } as unknown as StorageLike
}

describe.skipIf(!LIVE)('SHADOW PASS — the real pipeline against the live chain, recorded', () => {
  it(
    'composes the shadow portfolio, eth_calls the exact bytes, and the outcome is never a divergence',
    async (ctx) => {
      const dep = deploymentFor(8453)
      // THE THIRD STATE (the A1 lesson, applied): until a batcher is seated in
      // deployments.json there is nothing to shadow. Failing red forever would
      // train everyone to ignore the red; passing green would be a banner. So
      // NOT ARMED skips loudly — and the day the batcher seats, this arms
      // itself with no further wiring.
      if (!dep.batcher) {
        console.log('SHADOW NOT ARMED: no batcher seated in deployments.json — arms automatically when one is')
        ctx.skip()
        return
      }

      const out = assembleBatchBuy({
        chainId: 8453,
        targets: SHADOW_TARGETS,
        grossCents: 100_000, // $1,000, shadow money
        fundingTotalRaw: 350_000_000_000_000_000n, // ~$1k of ETH at ~$3k — inside the M7 band
        fundingAsset: zeroAddress,
        account: OBSERVER,
        deadlineSec: Math.floor(Date.now() / 1000) + 600,
        slippageBps: 100,
        hopReserveUsd: 10_000_000,
        hubUsd: 3_000,
        settlementDecimals: 6,
        integrator: zeroAddress,
      })

      const client = createPublicClient({ chain: base, transport: http() })
      const store = await fileStorage('.shadow')
      const rec: ShadowRecord = await runShadowPass({
        // the cast collapses viem's dual type identity under the project-ref
        // split (same package, two resolution paths) — runtime is one object
        client: client as never,
        batcher: dep.batcher as Address,
        account: OBSERVER,
        composed: out.composed,
        intent: 'create',
        nowMs: () => Date.now(),
        storage: store,
      })

      // would-have-signed and would-have-refused are both HEALTH (the observer
      // holds nothing, so a refusal is the pipeline working). A divergence is
      // the one outcome that means our picture of the chain is wrong.
      expect(rec.outcome, `${rec.outcome}: ${'reason' in rec ? rec.reason : ''}`).not.toBe('divergence')

      const sum = shadowSummary(store)
      expect(sum.rows).toBeGreaterThan(0)
      console.log(`shadow: ${rec.outcome} · log now ${sum.rows} record(s), ${sum.divergences} divergence(s)`)
    },
    T,
  )
})
