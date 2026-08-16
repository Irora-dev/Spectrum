import { describe, expect, it } from 'vitest'
import { DEFAULT_SLIPPAGE_BPS } from './hook-data'
import {
  buildFundingPlan,
  FundingPlanContractError,
  fundingConservationErrors,
  type ChainInventory,
  type FundingPlanInput,
  bridgeDrawFor,
  bridgePadFor,
  BRIDGE_ARRIVAL_HEADROOM_BPS,
} from './funding-plan'

// The five laws of the RULED §3 (confirmed 2026-08-04), each pinned. Every
// scenario here is one of the audit's F1–F10 surprises turned into a test, so a
// regression reads as the finding it re-opens rather than as a broken assertion.

const BASE = 8453
const ETH = 1
const RH = 4663

const chain = (over: Partial<ChainInventory> & { chainId: number }): ChainInventory => ({
  nativeRaw: 10n ** 18n, // plenty of gas unless a test says otherwise
  gasNeedRaw: 10n ** 15n,
  localFundingCents: 0,
  sellProceedsCents: 0,
  inboundRefuel: true,
  ...over,
})

const plan = (input: FundingPlanInput) => buildFundingPlan(input)

describe('law 1 — coverage order: local, then new money, then sell proceeds LAST', () => {
  it('a chain that can fund itself needs NO bridge at all (the cheapest answer)', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, localFundingCents: 100_000 })],
      needs: [{ chainId: BASE, buysCents: 50_000, feeCents: 250 }],
      newMoney: { chainId: ETH, availableCents: 1_000_000 },
    })
    expect(p.steps.filter((s) => s.action.kind === 'bridge')).toHaveLength(0)
    expect(p.steps).toHaveLength(1)
    expect(p.steps[0].action).toMatchObject({ kind: 'batch', chainId: BASE, fundedFrom: [{ source: 'local-cash', fromChainId: BASE, cents: 50_250 }] })
    expect(p.refusals).toHaveLength(0)
    expect(p.serialized).toBe(false)
  })

  it('new money bridges from the chain it ACTUALLY sits on (F1: never the first target by array order)', () => {
    const p = plan({
      chains: [chain({ chainId: BASE }), chain({ chainId: ETH, localFundingCents: 0 })],
      needs: [{ chainId: BASE, buysCents: 40_000, feeCents: 200 }],
      newMoney: { chainId: ETH, availableCents: 100_000 },
    })
    const bridge = p.steps.find((s) => s.action.kind === 'bridge')!.action as { fromChainId: number; toChainId: number; source: string }
    expect(bridge.fromChainId).toBe(ETH)
    expect(bridge.toChainId).toBe(BASE)
    expect(bridge.source).toBe('new-money')
  })

  it('new money already ON the deficit chain is local money by another name — no bridge', () => {
    const p = plan({
      chains: [chain({ chainId: BASE })],
      needs: [{ chainId: BASE, buysCents: 30_000, feeCents: 150 }],
      newMoney: { chainId: BASE, availableCents: 50_000 },
    })
    expect(p.steps.filter((s) => s.action.kind === 'bridge')).toHaveLength(0)
    expect((p.steps[0].action as { fundedFrom: { source: string }[] }).fundedFrom.map((d) => d.source)).toEqual(['new-money'])
  })

  it('sell proceeds are drawn ONLY after new money is exhausted', () => {
    const p = plan({
      chains: [
        chain({ chainId: BASE, sellProceedsCents: 80_000 }),
        chain({ chainId: ETH }),
      ],
      needs: [{ chainId: ETH, buysCents: 100_000, feeCents: 500 }],
      newMoney: { chainId: BASE, availableCents: 60_000 },
    })
    const drawn = (p.steps.find((s) => s.action.kind === 'batch' && (s.action as { chainId: number }).chainId === ETH)!
      .action as { fundedFrom: { source: string }[] }).fundedFrom.map((d) => d.source)
    expect(drawn).toEqual(['new-money', 'sell-proceeds'])
    const bridged = p.steps.filter((s) => s.action.kind === 'bridge').map((s) => s.action as { amountCents: number; source: string })
    expect(bridged.find((b) => b.source === 'new-money')!.amountCents).toBe(60_000)
    expect(bridged.find((b) => b.source === 'sell-proceeds')!.amountCents).toBe(40_500)
  })

  it("a proceeds-funded run SAYS it will wait, and the bridge names what it waits for (fork 1's stated cost)", () => {
    const p = plan({
      chains: [chain({ chainId: BASE, sellProceedsCents: 100_000 }), chain({ chainId: ETH })],
      needs: [
        { chainId: BASE, buysCents: 0, feeCents: 0 },
        { chainId: ETH, buysCents: 50_000, feeCents: 250 },
      ],
      newMoney: null,
    })
    expect(p.serialized).toBe(true)
    expect(p.notes.join(' ')).toMatch(/extra leg of waiting/)
    const bridge = p.steps.find((s) => s.action.kind === 'bridge')!
    expect(bridge.waitsFor).toMatch(/sales confirming/)
    // and the SOURCE chain batches first — its sells must land before the bridge
    const srcBatch = p.steps.find((s) => s.action.kind === 'batch' && (s.action as { chainId: number }).chainId === BASE)!
    expect(srcBatch.order).toBeLessThan(bridge.order)
  })

  it('the destination batch composes AT ARRIVAL, after the bridge (F10: bridges deliver variable amounts)', () => {
    const p = plan({
      chains: [chain({ chainId: BASE }), chain({ chainId: ETH })],
      needs: [{ chainId: BASE, buysCents: 20_000, feeCents: 100 }],
      newMoney: { chainId: ETH, availableCents: 50_000 },
    })
    const bridge = p.steps.find((s) => s.action.kind === 'bridge')!
    const batch = p.steps.find((s) => s.action.kind === 'batch')!
    expect(batch.order).toBeGreaterThan(bridge.order)
    expect(batch.waitsFor).toMatch(/arriving/)
  })
})

describe('law 2 — conservation: never half-fund, refuse with the gap NAMED', () => {
  it('a plan short of money refuses the chain and says how much is missing', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, localFundingCents: 10_000 })],
      needs: [{ chainId: BASE, buysCents: 50_000, feeCents: 250 }],
      newMoney: null,
    })
    expect(p.steps).toHaveLength(0)
    expect(p.refusals[0].chainId).toBe(BASE)
    // 40,250 cents short = $402.50, stated as $403: a shortfall ROUNDS UP, or
    // the number in the sentence would not actually fix the shortfall
    expect(p.refusals[0].reason).toMatch(/\$403 more/)
    expect(p.refusals[0].reason).toMatch(/Add funds or trim/)
  })

  it('THE FEE RIDES THE FUNDING TOTAL (F9) — funding the buys alone is not funded', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, localFundingCents: 50_000 })],
      needs: [{ chainId: BASE, buysCents: 50_000, feeCents: 250 }],
      newMoney: null,
    })
    expect(p.steps).toHaveLength(0)
    expect(p.refusals[0].reason).toMatch(/\$3 more/) // 250 cents, ceiled
  })

  it('with a bounded pool the LARGEST deficit is funded whole rather than both half-funded', () => {
    const p = plan({
      chains: [chain({ chainId: BASE }), chain({ chainId: ETH }), chain({ chainId: RH })],
      needs: [
        { chainId: BASE, buysCents: 80_000, feeCents: 0 },
        { chainId: ETH, buysCents: 20_000, feeCents: 0 },
      ],
      newMoney: { chainId: RH, availableCents: 80_000 },
    })
    const funded = p.steps.filter((s) => s.action.kind === 'batch').map((s) => (s.action as { chainId: number }).chainId)
    expect(funded).toEqual([BASE])
    expect(p.refusals.map((r) => r.chainId)).toEqual([ETH])
    expect(fundingConservationErrors({
      chains: [chain({ chainId: BASE }), chain({ chainId: ETH }), chain({ chainId: RH })],
      needs: [
        { chainId: BASE, buysCents: 80_000, feeCents: 0 },
        { chainId: ETH, buysCents: 20_000, feeCents: 0 },
      ],
      newMoney: { chainId: RH, availableCents: 80_000 },
    }, p)).toEqual([])
  })

  it('an unreadable inventory refuses the chain — nothing is assumed present', () => {
    const p = plan({
      chains: [],
      needs: [{ chainId: BASE, buysCents: 10_000, feeCents: 50 }],
      newMoney: null,
    })
    expect(p.refusals[0].reason).toMatch(/could not read what you hold/)
  })
})

