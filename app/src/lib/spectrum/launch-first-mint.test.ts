import { describe, expect, it } from 'vitest'
import {
  FIRST_DEPOSIT_REQUIRED,
  MAX_FIRST_MINT_SLIPPAGE_BPS,
  MIN_FIRST_DEPOSIT_USDC,
  MIN_LIQUIDITY,
  NON_ATOMIC_LAUNCH_NOTE,
  SETTLEMENT_TO_BASKET_SCALE,
  firstMintMinOut,
  launchSeedReady,
  launchSplitFromDeployArgs,
  seedLegsForLaunch,
  seedVerdictForLaunch,
} from './launch-first-mint'
import { firstMintSplitFromWeights } from './first-mint-split'
import { decideMintFunding, fundingSplitBpsOf } from './mint-funding'
import type { ContractSplitResult } from './contract-split'
import { encodeMintHookData } from './hook-data'

const w = (...weights: number[]) => weights.map((weight) => ({ weight }))

describe('the deploy-args split — the atomic launch is the ONLY way to build one', () => {
  it('normalises EXACTLY as the read-off-the-basket path does, shape for shape', () => {
    // Not a spot check: the two must agree on every set, which is why one delegates
    // to the other. A divergence here means a second normalisation grew somewhere.
    const sets = [
      [4000, 4000, 2000],
      [10_000],
      [3333, 3333, 3334],
      [1, 9999],
      [5000, 5000],
      [2500, 2500, 2500, 2500],
      [1667, 1667, 1666, 1667, 1667, 1666],
    ]
    for (const weights of sets) {
      const viaBasket = firstMintSplitFromWeights(weights, weights.length)
      const viaDeployArgs = launchSplitFromDeployArgs(w(...weights), weights.length)
      expect(viaDeployArgs).not.toBeNull()
      expect(viaDeployArgs!.splitBps).toEqual(viaBasket!.splitBps)
      expect(viaDeployArgs!.splitBps.reduce((s, x) => s + x, 0)).toBe(10_000)
    }
  })

  it('refuses everything the basket-read path refuses, and for the same inputs', () => {
    const bad: [number[], number][] = [
      [[4000, 4000, 2000], 2], // count mismatch: these weights describe another basket
      [[4000, 4000, 2000], 4],
      [[4000, 0, 6000], 3], // a zero leg would be skipped by the acquire loop
      [[-1, 10_001], 2],
      [[4000.5, 5999.5], 2],
      [[], 0],
    ]
    for (const [weights, legCount] of bad) {
      expect(launchSplitFromDeployArgs(w(...weights), legCount)).toBeNull()
      expect(firstMintSplitFromWeights(weights, legCount)).toBeNull()
    }
  })

  it('a MISMATCHED leg count refuses rather than funding the wrong leg', () => {
    expect(launchSplitFromDeployArgs(w(4000, 4000, 2000), 3)).not.toBeNull()
    expect(launchSplitFromDeployArgs(w(4000, 4000, 2000), 2)).toBeNull()
    expect(launchSplitFromDeployArgs(w(4000, 4000, 2000), 0)).toBeNull()
    expect(launchSplitFromDeployArgs(w(4000, 4000, 2000), 3.5)).toBeNull()
  })

  it('carries its own source literal, so a payload built from it is visibly not a lens answer', () => {
    expect(launchSplitFromDeployArgs(w(6000, 4000), 2)!.source).toBe('deploy-args-weights')
  })
})