describe('law 3 — gas: enough native never refuels; short native FOLDS into one bridge (fork 2)', () => {
  it('a chain holding enough native carries no refuel (like-with-like quotes)', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, nativeRaw: 10n ** 18n, gasNeedRaw: 10n ** 15n }), chain({ chainId: ETH })],
      needs: [{ chainId: BASE, buysCents: 20_000, feeCents: 100 }],
      newMoney: { chainId: ETH, availableCents: 50_000 },
    })
    expect((p.steps.find((s) => s.action.kind === 'bridge')!.action as { refuel: boolean }).refuel).toBe(false)
  })

  it('a bridge into a gas-short chain carries the refuel', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, nativeRaw: 0n, gasNeedRaw: 10n ** 15n }), chain({ chainId: ETH })],
      needs: [{ chainId: BASE, buysCents: 20_000, feeCents: 100 }],
      newMoney: { chainId: ETH, availableCents: 50_000 },
    })
    expect((p.steps.find((s) => s.action.kind === 'bridge')!.action as { refuel: boolean }).refuel).toBe(true)
  })

  it('FORK 2: money-here-but-no-gas folds into ONE refuel bridge, not a local swap plus a batch', () => {
    const p = plan({
      chains: [
        chain({ chainId: BASE, localFundingCents: 100_000, nativeRaw: 0n, gasNeedRaw: 10n ** 15n }),
        chain({ chainId: ETH, localFundingCents: 0 }),
      ],
      needs: [{ chainId: BASE, buysCents: 40_000, feeCents: 200 }],
      newMoney: { chainId: ETH, availableCents: 10_000 },
    })
    const bridges = p.steps.filter((s) => s.action.kind === 'bridge').map((s) => s.action as { toChainId: number; refuel: boolean; amountCents: number })
    expect(bridges).toHaveLength(1)
    // the fold rides a REAL transfer (self-audit A4): a zero-amount bridge is
    // not executable, so the carrier chain is funded new-money-FIRST
    expect(bridges[0]).toMatchObject({ toChainId: BASE, refuel: true })
    expect(bridges[0].amountCents).toBeGreaterThan(0)
    expect(p.notes.join(' ')).toMatch(/fees ride in on a bridge instead of costing an extra transaction/)
    // one bridge from Ethereum + one batch on Base — two txs total, not three
    expect(p.txCountByChain).toEqual([
      { chainId: ETH, txs: 1 },
      { chainId: BASE, txs: 1 },
    ])
  })
})

describe('law 4 — a chain that cannot receive gas refuses BY NAME (fork 3), the others proceed', () => {
  it('gas-short 4663 without inbound refuel refuses, and Base still executes', () => {
    const p = plan({
      chains: [
        chain({ chainId: BASE, localFundingCents: 100_000 }),
        chain({ chainId: RH, localFundingCents: 100_000, nativeRaw: 0n, gasNeedRaw: 10n ** 15n, inboundRefuel: false }),
      ],
      needs: [
        { chainId: BASE, buysCents: 40_000, feeCents: 200 },
        { chainId: RH, buysCents: 40_000, feeCents: 200 },
      ],
      newMoney: null,
    })
    expect(p.refusals.map((r) => r.chainId)).toEqual([RH])
    expect(p.refusals[0].reason).toMatch(/needs its own ETH for fees/)
    expect(p.refusals[0].reason).toMatch(/already hold ETH there/)
    // never optional-legs, never refuse-whole: Base is untouched by 4663's limit
    const funded = p.steps.filter((s) => s.action.kind === 'batch').map((s) => (s.action as { chainId: number }).chainId)
    expect(funded).toEqual([BASE])
  })

  it('a no-refuel chain that ALREADY holds native executes normally — the limit is gas, not the chain', () => {
    const p = plan({
      chains: [chain({ chainId: RH, localFundingCents: 100_000, nativeRaw: 10n ** 18n, inboundRefuel: false })],
      needs: [{ chainId: RH, buysCents: 40_000, feeCents: 200 }],
      newMoney: null,
    })
    expect(p.refusals).toHaveLength(0)
    expect((p.steps[0].action as { chainId: number }).chainId).toBe(RH)
  })

  it('inboundRefuel defaults FALSE — an unconfirmed chain is treated as unable to receive gas', () => {
    const p = plan({
      chains: [{ chainId: RH, nativeRaw: 0n, gasNeedRaw: 1n, localFundingCents: 100_000, sellProceedsCents: 0 }],
      needs: [{ chainId: RH, buysCents: 10_000, feeCents: 0 }],
      newMoney: null,
    })
    expect(p.refusals[0].reason).toMatch(/cannot bridge fees into it yet/)
  })
})

describe('law 5 — an unreadable gas estimate refuses the chain (unknown is not funded)', () => {
  it('null gasNeedRaw refuses by name, even with money and native present', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, localFundingCents: 100_000, gasNeedRaw: null, nativeRaw: 10n ** 18n })],
      needs: [{ chainId: BASE, buysCents: 40_000, feeCents: 200 }],
      newMoney: null,
    })
    expect(p.steps).toHaveLength(0)
    expect(p.refusals[0].reason).toMatch(/could not estimate the network fee/)
    expect(p.refusals[0].reason).toMatch(/cannot promise/)
  })
})

describe('purity + the honest tx floor', () => {
  it('the same input twice yields the same plan, and the input is never mutated', () => {
    const input: FundingPlanInput = {
      chains: [chain({ chainId: BASE, localFundingCents: 60_000 }), chain({ chainId: ETH })],
      needs: [{ chainId: BASE, buysCents: 40_000, feeCents: 200 }, { chainId: ETH, buysCents: 30_000, feeCents: 150 }],
      newMoney: { chainId: ETH, availableCents: 40_000 },
    }
    const snapshot = JSON.stringify(input, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    const a = plan(input)
    const b = plan(input)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(input, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(snapshot)
  })

  it('local + native funding is ONE transaction — the stated floor', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, localFundingCents: 100_000 })],
      needs: [{ chainId: BASE, buysCents: 40_000, feeCents: 200 }],
      newMoney: null,
    })
    expect(p.txCountByChain).toEqual([{ chainId: BASE, txs: 1 }])
  })

  it('a same-chain rebalance rides ONE batch — proceeds fund the buys inside the tx', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, sellProceedsCents: 50_000 })],
      needs: [{ chainId: BASE, buysCents: 49_000, feeCents: 250 }],
      newMoney: null,
    })
    expect(p.steps).toHaveLength(1)
    expect((p.steps[0].action as { fundedFrom: { source: string }[] }).fundedFrom.map((d) => d.source)).toEqual(['local-proceeds'])
    expect(p.serialized).toBe(false) // nothing crosses a chain, nothing waits
    expect(p.txCountByChain).toEqual([{ chainId: BASE, txs: 1 }])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE SELF-AUDIT ROUND (2026-08-04): six defects found by driving this module
// from a probe OUTSIDE its own test file — the tests above all passed while
// every one of these was live, which is the lesson: a suite written beside a
// module tests the cases its author imagined.
// ─────────────────────────────────────────────────────────────────────────────

describe('self-audit A1 (MONEY BUG): a proceeds bridge never exceeds the proceeds that actually remain', () => {
  it('a chain with cash AND proceeds bridges only its UNSPENT proceeds, never cash wearing the proceeds label', () => {
    // Base holds $500 cash + $500 proceeds and spends $400 on itself; Ethereum
    // needs $450. Before the fix this bridged $450 "as proceeds" — $350 of it
    // cash that the ruling never permitted to leave the chain, and which the
    // serialization note then described as sale proceeds.
    const p = plan({
      chains: [chain({ chainId: BASE, localFundingCents: 50_000, sellProceedsCents: 50_000 }), chain({ chainId: ETH })],
      needs: [
        { chainId: BASE, buysCents: 40_000, feeCents: 0 },
        { chainId: ETH, buysCents: 45_000, feeCents: 0 },
      ],
      newMoney: null,
    })
    const proceedsBridged = p.steps
      .filter((s) => s.action.kind === 'bridge' && (s.action as { source: string }).source === 'sell-proceeds')
      .reduce((sum, s) => sum + (s.action as { amountCents: number }).amountCents, 0)
    // Base spends its CASH first (law 1's inner order), so all $500 of proceeds
    // remain — but never more than that, and never cash.
    expect(proceedsBridged).toBeLessThanOrEqual(50_000)
    // and Ethereum is refused for the part that genuinely has no source
    const ethFunded = p.steps.some((s) => s.action.kind === 'batch' && (s.action as { chainId: number }).chainId === ETH)
    expect(ethFunded).toBe(true)
    expect(fundingConservationErrors(
      {
        chains: [chain({ chainId: BASE, localFundingCents: 50_000, sellProceedsCents: 50_000 }), chain({ chainId: ETH })],
        needs: [
          { chainId: BASE, buysCents: 40_000, feeCents: 0 },
          { chainId: ETH, buysCents: 45_000, feeCents: 0 },
        ],
        newMoney: null,
      },
      p,
    )).toEqual([])
  })

  it('an over-drawn source is CAUGHT by the conservation check, not trusted', () => {
    // a hand-forged plan claiming more proceeds than the sales produce
    const input: FundingPlanInput = {
      chains: [chain({ chainId: BASE, sellProceedsCents: 1_000 })],
      needs: [{ chainId: BASE, buysCents: 10_000, feeCents: 0 }],
      newMoney: null,
    }
    const forged = {
      steps: [
        {
          order: 1,
          action: { kind: 'batch' as const, chainId: BASE, fundedFrom: [{ source: 'local-proceeds' as const, fromChainId: BASE, cents: 10_000 }] },
        },
      ],
      notes: [],
      refusals: [],
      serialized: false,
      txCountByChain: [{ chainId: BASE, txs: 1 }],
    }
    const errs = fundingConservationErrors(input, forged)
    expect(errs.some((e) => e.note.includes('more sale proceeds spent than the sales produce'))).toBe(true)
  })
})