describe('unreachable from an ordinary buy — the structural half of the law', () => {
  it('decideMintFunding cannot return the launch case, on ANY input it accepts', () => {
    const contracts: ContractSplitResult[] = [
      { kind: 'ok', legs: [{ splitBps: 4000, floor: 1n }, { splitBps: 6000, floor: 1n }] as never },
      { kind: 'unavailable' },
      { kind: 'unavailable', why: 'unpacked' },
      { kind: 'unavailable', why: 'no-function' },
      { kind: 'unavailable', why: 'read-failed' },
      { kind: 'not-derivable', named: true },
      { kind: 'not-derivable', named: false },
      { kind: 'not-derivable', named: true, firstMint: true },
    ]
    const seeds = [
      null,
      undefined,
      { source: 'basket-design-weights', splitBps: [6000, 4000] } as const,
      { source: 'basket-design-weights', splitBps: [10_000] } as const,
    ]
    for (const contract of contracts) {
      for (const firstMint of [true, false]) {
        for (const seed of seeds) {
          for (const legCount of [1, 2, 3]) {
            const out = decideMintFunding(contract, { legCount, firstMint, firstMintSplit: seed })
            if (out.ok) expect(out.funding.source).not.toBe('deploy-args-weights')
          }
        }
      }
    }
  })

  it('the launch producer takes deploy ARGUMENTS, a shape no buy path holds', () => {
    // A buy knows a deployed address and an amount. Neither is an input here, so
    // there is nothing on a buy path to hand this function.
    expect(launchSplitFromDeployArgs.length).toBe(2)
    // @ts-expect-error a basket address is not deploy arguments
    expect(launchSplitFromDeployArgs('0x0000000000000000000000000000000000000001', 2)).toBeNull()
  })

  it('the split still reaches the floor derivation once it IS built', () => {
    const split = launchSplitFromDeployArgs(w(4000, 4000, 2000), 3)!
    expect(fundingSplitBpsOf({ source: 'deploy-args-weights', splitBps: split.splitBps })).toEqual([4000, 4000, 2000])
  })
})

describe('the encoder holds the launch case to the first mint’s own edges', () => {
  const quoted = [1_000n, 1_000n, 1_000n]

  it('encodes a well-formed launch split', () => {
    const out = encodeMintHookData({
      quotedLegAmounts: quoted,
      slippageBps: 300,
      minOut: 1n,
      funding: { source: 'deploy-args-weights', splitBps: [4000, 4000, 2000] },
    })
    expect(out.splitBps).toEqual([4000, 4000, 2000])
    expect(out.legMins.every((m) => m > 0n)).toBe(true)
  })

  it('refuses a launch split that leaves a holding unfunded', () => {
    expect(() =>
      encodeMintHookData({
        quotedLegAmounts: quoted,
        slippageBps: 300,
        minOut: 1n,
        funding: { source: 'deploy-args-weights', splitBps: [5000, 5000, 0] },
      }),
    ).toThrow(/cannot leave a holding unfunded/)
  })

  it('refuses a launch split that does not divide the whole buy', () => {
    expect(() =>
      encodeMintHookData({
        quotedLegAmounts: quoted,
        slippageBps: 300,
        minOut: 1n,
        funding: { source: 'deploy-args-weights', splitBps: [4000, 4000, 1000] },
      }),
    ).toThrow(/divide the whole buy/)
  })

  it('refuses a launch split of the wrong length', () => {
    expect(() =>
      encodeMintHookData({
        quotedLegAmounts: quoted,
        slippageBps: 300,
        minOut: 1n,
        funding: { source: 'deploy-args-weights', splitBps: [6000, 4000] },
      }),
    ).toThrow(/does not match this basket/)
  })
})