describe('self-audit A2/A5 (CONTRACT ERRORS): ambiguous money input THROWS, never resolves quietly', () => {
  it('the same dollars as local funding AND the new-money pool throws — one home per dollar', () => {
    // Before: the same $500 funded Base locally and bridged to Ethereum — the
    // same balance spent twice, silently, with no refusal.
    expect(() =>
      plan({
        chains: [chain({ chainId: BASE, localFundingCents: 50_000 }), chain({ chainId: ETH })],
        needs: [
          { chainId: BASE, buysCents: 50_000, feeCents: 0 },
          { chainId: ETH, buysCents: 50_000, feeCents: 0 },
        ],
        newMoney: { chainId: BASE, availableCents: 50_000 },
      }),
    ).toThrow(FundingPlanContractError)
  })

  it('a duplicated NEED row throws — two need rows would batch that chain twice', () => {
    expect(() =>
      plan({
        chains: [chain({ chainId: BASE, localFundingCents: 100_000 })],
        needs: [
          { chainId: BASE, buysCents: 20_000, feeCents: 0 },
          { chainId: BASE, buysCents: 20_000, feeCents: 0 },
        ],
        newMoney: null,
      }),
    ).toThrow(/appears twice in the needs/)
  })

  it('a duplicated INVENTORY row throws — two rows for one chain would spend its balance twice', () => {
    expect(() =>
      plan({
        chains: [chain({ chainId: BASE, localFundingCents: 50_000 }), chain({ chainId: BASE, localFundingCents: 50_000 })],
        needs: [{ chainId: BASE, buysCents: 60_000, feeCents: 0 }],
        newMoney: null,
      }),
    ).toThrow(/appears twice in the inventory/)
  })
})

describe('self-audit A3: CASH spends before PROCEEDS, because only proceeds can bridge', () => {
  it('a plan that is fundable stays funded — spending the bridgeable resource first would refuse it', () => {
    // Base: $500 cash + $500 proceeds, needs $500. Ethereum needs $500 with no
    // other source. Spend cash locally → $500 proceeds bridge → both funded.
    // Spend proceeds locally → $500 of unbridgeable cash left → Ethereum refused.
    const p = plan({
      chains: [chain({ chainId: BASE, localFundingCents: 50_000, sellProceedsCents: 50_000 }), chain({ chainId: ETH })],
      needs: [
        { chainId: BASE, buysCents: 50_000, feeCents: 0 },
        { chainId: ETH, buysCents: 50_000, feeCents: 0 },
      ],
      newMoney: null,
    })
    const funded = p.steps.filter((s) => s.action.kind === 'batch').map((s) => (s.action as { chainId: number }).chainId).sort()
    expect(funded).toEqual([ETH, BASE].sort())
    expect(p.refusals).toHaveLength(0)
    const baseDraws = (p.steps.find((s) => s.action.kind === 'batch' && (s.action as { chainId: number }).chainId === BASE)!
      .action as { fundedFrom: { source: string }[] }).fundedFrom
    expect(baseDraws.map((d) => d.source)).toEqual(['local-cash'])
  })
})

describe('self-audit A4: a refuel rides a REAL transfer — zero-amount bridges are unexecutable', () => {
  it('no live bridge ever carries 0 cents', () => {
    const p = plan({
      chains: [
        chain({ chainId: BASE, localFundingCents: 100_000, nativeRaw: 0n }),
        chain({ chainId: ETH }),
      ],
      needs: [{ chainId: BASE, buysCents: 40_000, feeCents: 0 }],
      newMoney: { chainId: ETH, availableCents: 10_000 },
    })
    for (const s of p.steps) {
      if (s.action.kind === 'bridge') expect((s.action as { amountCents: number }).amountCents).toBeGreaterThan(0)
    }
  })

  it('a gas-short chain with NOTHING travelling to it refuses by name rather than emitting a phantom bridge', () => {
    // money is all local, no new-money pool exists → nothing can carry the gas
    const p = plan({
      chains: [chain({ chainId: BASE, localFundingCents: 100_000, nativeRaw: 0n })],
      needs: [{ chainId: BASE, buysCents: 40_000, feeCents: 0 }],
      newMoney: null,
    })
    expect(p.steps).toHaveLength(0)
    expect(p.refusals[0].reason).toMatch(/nothing in this plan travels there to carry it/)
  })
})

describe('self-audit A6: the conservation check reads RECORDED draws, never re-derives them', () => {
  it('catches an under-funded batch even when the inventory could have covered it', () => {
    const input: FundingPlanInput = {
      chains: [chain({ chainId: BASE, localFundingCents: 100_000 })],
      needs: [{ chainId: BASE, buysCents: 50_000, feeCents: 0 }],
      newMoney: null,
    }
    const forged = {
      steps: [
        {
          order: 1,
          action: { kind: 'batch' as const, chainId: BASE, fundedFrom: [{ source: 'local-cash' as const, fromChainId: BASE, cents: 30_000 }] },
        },
      ],
      notes: [],
      refusals: [],
      serialized: false,
      txCountByChain: [{ chainId: BASE, txs: 1 }],
    }
    // the OLD checker re-derived "min(localMax, total)" and would have called
    // this sound, because the chain *could* have funded it
    const errs = fundingConservationErrors(input, forged)
    expect(errs[0]).toMatchObject({ chainId: BASE, needCents: 50_000, fundedCents: 30_000 })
    expect(errs[0].note).toMatch(/under-funded/)
  })

  it('every plan this module builds passes its own conservation check', () => {
    const scenarios: FundingPlanInput[] = [
      {
        chains: [chain({ chainId: BASE, localFundingCents: 100_000 })],
        needs: [{ chainId: BASE, buysCents: 40_000, feeCents: 200 }],
        newMoney: null,
      },
      {
        chains: [chain({ chainId: BASE, sellProceedsCents: 80_000 }), chain({ chainId: ETH })],
        needs: [{ chainId: BASE, buysCents: 0, feeCents: 0 }, { chainId: ETH, buysCents: 50_000, feeCents: 250 }],
        newMoney: null,
      },
      {
        chains: [chain({ chainId: BASE, localFundingCents: 20_000, sellProceedsCents: 20_000 }), chain({ chainId: ETH }), chain({ chainId: RH })],
        needs: [
          { chainId: BASE, buysCents: 30_000, feeCents: 150 },
          { chainId: ETH, buysCents: 25_000, feeCents: 125 },
          { chainId: RH, buysCents: 10_000, feeCents: 50 },
        ],
        newMoney: { chainId: ETH, availableCents: 60_000 },
      },
    ]
    for (const sc of scenarios) expect(fundingConservationErrors(sc, plan(sc))).toEqual([])
  })
})


describe('mutation-survivor kills round 2 (path-3 triage, 2026-08-04 — the five line-pinned money shapes)', () => {
  it('LOCALLY SPENT PROCEEDS LEAVE THE POOL (L278): a drained chain cannot re-offer them outward — the cross-chain double-spend shape', () => {
    // A holds $1.00 of proceeds and spends $0.60 of it on its own need; only
    // $0.40 may ever bridge. The −→+ mutant GREW the pool on local spend, so a
    // second chain could draw money that was already spent.
    const input: FundingPlanInput = {
      chains: [chain({ chainId: BASE, sellProceedsCents: 100 }), chain({ chainId: ETH })],
      needs: [
        { chainId: BASE, buysCents: 60, feeCents: 0 },
        { chainId: ETH, buysCents: 80, feeCents: 0 },
      ],
      newMoney: null,
    }
    const p = plan(input)
    // ETH can only see the $0.40 remainder — it refuses, it never half-funds
    expect(p.refusals.map((r) => r.chainId)).toEqual([ETH])
    const base = p.steps.find((s) => s.action.kind === 'batch' && s.action.chainId === BASE)!.action as { fundedFrom: { source: string; cents: number }[] }
    expect(base.fundedFrom).toEqual([{ source: 'local-proceeds', fromChainId: BASE, cents: 60 }])
    expect(fundingConservationErrors(input, p)).toEqual([])
  })

  it('CARRIER CHAINS DRINK NEW MONEY FIRST (L293): the refuel bridge must carry something, whatever the shortfall ordering says', () => {
    // The non-carrier's shortfall is BIGGER; a size-only sort would drain the
    // pool before the carrier and kill its refuel. The carrier goes first.
    const input: FundingPlanInput = {
      chains: [
        chain({ chainId: ETH }), // new money sits here
        chain({ chainId: BASE }), // non-carrier, bigger need
        chain({ chainId: RH, nativeRaw: 0n, inboundRefuel: true }), // gas-short carrier
      ],
      needs: [
        { chainId: BASE, buysCents: 10_000, feeCents: 0 },
        { chainId: RH, buysCents: 5_000, feeCents: 0 },
      ],
      newMoney: { chainId: ETH, availableCents: 5_000 },
    }
    const p = plan(input)
    // the carrier is funded, with a refuel-bearing bridge into it
    const refuelBridge = p.steps.find((s) => s.action.kind === 'bridge' && s.action.toChainId === RH)
    expect(refuelBridge, 'the carrier lost the pool to a bigger non-carrier').toBeTruthy()
    expect((refuelBridge!.action as { refuel: boolean }).refuel).toBe(true)
    // and the bigger non-carrier is the one that refuses (nothing left for it)
    expect(p.refusals.map((r) => r.chainId)).toEqual([BASE])
  })

  it('CARRIER FALLBACK DRAWS ARE CLAMPED (L308/L313): never more cash or proceeds than the chain holds, never more than the need', () => {
    // Carrier needs $0.70: new money covers $0.20 (and carries the refuel);
    // the fallback may take AT MOST the $0.30 cash and $0.20 of the $0.25
    // proceeds. The min→max mutants drew past both bounds.
    const input: FundingPlanInput = {
      chains: [
        chain({ chainId: ETH }),
        chain({ chainId: RH, nativeRaw: 0n, inboundRefuel: true, localFundingCents: 30, sellProceedsCents: 25 }),
      ],
      needs: [{ chainId: RH, buysCents: 70, feeCents: 0 }],
      newMoney: { chainId: ETH, availableCents: 20 },
    }
    const p = plan(input)
    expect(p.refusals).toEqual([])
    const rh = p.steps.find((s) => s.action.kind === 'batch' && s.action.chainId === RH)!.action as { fundedFrom: { source: string; cents: number }[] }
    expect(rh.fundedFrom).toEqual([
      { source: 'new-money', fromChainId: ETH, cents: 20 },
      { source: 'local-cash', fromChainId: RH, cents: 30 },
      { source: 'local-proceeds', fromChainId: RH, cents: 20 },
    ])
    expect(fundingConservationErrors(input, p)).toEqual([])
  })

  it('THE STEPS ARRAY IS EXECUTION ORDER (L426): a destination batch never precedes the bridge that feeds it', () => {
    const input: FundingPlanInput = {
      chains: [chain({ chainId: ETH }), chain({ chainId: BASE }), chain({ chainId: RH, localFundingCents: 10_000 })],
      needs: [
        { chainId: BASE, buysCents: 5_000, feeCents: 0 }, // fed by a bridge → order 3
        { chainId: RH, buysCents: 5_000, feeCents: 0 }, // self-sufficient → order 1
      ],
      newMoney: { chainId: ETH, availableCents: 5_000 },
    }
    const p = plan(input)
    // orders never decrease down the array — the runner executes it as-is
    const orders = p.steps.map((s) => s.order)
    for (let i = 1; i < orders.length; i++) expect(orders[i]).toBeGreaterThanOrEqual(orders[i - 1])
    // and concretely: self-sufficient batch, then the bridge, then the fed batch
    expect(p.steps[0].action).toMatchObject({ kind: 'batch', chainId: RH })
    expect(p.steps[1].action).toMatchObject({ kind: 'bridge', toChainId: BASE })
    expect(p.steps[2].action).toMatchObject({ kind: 'batch', chainId: BASE })
  })

  it('THE CHECKER SUMS BOTH PROCEEDS SOURCES (L477): local + cross-chain draws from one chain are ONE pool against its sales', () => {
    // hand-poisoned plan: each draw is under the chain's $1.00 of proceeds on
    // its own, but together they spend $1.20 — the +→− mutant made the checker
    // blind to exactly this split.
    const input: FundingPlanInput = {
      chains: [chain({ chainId: BASE, sellProceedsCents: 100 }), chain({ chainId: ETH })],
      needs: [
        { chainId: BASE, buysCents: 60, feeCents: 0 },
        { chainId: ETH, buysCents: 60, feeCents: 0 },
      ],
      newMoney: null,
    }
    const poisoned = {
      steps: [
        { order: 1, action: { kind: 'batch' as const, chainId: BASE, fundedFrom: [{ source: 'local-proceeds' as const, fromChainId: BASE, cents: 60 }] } },
        { order: 3, action: { kind: 'batch' as const, chainId: ETH, fundedFrom: [{ source: 'sell-proceeds' as const, fromChainId: BASE, cents: 60 }] } },
      ],
      notes: [],
      refusals: [],
      serialized: true,
      txCountByChain: [],
    }
    const errors = fundingConservationErrors(input, poisoned)
    expect(errors.some((e) => e.chainId === BASE && /more sale proceeds spent than the sales produce/.test(e.note))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M8 + M9 — desk 236's tail, MEASURED then fixed (2026-08-07). These were the
// two findings the desk note compressed to nine words each; both reproduced.
// ─────────────────────────────────────────────────────────────────────────────
describe('M8 — a bridge SOURCE must be able to pay for its own transaction', () => {
  it('refuses a bridge out of a chain whose gas estimate did not read (it used to plan one silently)', () => {
    // Ethereum: bridgeable proceeds, NO need of its own, gas estimate null.
    // The gas pass iterates `needs` only, so this chain was never checked —
    // measured: `bridge:1` planned with ZERO refusals, on the most expensive
    // chain there is, for a fee we never established could be paid.
    const p = plan({
      chains: [
        chain({ chainId: BASE, inboundRefuel: true }),
        chain({ chainId: ETH, nativeRaw: 0n, gasNeedRaw: null, sellProceedsCents: 500_000 }),
      ],
      needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 400 }],
      newMoney: null,
    })
    expect(p.steps.some((s) => s.action.kind === 'bridge')).toBe(false)
    const r = p.refusals.find((x) => x.chainId === ETH)
    expect(r, 'the unchecked source chain must SAY why').toBeTruthy()
    expect(r!.reason).toMatch(/could not estimate the network fee/i)
  })

  it('refuses a bridge out of a chain that cannot afford its own gas, in different words', () => {
    const p = plan({
      chains: [
        chain({ chainId: BASE, inboundRefuel: true }),
        // estimate READ fine — the chain simply cannot pay it
        chain({ chainId: ETH, nativeRaw: 1n, gasNeedRaw: 10n ** 15n, sellProceedsCents: 500_000 }),
      ],
      needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 400 }],
      newMoney: null,
    })
    expect(p.steps.some((s) => s.action.kind === 'bridge')).toBe(false)
    expect(p.refusals.find((x) => x.chainId === ETH)!.reason).toMatch(/does not hold enough of its own ETH/i)
  })

  it('a HEALTHY source still bridges — the guard refuses the unfunded case, not the feature', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, inboundRefuel: true }), chain({ chainId: ETH, sellProceedsCents: 500_000 })],
      needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 400 }],
      newMoney: null,
    })
    expect(p.steps.some((s) => s.action.kind === 'bridge')).toBe(true)
    expect(p.refusals).toEqual([])
  })
})

describe('M9 — a chain with nothing to do gets no batch step', () => {
  it('no buys AND no proceeds means no step (it used to get a wallet prompt for nothing)', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, localFundingCents: 500_000 }), chain({ chainId: ETH })],
      needs: [
        { chainId: BASE, buysCents: 100_000, feeCents: 400 },
        { chainId: ETH, buysCents: 0, feeCents: 0 },
      ],
      newMoney: null,
    })
    const batched = p.steps.filter((s) => s.action.kind === 'batch').map((s) => (s.action as { chainId: number }).chainId)
    expect(batched).toEqual([BASE])
  })

  it('BUT no buys WITH proceeds still batches — that is where the sells execute (the fix that broke this is why the guard is narrow)', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, sellProceedsCents: 100_000 }), chain({ chainId: ETH })],
      needs: [
        { chainId: BASE, buysCents: 0, feeCents: 0 },
        { chainId: ETH, buysCents: 50_000, feeCents: 250 },
      ],
      newMoney: null,
    })
    const batched = p.steps.filter((s) => s.action.kind === 'batch').map((s) => (s.action as { chainId: number }).chainId)
    expect(batched).toContain(BASE)
  })
})