describe('the seed guard, finally called on something', () => {
  const legs = [
    { symbol: 'THIN', depthUsd: 2 },
    { symbol: 'B', depthUsd: 4_000_000 },
    { symbol: 'C', depthUsd: 4_000_000 },
  ]
  const split = [4000, 4000, 2000]

  it('splits the deposit across legs the way the payload will fund them', () => {
    expect(seedLegsForLaunch(legs, split, 10_000)).toEqual([
      { symbol: 'THIN', seedUsd: 4_000, depthUsd: 2 },
      { symbol: 'B', seedUsd: 4_000, depthUsd: 4_000_000 },
      { symbol: 'C', seedUsd: 2_000, depthUsd: 4_000_000 },
    ])
  })

  it('a leg count that does not describe the split judges NOTHING rather than guessing', () => {
    expect(seedLegsForLaunch(legs, [5000, 5000], 10_000)).toEqual([])
    expect(seedLegsForLaunch(legs, split, 0)).toEqual([])
    expect(seedLegsForLaunch(legs, split, Number.NaN)).toEqual([])
  })

  it('a BLOCK verdict stops the launch, and no acknowledgement can arm it', () => {
    const verdict = seedVerdictForLaunch(legs, split, 10_000)
    expect(verdict.blocked).toBe(true)
    expect(verdict.needsAck).toBe(false) // nothing to acknowledge: it does not proceed
    expect(launchSeedReady({ depositUsd: 10_000, verdict, acknowledged: false })).toBe(false)
    expect(launchSeedReady({ depositUsd: 10_000, verdict, acknowledged: true })).toBe(false)
  })

  it('a WARN verdict does NOT stop the launch, it asks to be acknowledged', () => {
    // 30% of a shallow-but-real pool: the seed moves the price it fills at.
    const warnLegs = [
      { symbol: 'A', depthUsd: 10_000 },
      { symbol: 'B', depthUsd: 4_000_000 },
    ]
    const verdict = seedVerdictForLaunch(warnLegs, [5000, 5000], 6_000)
    expect(verdict.blocked).toBe(false)
    expect(verdict.verdicts.some((v) => v.severity === 'warn')).toBe(true)
    expect(verdict.needsAck).toBe(true)
    expect(launchSeedReady({ depositUsd: 6_000, verdict, acknowledged: false })).toBe(false)
    expect(launchSeedReady({ depositUsd: 6_000, verdict, acknowledged: true })).toBe(true)
  })

  it('a clean seed needs no acknowledgement at all', () => {
    const clean = [
      { symbol: 'A', depthUsd: 4_000_000 },
      { symbol: 'B', depthUsd: 4_000_000 },
    ]
    const verdict = seedVerdictForLaunch(clean, [5000, 5000], 1_000)
    expect(verdict).toMatchObject({ blocked: false, needsAck: false, verdicts: [] })
    expect(launchSeedReady({ depositUsd: 1_000, verdict, acknowledged: false })).toBe(true)
  })

  it('the deposit is REQUIRED and the contract minimum is the floor', () => {
    expect(FIRST_DEPOSIT_REQUIRED).toBe(true)
    const verdict = seedVerdictForLaunch([{ symbol: 'A', depthUsd: 1e9 }], [10_000], 1)
    expect(launchSeedReady({ depositUsd: 0, verdict, acknowledged: true })).toBe(false)
    expect(launchSeedReady({ depositUsd: MIN_FIRST_DEPOSIT_USDC - 1, verdict, acknowledged: true })).toBe(false)
    expect(launchSeedReady({ depositUsd: MIN_FIRST_DEPOSIT_USDC, verdict, acknowledged: true })).toBe(true)
  })
})

describe('the aggregate floor mirrors the contract’s own belt', () => {
  it('is exactly the shares a mint at the FirstMintUnderValued boundary yields', () => {
    const net = 99_000_000n // $99 net of a 1% fee on a $100 deposit
    const guaranteed = (net * (10_000n - MAX_FIRST_MINT_SLIPPAGE_BPS)) / 10_000n
    expect(firstMintMinOut(net)).toBe(guaranteed * SETTLEMENT_TO_BASKET_SCALE - MIN_LIQUIDITY)
  })

  it('is never zero and never negative — a zero floor is no floor', () => {
    expect(firstMintMinOut(0n)).toBeNull()
    expect(firstMintMinOut(-1n)).toBeNull()
    expect(firstMintMinOut(1n)).toBeNull() // 1 unit of settlement cannot clear MIN_LIQUIDITY
    expect(firstMintMinOut(10_000_000n)).toBeGreaterThan(0n)
  })

  it('rises with the deposit', () => {
    expect(firstMintMinOut(20_000_000n)!).toBeGreaterThan(firstMintMinOut(10_000_000n)!)
  })
})

describe('the sentence a non-batching wallet is shown', () => {
  it('is plain: no em dashes, no jargon, and it says what to do', () => {
    expect(NON_ATOMIC_LAUNCH_NOTE).not.toMatch(/—/)
    expect(NON_ATOMIC_LAUNCH_NOTE).not.toMatch(/atomic|batch|EIP|5792|nonce|calldata|bps/i)
    expect(NON_ATOMIC_LAUNCH_NOTE).toMatch(/Buying first closes it\.$/)
  })
})