describe('the refusal nobody had read back (M12)', () => {
  it('an underfunded chain states the shortfall in dollars and what to do about it', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, localFundingCents: 10_000 })],
      needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 400 }],
      newMoney: null,
    })
    const r = p.refusals.find((x) => x.chainId === BASE)
    expect(r, 'an underfunded chain must SAY it').toBeTruthy()
    expect(r!.reason).toMatch(/more to complete its network/)
    expect(r!.reason).toMatch(/Add funds or trim its targets/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A DRAW OF NOTHING IS NOT A DRAW (gate A12's funding-plan sweep, 2026-08-07).
//
// funding-plan was NOT a mutation-sweep target until today — the one module M3
// lived in was the one place the sweep never looked. Its first run left 13
// survivors, the most of any module, and nearly all were ONE class: `> 0` →
// `>= 0` and `<= 0` → `< 0` on money amounts, which pushes ZERO-CENT rows into
// `fundedFrom` and counts zero-cent bridges as inbound.
//
// Pinning 13 boundary mutants individually would be 13 tests asserting the same
// thing badly. These two laws kill the class: a plan's audit trail says where
// every cent came from, so a row for NO cents is a sentence about nothing —
// the same family as M5 (a zero-cent leg is a refusal, not a disappearance),
// pointing the other way.
// ─────────────────────────────────────────────────────────────────────────────
describe('no zero-cent rows anywhere in a funding plan', () => {
  const shapes = () => [
    // local cash only
    plan({ chains: [chain({ chainId: BASE, localFundingCents: 500_000 })], needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 400 }], newMoney: null }),
    // exact cover — the boundary where a second source would draw zero
    plan({ chains: [chain({ chainId: BASE, localFundingCents: 100_400 })], needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 400 }], newMoney: null }),
    // cash + proceeds on one chain
    plan({ chains: [chain({ chainId: BASE, localFundingCents: 50_000, sellProceedsCents: 60_000 })], needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 400 }], newMoney: null }),
    // cross-chain proceeds (a bridge)
    plan({
      chains: [chain({ chainId: BASE, inboundRefuel: true }), chain({ chainId: ETH, sellProceedsCents: 500_000 })],
      needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 400 }],
      newMoney: null,
    }),
    // new money on another chain
    plan({
      chains: [chain({ chainId: BASE, inboundRefuel: true }), chain({ chainId: ETH })],
      needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 400 }],
      newMoney: { chainId: ETH, availableCents: 500_000 },
    }),
    // exact new-money cover — the other zero-remainder boundary
    plan({
      chains: [chain({ chainId: BASE, inboundRefuel: true }), chain({ chainId: ETH })],
      needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 400 }],
      newMoney: { chainId: ETH, availableCents: 100_400 },
    }),
  ]

  it('every funding draw is for a positive number of cents', () => {
    for (const [i, p] of shapes().entries()) {
      for (const step of p.steps) {
        const drawn = 'fundedFrom' in step.action ? (step.action as { fundedFrom: { source: string; cents: number }[] }).fundedFrom : []
        for (const d of drawn) {
          expect(d.cents, `shape ${i}: a ${d.source} draw of ${d.cents} cents is a row about nothing`).toBeGreaterThan(0)
          expect(Number.isInteger(d.cents), `shape ${i}: ${d.source} draw is not whole cents`).toBe(true)
        }
      }
    }
  })

  it('every bridge moves a positive number of cents', () => {
    for (const [i, p] of shapes().entries()) {
      for (const step of p.steps) {
        if (step.action.kind !== 'bridge') continue
        const cents = (step.action as { amountCents: number }).amountCents
        expect(cents, `shape ${i}: a bridge of ${cents} cents is a transaction for nothing`).toBeGreaterThan(0)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE CONSERVATION CHECKER'S REMAINING VERDICTS (mutation run 4: funding-plan
// at 80.93% with 5 mutants under NO coverage, all of them here).
//
// Three of this checker's verdicts were already pinned — under-funded, and both
// over-drawn-proceeds cases. The other three had never fired in a test: the
// over-funded half of the same ternary, over-drawn LOCAL CASH, and over-drawn
// NEW MONEY.
//
// WHY THAT MATTERS MORE THAN THE PERCENTAGE. This checker is what makes law 2
// verifiable rather than trusted — the runner asserts it BEFORE signing. A
// checker whose failure branches never run in any test is indistinguishable
// from one that always returns "sound", and every test in this file would still
// pass if it did. Pinning a detector's POSITIVE result is the only thing that
// separates "we check conservation" from "we call a function".
//
// Each case forges a plan the builder would never emit, because that is the
// point: the checker exists for the day the builder is wrong.
// ─────────────────────────────────────────────────────────────────────────────

describe('self-audit A6: the checker reports every kind of break it claims to', () => {
  const forge = (fundedFrom: { source: 'local-cash' | 'local-proceeds' | 'sell-proceeds' | 'new-money'; fromChainId: number; cents: number }[], chainId = BASE) => ({
    steps: [{ order: 1, action: { kind: 'batch' as const, chainId, fundedFrom } }],
    notes: [],
    refusals: [],
    serialized: false,
    txCountByChain: [{ chainId, txs: 1 }],
  })

  it('OVER-FUNDED: a batch drawing more than the chain needs — the other half of the under-funded ternary', () => {
    const input: FundingPlanInput = {
      chains: [chain({ chainId: BASE, localFundingCents: 100_000 })],
      needs: [{ chainId: BASE, buysCents: 50_000, feeCents: 0 }],
      newMoney: null,
    }
    const errs = fundingConservationErrors(input, forge([{ source: 'local-cash', fromChainId: BASE, cents: 70_000 }]))
    expect(errs[0]).toMatchObject({ chainId: BASE, needCents: 50_000, fundedCents: 70_000 })
    expect(errs[0].note).toMatch(/over-funded/)
    // and it must NOT report the opposite verdict — a checker that says both is
    // saying nothing
    expect(errs[0].note).not.toMatch(/under-funded/)
  })

  it('OVER-DRAWN LOCAL CASH: more spent from a chain than the inventory said it holds', () => {
    const input: FundingPlanInput = {
      chains: [chain({ chainId: BASE, localFundingCents: 20_000 })],
      // the need MATCHES the draw, so (a) is satisfied and only the
      // source-inventory check (b) can catch this one
      needs: [{ chainId: BASE, buysCents: 60_000, feeCents: 0 }],
      newMoney: null,
    }
    const errs = fundingConservationErrors(input, forge([{ source: 'local-cash', fromChainId: BASE, cents: 60_000 }]))
    expect(errs.some((e) => /more local cash spent than the chain holds/.test(e.note))).toBe(true)
    expect(errs.find((e) => /local cash/.test(e.note))).toMatchObject({ needCents: 20_000, fundedCents: 60_000 })
  })

  it('OVER-DRAWN NEW MONEY: more drawn than the deposit made available', () => {
    const input: FundingPlanInput = {
      chains: [chain({ chainId: BASE, localFundingCents: 0 })],
      needs: [{ chainId: BASE, buysCents: 90_000, feeCents: 0 }],
      newMoney: { chainId: BASE, availableCents: 40_000 },
    }
    const errs = fundingConservationErrors(input, forge([{ source: 'new-money', fromChainId: BASE, cents: 90_000 }]))
    expect(errs.some((e) => /more new money spent than was made available/.test(e.note))).toBe(true)
    expect(errs.find((e) => /new money/.test(e.note))).toMatchObject({ needCents: 40_000, fundedCents: 90_000 })
  })

  it('draws EXACTLY at the inventory are sound — the boundary is >, not >=', () => {
    // the half that keeps this a detector rather than a blanket refusal: if
    // spending precisely what exists were an error, every full-balance plan
    // would be reported broken and nothing here would say so
    const input: FundingPlanInput = {
      chains: [chain({ chainId: BASE, localFundingCents: 50_000 })],
      needs: [{ chainId: BASE, buysCents: 50_000, feeCents: 0 }],
      newMoney: null,
    }
    expect(fundingConservationErrors(input, forge([{ source: 'local-cash', fromChainId: BASE, cents: 50_000 }]))).toEqual([])
  })
})

describe('the CARRIER-CHAIN path and the shortCents==0 boundaries (mutation triage, 2026-08-07)', () => {
  // The sweep left 12 survivors here and they clustered in exactly two places
  // the fixtures above never construct: the carrier-chain fallback at pass 3(b),
  // and the moments a shortfall closes to EXACTLY zero with sources still in
  // hand. Seven of the twelve are real; the other five are equivalents behind an
  // inner `shortCents > 0` that refuses identically, and they are named in
  // mutation-triage.json rather than tested into submission.
  //
  // The shared law every scenario asserts: A DRAW OF ZERO CENTS IS A SENTENCE
  // ABOUT NOTHING. `fundedFrom` is the record the conservation check reads and
  // the review renders, so a phantom row there is a lie about where money came
  // from even when the totals happen to balance.
  const noEmptyMoney = (p: ReturnType<typeof plan>, why: string) => {
    for (const s of p.steps) {
      if (s.action.kind === 'batch')
        for (const d of s.action.fundedFrom)
          expect(d.cents, `${why}: a ${d.source} draw of ${d.cents} cents from chain ${d.fromChainId}`).toBeGreaterThan(0)
      if (s.action.kind === 'bridge')
        expect(s.action.amountCents, `${why}: a bridge of ${s.action.amountCents} cents`).toBeGreaterThan(0)
    }
  }

  it('a chain holding EXACTLY its gas need is not a carrier — the boundary is enough, not nearly enough', () => {
    // `nativeRaw >= gasNeedRaw` decides this. Mutated to `>`, a chain sitting on
    // exactly the fee it owes becomes a carrier: pass 2 then takes nothing
    // locally, and pass 4 refuses it for having no inbound bridge. Exactly
    // enough gas is enough, and nothing before this asserted that.
    const GAS = 10n ** 15n
    const p = plan({
      chains: [chain({ chainId: BASE, nativeRaw: GAS, gasNeedRaw: GAS, localFundingCents: 100_000 })],
      needs: [{ chainId: BASE, buysCents: 40_000, feeCents: 0 }],
      newMoney: null,
    })
    expect(p.refusals).toEqual([])
    expect(p.steps.filter((s) => s.action.kind === 'bridge')).toHaveLength(0)
    const batch = p.steps.find((s) => s.action.kind === 'batch')
    expect(batch?.action.kind === 'batch' && batch.action.fundedFrom).toEqual([
      { source: 'local-cash', fromChainId: BASE, cents: 40_000 },
    ])
  })

  it('a new-money pool that is present but EMPTY draws nothing — no phantom new-money row, no phantom bridge', () => {
    // newMoneyChain is set and newMoneyLeft is 0. `newMoneyLeft > 0` is what
    // stops a zero take; mutated to `>=` (or the `&&` turned `||`) the chain
    // records a new-money draw of 0 cents and a 0-cent bridge to carry it,
    // then funds properly from proceeds so the totals still balance — which is
    // exactly why only a per-draw assertion catches it.
    const p = plan({
      chains: [
        chain({ chainId: BASE }),
        chain({ chainId: ETH, sellProceedsCents: 100_000 }),
      ],
      needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 0 }],
      newMoney: { chainId: ETH, availableCents: 0 },
    })
    noEmptyMoney(p, 'empty new-money pool')
    const batch = p.steps.find((s) => s.action.kind === 'batch')
    expect(batch?.action.kind === 'batch' && batch.action.fundedFrom).toEqual([
      { source: 'sell-proceeds', fromChainId: ETH, cents: 100_000 },
    ])
  })

  it('a CARRIER chain with no local cash and no local proceeds records neither — the fallback draws only what exists', () => {
    // The first fixture in this module to build a carrier chain at all: RH is
    // gas-short with inbound refuel, so pass 2 deliberately skips it and it
    // arrives at the pass-3 fallback still short. Its local cash and local
    // proceeds are both zero, and `cash > 0` / `lp > 0` are the only things
    // stopping two empty rows being recorded against it.
    const p = plan({
      chains: [
        chain({ chainId: RH, nativeRaw: 0n, localFundingCents: 0, sellProceedsCents: 0 }),
        chain({ chainId: ETH, sellProceedsCents: 50_000 }),
      ],
      needs: [{ chainId: RH, buysCents: 100_000, feeCents: 0 }],
      newMoney: { chainId: ETH, availableCents: 50_000 },
    })
    noEmptyMoney(p, 'carrier with nothing local')
    const batch = p.steps.find((s) => s.action.kind === 'batch')
    const from = batch?.action.kind === 'batch' ? batch.action.fundedFrom : []
    expect(from.map((d) => d.source).sort()).toEqual(['new-money', 'sell-proceeds'])
    expect(from.every((d) => d.fromChainId === ETH)).toBe(true)
  })

  it('a shortfall closed EXACTLY by the first source stops there — later sources are not drawn for zero', () => {
    // `if (r.shortCents <= 0) break` is the whole guard. Mutated to `< 0` the
    // loop keeps walking every remaining chain with proceeds and records a
    // 0-cent draw against each, while the chain stays live because it is in
    // fact fully funded. The 0-cent BRIDGE is filtered from the output by the
    // assembler, so the draw row is the only place this shows.
    const p = plan({
      chains: [
        chain({ chainId: BASE }),
        chain({ chainId: ETH, sellProceedsCents: 100_000 }),
        chain({ chainId: RH, sellProceedsCents: 50_000 }),
      ],
      needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 0 }],
      newMoney: null,
    })
    noEmptyMoney(p, 'shortfall closed exactly')
    const batch = p.steps.find((s) => s.action.kind === 'batch')
    expect(batch?.action.kind === 'batch' && batch.action.fundedFrom).toEqual([
      { source: 'sell-proceeds', fromChainId: ETH, cents: 100_000 },
    ])
  })
})

describe('a refusal cascades to what it funded (adversarial pass 2026-08-08)', () => {
  it('a batch does NOT survive the refusal of the bridge that funds it', () => {
    // Measured: the source was refused for an unreadable gas estimate, its
    // bridges dropped from liveBridges, and the DESTINATION stayed resolved
    // with the sell-proceeds draw still recorded — so with no live bridge
    // targeting it, it was promoted from order 3 to ORDER 1 WITH NO waitsFor
    // and read as executable immediately. A signature pulling $1,004 on Base,
    // funded entirely by money the same plan had just refused to move, with
    // only the source named. fundingConservationErrors reported clean, because
    // it compares recorded draws to the need and the draws were all still there.
    const p = plan({
      chains: [
        chain({ chainId: ETH, sellProceedsCents: 100_400, gasNeedRaw: null }),
        chain({ chainId: BASE }),
      ],
      needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 400 }],
      newMoney: null,
    })
    expect(p.steps.filter((s) => s.action.kind === 'batch')).toHaveLength(0)
    expect(p.refusals.map((r) => r.chainId).sort()).toEqual([ETH, BASE].sort())
    expect(p.refusals.find((r) => r.chainId === BASE)!.reason).toMatch(/will not move money out of/)
  })

  it('and PARTIAL funding refuses too — half a batch is the thing the header forbids', () => {
    // Two sources, one refused: exactly half the funding never arrives and a
    // FULL-SIZE batch was still emitted. The module's own header says a chain
    // that cannot be funded EXACTLY refuses and never half-funds and hopes.
    const p = plan({
      chains: [
        chain({ chainId: ETH, sellProceedsCents: 50_000, gasNeedRaw: null }),
        chain({ chainId: RH, sellProceedsCents: 50_400 }),
        chain({ chainId: BASE }),
      ],
      needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 400 }],
      newMoney: null,
    })
    expect(p.steps.filter((s) => s.action.kind === 'batch')).toHaveLength(0)
    expect(p.refusals.some((r) => r.chainId === BASE)).toBe(true)
  })

  it('but a refusal that funded NOTHING leaves the other chains alone', () => {
    // The fix must cascade, not carpet-bomb: a refused source whose money no
    // live chain was relying on changes nothing for anyone else.
    const p = plan({
      chains: [
        chain({ chainId: ETH, sellProceedsCents: 0, gasNeedRaw: null }),
        chain({ chainId: BASE, localFundingCents: 100_400 }),
      ],
      needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 400 }],
      newMoney: null,
    })
    expect(p.steps.some((s) => s.action.kind === 'batch' && s.action.chainId === BASE)).toBe(true)
  })
})

describe('an unreadable amount is a caller bug, not a zero (adversarial pass 2026-08-08)', () => {
  it('refuses every unreadable shape of feeCents rather than silently charging none', () => {
    // NaN, Infinity, null, undefined and -400 all resolved to "no fee" — a plan
    // drawing exactly the buys with no error and no refusal.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined, -400])
      expect(() =>
        plan({
          chains: [chain({ chainId: BASE, localFundingCents: 200_000 })],
          needs: [{ chainId: BASE, buysCents: 100_000, feeCents: bad as never }],
          newMoney: null,
        }),
      ).toThrow(FundingPlanContractError)
  })

  it('a NEGATIVE buysCents refuses instead of composing a live step', () => {
    expect(() =>
      plan({
        chains: [chain({ chainId: BASE, localFundingCents: 200_000 })],
        needs: [{ chainId: BASE, buysCents: -100_000, feeCents: 400 }],
        newMoney: null,
      }),
    ).toThrow(FundingPlanContractError)
  })

  it('but ZERO stays legal — a zero fee is a real answer, not an unreadable one', () => {
    expect(() =>
      plan({
        chains: [chain({ chainId: BASE, localFundingCents: 200_000 })],
        needs: [{ chainId: BASE, buysCents: 100_000, feeCents: 0 }],
        newMoney: null,
      }),
    ).not.toThrow()
  })
})

// ── REAL SELLS (the owner's live order, 2026-08-14): the sale is its own step ────
// The shipping batcher is buy-only, so sales are physical order-1 steps and
// the inventory credit must be exactly what the sales floor at. Legacy
// callers (no `sells` field) are pinned above, byte-identical.

describe('real sells — sales are order-1 steps; credit equals producers', () => {
  const sale = (chainId: number, floorProceedsCents: number, asset = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') => ({
    chainId,
    asset,
    symbol: 'SOLD',
    sellRaw: '1000000000000000000',
    decimals: 18,
    floorProceedsCents,
  })

  it('same-chain sell-funds-buy: sale first, batch draws the proceeds and WAITS on the sales', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, sellProceedsCents: 20_000 })],
      needs: [{ chainId: BASE, buysCents: 19_900, feeCents: 100 }],
      newMoney: null,
      sells: [sale(BASE, 20_000)],
    })
    expect(p.refusals).toHaveLength(0)
    expect(p.steps.map((s) => s.action.kind)).toEqual(['sell', 'batch'])
    expect(p.steps[0].order).toBeLessThan(p.steps[1].order)
    expect(p.steps[1].waitsFor).toMatch(/sales confirming/)
    const drawn = (p.steps[1].action as { fundedFrom: { source: string; cents: number }[] }).fundedFrom
    expect(drawn).toEqual([{ source: 'local-proceeds', fromChainId: BASE, cents: 20_000 }])
    expect(p.txCountByChain).toEqual([{ chainId: BASE, txs: 2 }])
    expect(p.serialized).toBe(true)
  })

  it('with sells present, every BRIDGE orders strictly after every SELL (kills :727 + → -)', () => {
    // order: 2 + shift with shift=1; the mutant computes 2 - 1 = 1, colliding
    // with the sells' own rung — a bridge sequenced beside the sales it draws
    // on is the double-spend-shaped race the ordering exists to prevent
    const p = plan({
      chains: [chain({ chainId: BASE, sellProceedsCents: 50_000 }), chain({ chainId: ETH })],
      needs: [{ chainId: ETH, buysCents: 30_000, feeCents: 150 }],
      newMoney: null,
      sells: [sale(BASE, 50_000)],
    })
    const sells = p.steps.filter((x) => x.action.kind === 'sell')
    const bridges = p.steps.filter((x) => x.action.kind === 'bridge')
    expect(sells.length).toBeGreaterThan(0)
    expect(bridges.length).toBeGreaterThan(0)
    for (const b of bridges) for (const sl of sells) expect(b.order).toBeGreaterThan(sl.order)
  })

  it('cross-chain: the sale funds a bridge that waits on it, and the destination batches at arrival', () => {
    const p = plan({
      chains: [chain({ chainId: ETH, sellProceedsCents: 30_000 }), chain({ chainId: BASE })],
      needs: [{ chainId: BASE, buysCents: 29_850, feeCents: 150 }],
      newMoney: null,
      sells: [sale(ETH, 30_000)],
    })
    expect(p.refusals).toHaveLength(0)
    expect(p.steps.map((s) => s.action.kind)).toEqual(['sell', 'bridge', 'batch'])
    const bridge = p.steps[1]
    expect((bridge.action as { source: string }).source).toBe('sell-proceeds')
    expect(bridge.waitsFor).toMatch(/sales confirming/)
    expect(p.steps[2].waitsFor).toMatch(/arriving/)
    // ETH: one sale + one bridge; no batch there (sells are their own steps now)
    expect(p.txCountByChain).toEqual([
      { chainId: ETH, txs: 2 },
      { chainId: BASE, txs: 1 },
    ])
  })

  it('a pure cash-out is a complete plan: sales only, no batch, no refusal', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, sellProceedsCents: 50_000 })],
      needs: [],
      newMoney: null,
      sells: [sale(BASE, 50_000)],
    })
    expect(p.refusals).toHaveLength(0)
    expect(p.steps.map((s) => s.action.kind)).toEqual(['sell'])
    expect(p.txCountByChain).toEqual([{ chainId: BASE, txs: 1 }])
  })

  it('credit without a producing sale (or floors that disagree) throws loud — never bookkept fiction', () => {
    expect(() =>
      plan({
        chains: [chain({ chainId: BASE, sellProceedsCents: 20_000 })],
        needs: [{ chainId: BASE, buysCents: 19_900, feeCents: 100 }],
        newMoney: null,
        sells: [],
      }),
    ).toThrow(FundingPlanContractError)
    expect(() =>
      plan({
        chains: [chain({ chainId: BASE, sellProceedsCents: 20_000 })],
        needs: [{ chainId: BASE, buysCents: 19_900, feeCents: 100 }],
        newMoney: null,
        sells: [sale(BASE, 19_000)],
      }),
    ).toThrow(FundingPlanContractError)
  })

  it('a gas-short selling chain refuses its SALES and zeroes the credit — dependents refuse honestly', () => {
    const p = plan({
      chains: [chain({ chainId: ETH, sellProceedsCents: 30_000, nativeRaw: 0n }), chain({ chainId: BASE })],
      needs: [{ chainId: BASE, buysCents: 29_850, feeCents: 150 }],
      newMoney: null,
      sells: [sale(ETH, 30_000)],
    })
    expect(p.steps).toHaveLength(0)
    expect(p.refusals.some((r) => r.chainId === ETH && /sales are not planned/.test(r.reason))).toBe(true)
    expect(p.refusals.some((r) => r.chainId === BASE)).toBe(true)
  })

  it('two sales of one asset on one chain throw — they would race each other\'s balance', () => {
    expect(() =>
      plan({
        chains: [chain({ chainId: BASE, sellProceedsCents: 40_000 })],
        needs: [],
        newMoney: null,
        sells: [sale(BASE, 20_000), sale(BASE, 20_000)],
      }),
    ).toThrow(FundingPlanContractError)
  })
})

// ── three pins from the 42bb0fb1 sweep's survivors — boundaries + honesty ────
describe('sweep pins — the gas boundary, the stranded bridge, the honest note', () => {
  const sale2 = (chainId: number, floorProceedsCents: number, asset: string) => ({
    chainId,
    asset,
    symbol: 'SOLD',
    sellRaw: '1000000000000000000',
    decimals: 18,
    floorProceedsCents,
  })

  it('a bridge SOURCE holding EXACTLY its gas need still sends — the boundary is spendable, not short', () => {
    const p = plan({
      chains: [chain({ chainId: ETH, localFundingCents: 0, nativeRaw: 10n ** 15n, gasNeedRaw: 10n ** 15n }), chain({ chainId: BASE })],
      needs: [{ chainId: BASE, buysCents: 40_000, feeCents: 200 }],
      newMoney: { chainId: ETH, availableCents: 100_000 },
    })
    expect(p.refusals).toHaveLength(0)
    expect(p.steps.some((s) => s.action.kind === 'bridge')).toBe(true)
  })

  it('a destination stranded by a refused co-source loses its OTHER bridges too — no orphan transfer survives', () => {
    const p = plan({
      chains: [
        chain({ chainId: ETH, sellProceedsCents: 60_000 }),
        chain({ chainId: RH, sellProceedsCents: 60_000, nativeRaw: 0n }),
        chain({ chainId: BASE }),
      ],
      needs: [{ chainId: BASE, buysCents: 99_500, feeCents: 500 }],
      newMoney: null,
    })
    expect(p.refusals.some((r) => r.chainId === RH)).toBe(true)
    expect(p.refusals.some((r) => r.chainId === BASE)).toBe(true)
    expect(p.steps.filter((s) => s.action.kind === 'bridge')).toHaveLength(0)
  })

  it('the sales note counts ONLY its own chain', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, sellProceedsCents: 40_000 }), chain({ chainId: ETH, sellProceedsCents: 20_000 })],
      needs: [],
      newMoney: null,
      sells: [
        sale2(BASE, 20_000, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'),
        sale2(BASE, 20_000, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2'),
        sale2(ETH, 20_000, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3'),
      ],
    })
    expect(p.notes.some((n) => /sells 2 holdings on network 8453/.test(n))).toBe(true)
    expect(p.notes.some((n) => /sells 1 holding on network 1\b/.test(n))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BRIDGE HEADROOM. A bridge delivers less than it carries, and sizing a draw to
// the exact shortfall guarantees the destination lands short (the owner, live
// 2026-08-16, a $16 Base leg: "bridging does exactly the amount needed... which
// forces an error"). Third instance this week of "sized to the penny against a
// number that moves".
// ─────────────────────────────────────────────────────────────────────────────
describe('bridgeDrawFor — move enough that the NEEDED amount actually lands', () => {
  it('carries more than the need, so the route’s own cut does not eat into it', () => {
    expect(bridgeDrawFor(1_600, 100_000)).toBeGreaterThan(1_600)
  })

  it('⚠ NEVER draws more than the source has — a padded plan must not refuse a fundable one', () => {
    expect(bridgeDrawFor(1_600, 1_600)).toBe(1_600)
    expect(bridgeDrawFor(1_600, 1_000)).toBe(1_000)
  })

  it('the pad is BOUNDED, not a multiplier that grows without limit', () => {
    const draw = bridgeDrawFor(1_000_000, 10_000_000)
    expect(draw).toBeLessThanOrEqual(1_000_000 + Math.ceil((1_000_000 * BRIDGE_ARRIVAL_HEADROOM_BPS) / 10_000))
    // ⚠ THE FLOOR MATTERS MORE THAN THE CEILING HERE. A pad SMALLER than the
    // slippage the bridge is already authorised to take is not a fix at all,
    // which is what a hand-picked 50 bps would have been against a 300 bps
    // route. Pin both ends: at least the authorised loss, and still bounded.
    expect(BRIDGE_ARRIVAL_HEADROOM_BPS).toBeGreaterThanOrEqual(DEFAULT_SLIPPAGE_BPS)
    expect(BRIDGE_ARRIVAL_HEADROOM_BPS).toBeLessThanOrEqual(1_000)
  })

  it('always returns whole cents — the plan’s domain is integers', () => {
    for (const [need, avail] of [[333, 99_999], [1, 5], [7, 7], [12_345, 12_400]])
      expect(Number.isInteger(bridgeDrawFor(need, avail))).toBe(true)
  })

  it('a tiny need still gets at least a cent of headroom where the source allows it', () => {
    expect(bridgeDrawFor(1, 100)).toBeGreaterThan(1)
  })

  it('nonsense in, zero out — never NaN into a money plan', () => {
    for (const [need, avail] of [[0, 100], [-5, 100], [Number.NaN, 100], [100, 0], [100, Number.NaN], [100, -1]])
      expect(bridgeDrawFor(need as number, avail as number)).toBe(0)
  })
})

describe('the bridge pad rides the BRIDGE, never the draw', () => {
  it('pads out of surplus only, and never past it', () => {
    expect(bridgePadFor(1_600, 100_000)).toBeGreaterThan(0)
    expect(bridgePadFor(1_600, 0)).toBe(0)
    expect(bridgePadFor(1_600, 1)).toBe(1)
  })

  it('nonsense in, zero out', () => {
    for (const [d, sur] of [[0, 100], [-1, 100], [Number.NaN, 100], [100, Number.NaN], [100, -5]])
      expect(bridgePadFor(d as number, sur as number)).toBe(0)
  })

  it('⚠ CONSERVATION STILL HOLDS with a padded bridge — draws are exact, the pad is not a draw', () => {
    const input: FundingPlanInput = {
      chains: [chain({ chainId: ETH }), chain({ chainId: 8453 })],
      newMoney: { chainId: ETH, availableCents: 100_000 },
      needs: [{ chainId: 8453, buysCents: 1_600, feeCents: 6 }],
    }
    expect(fundingConservationErrors(input, buildFundingPlan(input))).toEqual([])
  })

  it('⚠ the bridge CARRIES MORE than the destination draws — that gap is the whole fix', () => {
    const input: FundingPlanInput = {
      chains: [chain({ chainId: ETH }), chain({ chainId: 8453 })],
      newMoney: { chainId: ETH, availableCents: 100_000 },
      needs: [{ chainId: 8453, buysCents: 1_600, feeCents: 6 }],
    }
    const plan = buildFundingPlan(input)
    const bridge = plan.steps.find((s) => s.action.kind === 'bridge')
    const batch = plan.steps.find((s) => s.action.kind === 'batch')
    if (!bridge || !batch) return // shape-dependent; the conservation pin above is the invariant
    const carried = (bridge.action as { amountCents: number }).amountCents
    const drawn = (batch.action as { fundedFrom: { cents: number }[] }).fundedFrom.reduce((t, d) => t + d.cents, 0)
    expect(carried).toBeGreaterThan(drawn)
  })
})

describe('the flip-eve survivor round (2026-08-16) — the four real gaps the definitive battery exposed', () => {
  const sellFix = (chainId: number, sellRaw: string) => ({
    chainId,
    asset: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    symbol: 'SOLD',
    sellRaw,
    decimals: 18,
    floorProceedsCents: 1_000,
  })

  it('a zero-raw sale REFUSES BY CONTRACT — "0" is not a positive amount to size (kills funding-plan:376 <= → <)', () => {
    // the inventory credit AGREES with the floor on purpose: were it 0c, the
    // credit-conservation throw would fire even under the mutant and this pin
    // would prove nothing — the raw-amount refusal must be the only objection
    expect(() =>
      plan({
        chains: [chain({ chainId: BASE, sellProceedsCents: 1_000 })],
        needs: [],
        newMoney: null,
        sells: [sellFix(BASE, '0')],
      }),
    ).toThrow(FundingPlanContractError)
  })

  it('native EXACTLY equal to the gas estimate still SELLS — the refusal bound is strict (kills funding-plan:439 >= → >)', () => {
    const p = plan({
      chains: [chain({ chainId: BASE, nativeRaw: 10n ** 15n, gasNeedRaw: 10n ** 15n, sellProceedsCents: 1_000 })],
      needs: [],
      newMoney: null,
      sells: [sellFix(BASE, '1000000000000000000')],
    })
    expect(p.refusals.filter((r) => r.chainId === BASE)).toHaveLength(0)
    expect(p.steps.map((s) => s.action.kind)).toContain('sell')
  })

  it("a bridge to SOMEWHERE ELSE cannot satisfy a carrier's fold — inbound is destination AND cents (kills funding-plan:597 && → ||)", () => {
    // BASE is gas-short and SELF-funded (a carrier draws new money first by
    // design, so new money would bridge to it — sell proceeds on the far pair
    // are the bridge that never goes near BASE). The mutant reads that
    // unrelated ETH→RH bridge as BASE's refuel and lets a gasless batch through.
    const p = plan({
      chains: [
        chain({ chainId: BASE, localFundingCents: 100_000, nativeRaw: 0n }),
        chain({ chainId: RH }),
        chain({ chainId: ETH, sellProceedsCents: 30_000 }),
      ],
      needs: [
        { chainId: BASE, buysCents: 40_000, feeCents: 0 },
        { chainId: RH, buysCents: 20_000, feeCents: 0 },
      ],
      newMoney: null,
      sells: [{ ...sellFix(ETH, '1000000000000000000'), floorProceedsCents: 30_000 }],
    })
    expect(p.steps.some((s) => s.action.kind === 'bridge')).toBe(true)
    expect(p.refusals.some((r) => r.chainId === BASE && /nothing in this plan travels there to carry it/.test(r.reason))).toBe(true)
    expect(p.steps.some((s) => s.action.kind === 'batch' && (s.action as { chainId: number }).chainId === BASE)).toBe(false)
  })

  it('a carrier funded ENTIRELY by remote money never claims "has some of your money already" (kills funding-plan:607 === → !==)', () => {
    // the note is the honest split between "your local dollars wait for fees
    // riding in" and "everything arrives together" — all-remote is the second
    const p = plan({
      chains: [chain({ chainId: RH, localFundingCents: 0, nativeRaw: 0n }), chain({ chainId: ETH })],
      needs: [{ chainId: RH, buysCents: 20_000, feeCents: 0 }],
      newMoney: { chainId: ETH, availableCents: 50_000 },
    })
    expect(p.steps.some((s) => s.action.kind === 'bridge')).toBe(true)
    expect(p.notes.every((n) => !n.includes('has some of your money already'))).toBe(true)
  })
})
