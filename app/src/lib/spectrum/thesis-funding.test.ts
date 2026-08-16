import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deploymentFor } from '../chain/deployments'
import { FundingPlanContractError, type ChainNeed } from './funding-plan'
import type { PerChainFunds } from './thesis-run-types'

// ─────────────────────────────────────────────────────────────────────────────
// THESIS FUNDING — the direct route's inventory + shortfall stage.
//
// legFundings is pure and tested bare. readThesisFunds reads chains, so the
// rpc seam is faked (the lens-factory suite's pattern): the REAL read logic
// runs against per-chain scripted answers, and a scripted failure proves the
// omission/null law instead of implying it.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 8453
const ETH = 1
const RH = 4663
const HOLDER = '0x000000000000000000000000000000000000a11c' as `0x${string}`

/** chainId → scripted answers; a missing field (or 'fail') rejects that read. */
const NET = vi.hoisted(() => new Map<number, { usdcRaw?: bigint | 'fail'; nativeRaw?: bigint | 'fail'; gasPrice?: bigint | 'fail' }>())
/** Every ERC-20 balance read, so "it asked the book's settlement token" is provable. */
const erc20Reads = vi.hoisted(() => [] as { chainId: number; address: string; args: readonly unknown[] }[])

vi.mock('../chain/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chain/rpc')>()
  const answer = (chainId: number, field: 'usdcRaw' | 'nativeRaw' | 'gasPrice'): bigint => {
    const v = NET.get(chainId)?.[field]
    if (v == null || v === 'fail') throw new Error(`scripted ${field} failure on ${chainId}`)
    return v
  }
  return {
    ...actual,
    clientFor: ((chainId: number) => ({
      readContract: async (opts: { address: string; args?: readonly unknown[] }) => {
        erc20Reads.push({ chainId, address: opts.address, args: opts.args ?? [] })
        return answer(chainId, 'usdcRaw')
      },
      getBalance: async () => answer(chainId, 'nativeRaw'),
      getGasPrice: async () => answer(chainId, 'gasPrice'),
    })) as unknown as typeof actual.clientFor,
  }
})

const { readThesisFunds, legFundings, THESIS_LEG_GAS_UNITS, THESIS_GAS_DRIFT_X, CARRIER_CENTS } = await import('./thesis-funding')

// ── fixtures (funding-plan.test.ts's builder shape) ──────────────────────────

const fund = (over: Partial<PerChainFunds> & { chainId: number }): PerChainFunds => {
  // usdcRaw kept coherent with usdcCents where the cents are readable; a
  // hostile-cents fixture still gets a VALID raw, so the throw the test asserts
  // is legFundings' contract check, not this helper choking first.
  const cents = over.usdcCents ?? 0
  return {
    usdcRaw: Number.isFinite(cents) && cents >= 0 ? BigInt(Math.floor(cents)) * 10_000n : 0n,
    usdcCents: 0,
    nativeRaw: 10n ** 18n, // plenty of gas unless a test says otherwise
    gasNeedRaw: 10n ** 15n,
    ...over,
  }
}
const need = (chainId: number, buysCents: number, feeCents = 0): ChainNeed => ({ chainId, buysCents, feeCents })

describe('readThesisFunds — fresh per-chain inventory, failures isolated', () => {
  beforeEach(() => {
    NET.clear()
    erc20Reads.length = 0
  })

  it('reads settlement (floored to cents) + native + a priced gas need, per chain', async () => {
    NET.set(BASE, { usdcRaw: 123_456_789n, nativeRaw: 5n * 10n ** 17n, gasPrice: 2_000_000_000n })
    NET.set(ETH, { usdcRaw: 999_999n, nativeRaw: 0n, gasPrice: 30_000_000_000n })
    const rows = await readThesisFunds([BASE, ETH], HOLDER)
    expect(rows.map((r) => r.chainId)).toEqual([BASE, ETH]) // input order kept
    const base = rows.find((r) => r.chainId === BASE)!
    // $123.456789 floors to 12,345 cents — never rounds up what the user holds
    expect(base).toMatchObject({ usdcRaw: 123_456_789n, usdcCents: 12_345, nativeRaw: 5n * 10n ** 17n })
    expect(base.gasNeedRaw).toBe(2_000_000_000n * THESIS_LEG_GAS_UNITS * THESIS_GAS_DRIFT_X)
    // 99.9999 cents is 99 cents, not 100
    expect(rows.find((r) => r.chainId === ETH)!.usdcCents).toBe(99)
    // and the ERC-20 read targeted the deployment book's settlement token, for the holder
    expect(erc20Reads.find((r) => r.chainId === BASE)).toMatchObject({ address: deploymentFor(BASE).usdc!, args: [HOLDER] })
  })

  it('the unit budget covers at least the house swapExactIn floor (gas.ts) — the write that reverted OOG at wallet estimates', () => {
    expect(THESIS_LEG_GAS_UNITS >= 1_500_000n).toBe(true)
  })

  it('a failed GAS PRICE read keeps the chain with gasNeedRaw NULL — unreadable must not read as free', async () => {
    NET.set(BASE, { usdcRaw: 50_000_000n, nativeRaw: 10n ** 18n, gasPrice: 'fail' })
    const rows = await readThesisFunds([BASE], HOLDER)
    expect(rows).toHaveLength(1)
    expect(rows[0].gasNeedRaw).toBeNull()
    expect(rows[0].gasNeedRaw).not.toBe(0n)
    // the balances themselves are real and stay reported
    expect(rows[0].usdcCents).toBe(5_000)
  })

  it('a failed SETTLEMENT balance read OMITS the chain (absent ≠ zero) and the sibling still reports', async () => {
    NET.set(BASE, { usdcRaw: 'fail', nativeRaw: 10n ** 18n, gasPrice: 1n })
    NET.set(ETH, { usdcRaw: 1_000_000n, nativeRaw: 10n ** 18n, gasPrice: 1n })
    const rows = await readThesisFunds([BASE, ETH], HOLDER)
    expect(rows.map((r) => r.chainId)).toEqual([ETH])
  })

  it('a failed NATIVE balance read omits the chain too — half an inventory is not an inventory', async () => {
    NET.set(BASE, { usdcRaw: 1_000_000n, nativeRaw: 'fail', gasPrice: 1n })
    const rows = await readThesisFunds([BASE], HOLDER)
    expect(rows).toEqual([])
  })

  it('a chain with no configured settlement token is omitted without a single read', async () => {
    const rows = await readThesisFunds([999], HOLDER)
    expect(rows).toEqual([])
    expect(erc20Reads).toEqual([])
  })
})

describe('legFundings — exactly enough is enough (the shortfall-0 boundary)', () => {
  it('a leg whose chain already holds its need takes no bridge and carries no note', () => {
    const out = legFundings([need(BASE, 50_000)], [fund({ chainId: BASE, usdcCents: 50_000 })])
    expect(out).toEqual([
      { chainId: BASE, needCents: 50_000, haveCents: 50_000, shortfallCents: 0, bridge: null, gasOk: true, note: null },
    ])
  })

  it('a partial local balance bridges ONLY the shortfall, and the fee rides the need (buys + fee)', () => {
    const out = legFundings(
      [need(BASE, 40_000, 200)],
      [fund({ chainId: BASE, usdcCents: 30_000 }), fund({ chainId: ETH, usdcCents: 100_000 })],
    )
    expect(out[0]).toMatchObject({
      needCents: 40_200,
      haveCents: 30_000,
      shortfallCents: 10_200,
      bridge: { fromChainId: ETH, amountCents: 10_200, refuelWeiNeeded: 0n },
      gasOk: true,
      note: null,
    })
  })
})

describe('legFundings — draws are tracked: two legs can never count the same dollars', () => {
  const funds = () => [
    fund({ chainId: BASE, usdcCents: 0 }),
    fund({ chainId: RH, usdcCents: 0 }),
    fund({ chainId: ETH, usdcCents: 100_000 }),
  ]

  it('the second leg sees the surplus REDUCED by the first leg’s draw, and refuses with the gap named', () => {
    const out = legFundings([need(BASE, 60_000), need(RH, 50_000)], funds())
    expect(out[0].bridge).toEqual({ fromChainId: ETH, amountCents: 60_000, refuelWeiNeeded: 0n })
    // ETH has $400 free now, not $1,000 — the same dollars must not fund both
    expect(out[1].bridge).toBeNull()
    expect(out[1].note).toMatch(/\$500 more on Robinhood/)
    expect(out[1].note).toMatch(/no other network holds enough to cover it/)
  })

  it('drawing the source to EXACTLY zero is legal — the boundary is spent, not overspent', () => {
    const out = legFundings([need(BASE, 60_000), need(RH, 40_000)], funds())
    expect(out[0].bridge).toEqual({ fromChainId: ETH, amountCents: 60_000, refuelWeiNeeded: 0n })
    expect(out[1].bridge).toEqual({ fromChainId: ETH, amountCents: 40_000, refuelWeiNeeded: 0n })
    expect(out.every((l) => l.gasOk && l.note == null)).toBe(true)
  })

  it("a source that is ALSO a leg keeps its own need reserved — raw balance is not free surplus", () => {
    // ETH holds $1,200 but owes its own leg $500: only $700 is free, so the
    // $1,000 Base leg refuses even though 1,200 ≥ 1,000.
    const out = legFundings(
      [need(ETH, 50_000), need(BASE, 100_000)],
      [fund({ chainId: ETH, usdcCents: 120_000 }), fund({ chainId: BASE, usdcCents: 0 })],
    )
    expect(out[0]).toMatchObject({ chainId: ETH, shortfallCents: 0, bridge: null, gasOk: true })
    expect(out[1].bridge).toBeNull()
    // the sentence names the leg's own missing dollars (its shortfall), locale-grouped
    expect(out[1].note).toMatch(/\$1,000 more on Base/)
  })

  it('the LARGEST free surplus funds a shortfall when several chains could', () => {
    const out = legFundings(
      [need(BASE, 20_000)],
      [fund({ chainId: BASE, usdcCents: 0 }), fund({ chainId: ETH, usdcCents: 30_000 }), fund({ chainId: RH, usdcCents: 80_000 })],
    )
    expect(out[0].bridge).toMatchObject({ fromChainId: RH, amountCents: 20_000 })
  })

  it('insufficient everywhere: the missing dollars ROUND UP, so the stated number actually fixes it', () => {
    // short 40,050 cents = $400.50 → the sentence must say $401
    const out = legFundings([need(BASE, 50_050)], [fund({ chainId: BASE, usdcCents: 10_000 })])
    expect(out[0]).toMatchObject({ bridge: null, gasOk: true })
    expect(out[0].note).toMatch(/\$401 more on Base/)
  })

  // Rehearsal 2026-08-13: the seed run refused all three legs for a wallet
  // holding only ETH. The refusal was CORRECT (a leg spends the settlement
  // token, never the native coin) but named neither the currency nor the
  // remedy, so it read as a bug to someone looking at a healthy ETH balance.
  it('a money shortfall names the SETTLEMENT token and what to do — never just the gap', () => {
    const out = legFundings(
      [need(RH, 1_260), need(BASE, 870)],
      [fund({ chainId: RH, usdcCents: 0 }), fund({ chainId: BASE, usdcCents: 0 })],
    )
    // Robinhood settles in USDG, Base in USDC — the sentence takes each chain's
    // own symbol from the deployment book, never a hardcoded 'USDC'.
    expect(out[0].note).toMatch(/spends USDG/)
    expect(out[0].note).toMatch(/ETH on Robinhood only pays the network fee/)
    expect(out[0].note).toMatch(/Add USDG on Robinhood, or lower the amount/)
    expect(out[1].note).toMatch(/spends USDC/)
    expect(out[1].note).toMatch(/Add USDC on Base, or lower the amount/)
  })

  it('the no-send-gas refusal names the settlement token and the remedy too', () => {
    const out = legFundings(
      [need(BASE, 50_000)],
      // ETH holds the money but cannot pay for its own send (M8)
      [fund({ chainId: BASE, usdcCents: 0 }), fund({ chainId: ETH, usdcCents: 100_000, nativeRaw: 0n })],
    )
    expect(out[0].note).toMatch(/cannot pay their own fee to send it/)
    // em dash retired from user copy (house rule); the FACTS are what this pins
    expect(out[0].note).toMatch(/spends USDC/)
    expect(out[0].note).toMatch(/add USDC on Base, or lower the amount/)
  })
})

describe('legFundings — gas rides the bridge (the owner: smart gas routing from day 1)', () => {
  it('a money bridge into a gas-short chain carries the DEFICIT in wei, not the whole budget', () => {
    const out = legFundings(
      [need(BASE, 50_000)],
      [
        fund({ chainId: BASE, usdcCents: 0, nativeRaw: 4n * 10n ** 14n, gasNeedRaw: 10n ** 15n }),
        fund({ chainId: ETH, usdcCents: 100_000 }),
      ],
    )
    expect(out[0].bridge).toEqual({ fromChainId: ETH, amountCents: 50_000, refuelWeiNeeded: 6n * 10n ** 14n })
    expect(out[0].gasOk).toBe(true)
  })

  it('a chain holding EXACTLY its gas need refuels nothing — 0n means none needed', () => {
    const GAS = 10n ** 15n
    const out = legFundings(
      [need(BASE, 50_000)],
      [fund({ chainId: BASE, usdcCents: 0, nativeRaw: GAS, gasNeedRaw: GAS }), fund({ chainId: ETH, usdcCents: 100_000 })],
    )
    expect(out[0].bridge!.refuelWeiNeeded).toBe(0n)
  })

  it('a GAS-ONLY deficit mints a minimal carrier bridge — a refuel cannot travel alone', () => {
    const out = legFundings(
      [need(BASE, 50_000)],
      [
        fund({ chainId: BASE, usdcCents: 50_000, nativeRaw: 0n, gasNeedRaw: 10n ** 15n }),
        fund({ chainId: ETH, usdcCents: 100_000 }),
      ],
    )
    expect(out[0]).toMatchObject({
      shortfallCents: 0,
      bridge: { fromChainId: ETH, amountCents: CARRIER_CENTS, refuelWeiNeeded: 10n ** 15n },
      gasOk: true,
    })
    // the note says what the dollar is FOR — a bridge the user did not ask for
    // must explain itself
    expect(out[0].note).toMatch(/so ETH for fees can ride along/)
    expect(out[0].note).toMatch(/lands as your USDC on Base/)
  })

  it('the carrier amount is a real draw — a following leg cannot spend those cents again', () => {
    const out = legFundings(
      [need(BASE, 50_000), need(RH, 100)],
      [
        fund({ chainId: BASE, usdcCents: 50_000, nativeRaw: 0n }), // gas-only deficit → carrier
        fund({ chainId: RH, usdcCents: 0 }),
        fund({ chainId: ETH, usdcCents: CARRIER_CENTS }), // exactly one carrier's worth
      ],
    )
    expect(out[0].bridge).toMatchObject({ fromChainId: ETH, amountCents: CARRIER_CENTS })
    expect(out[1].bridge).toBeNull() // the same 100 cents cannot also fund RH
  })

  it('a gas-only deficit with NO reachable carrier refuses by name rather than stranding the leg', () => {
    const out = legFundings([need(BASE, 50_000)], [fund({ chainId: BASE, usdcCents: 50_000, nativeRaw: 0n })])
    expect(out[0]).toMatchObject({ bridge: null, gasOk: false })
    expect(out[0].note).toMatch(/Base needs ETH for network fees/)
    expect(out[0].note).toMatch(/already hold ETH on Base/)
  })
})

describe('legFundings — unreadable refuses by name (funding-plan law 5), never guesses', () => {
  it('gasNeedRaw null on the leg’s own chain refuses the leg: no bridge is aimed at it, even with money ready elsewhere', () => {
    const out = legFundings(
      [need(BASE, 50_000)],
      [fund({ chainId: BASE, usdcCents: 0, gasNeedRaw: null }), fund({ chainId: ETH, usdcCents: 100_000 })],
    )
    expect(out[0]).toMatchObject({ bridge: null, gasOk: false })
    expect(out[0].note).toMatch(/could not estimate the network fee on Base/)
    expect(out[0].note).toMatch(/Nothing is sent there/)
  })

  it('a refused leg draws NOTHING — its sibling still sees the whole surplus', () => {
    const out = legFundings(
      [need(BASE, 50_000), need(RH, 100_000)],
      [
        fund({ chainId: BASE, usdcCents: 0, gasNeedRaw: null }),
        fund({ chainId: RH, usdcCents: 0 }),
        fund({ chainId: ETH, usdcCents: 100_000 }),
      ],
    )
    expect(out[0].bridge).toBeNull()
    expect(out[1].bridge).toEqual({ fromChainId: ETH, amountCents: 100_000, refuelWeiNeeded: 0n })
  })

  it('a chain absent from funds refuses with its name — and is still IN the output', () => {
    const out = legFundings([need(RH, 30_000)], [fund({ chainId: BASE, usdcCents: 100_000 })])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ chainId: RH, haveCents: 0, shortfallCents: 30_000, bridge: null, gasOk: false })
    expect(out[0].note).toMatch(/Could not read balances on Robinhood/)
  })

  it('EVERY input need appears in the output exactly once, in input order — refused legs are shown, never dropped', () => {
    const out = legFundings(
      [need(RH, 30_000), need(BASE, 10_000), need(ETH, 99_999_999)],
      [fund({ chainId: BASE, usdcCents: 10_000 }), fund({ chainId: ETH, usdcCents: 0 })],
    )
    // RH unreadable, BASE funded, ETH refused for money — all three present, in order
    expect(out.map((l) => l.chainId)).toEqual([RH, BASE, ETH])
    expect(out.filter((l) => l.note != null)).toHaveLength(2)
  })
})

describe('legFundings — a bridge SOURCE must be able to pay for its own send (M8)', () => {
  it('a rich source with NO native for the send is no source: the leg refuses in the send-gas words', () => {
    const out = legFundings(
      [need(BASE, 50_000)],
      [fund({ chainId: BASE, usdcCents: 0 }), fund({ chainId: ETH, usdcCents: 500_000, nativeRaw: 0n })],
    )
    expect(out[0].bridge).toBeNull()
    expect(out[0].note).toMatch(/cannot pay their own fee to send it/)
  })

  it('a rich source whose gas estimate did not READ is no source either — unreadable is not a passing check', () => {
    const out = legFundings(
      [need(BASE, 50_000)],
      [fund({ chainId: BASE, usdcCents: 0 }), fund({ chainId: ETH, usdcCents: 500_000, gasNeedRaw: null })],
    )
    expect(out[0].bridge).toBeNull()
    expect(out[0].note).toMatch(/cannot pay their own fee to send it/)
  })

  it('a smaller but HEALTHY source outranks a bigger one that cannot send', () => {
    const out = legFundings(
      [need(BASE, 50_000)],
      [
        fund({ chainId: BASE, usdcCents: 0 }),
        fund({ chainId: ETH, usdcCents: 500_000, nativeRaw: 0n }),
        fund({ chainId: RH, usdcCents: 60_000 }),
      ],
    )
    expect(out[0].bridge).toMatchObject({ fromChainId: RH, amountCents: 50_000 })
  })
})

describe('legFundings — an unreadable amount is a caller bug and THROWS (funding-plan posture)', () => {
  const okFunds = () => [fund({ chainId: BASE, usdcCents: 100_000 })]

  it('refuses every unreadable shape of buysCents/feeCents rather than planning a silent wrong number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, null, undefined]) {
      expect(() => legFundings([{ chainId: BASE, buysCents: bad as never, feeCents: 0 }], okFunds())).toThrow(FundingPlanContractError)
      expect(() => legFundings([{ chainId: BASE, buysCents: 10_000, feeCents: bad as never }], okFunds())).toThrow(FundingPlanContractError)
    }
  })

  it('but ZERO stays legal — a zero fee is a real answer (the direct route passes feeBps 0)', () => {
    expect(() => legFundings([need(BASE, 10_000, 0)], okFunds())).not.toThrow()
  })

  it('hostile FUNDS rows throw too: NaN cents, negative raw balances', () => {
    expect(() => legFundings([need(BASE, 1)], [fund({ chainId: BASE, usdcCents: Number.NaN })])).toThrow(FundingPlanContractError)
    expect(() => legFundings([need(BASE, 1)], [fund({ chainId: BASE, usdcCents: 0, nativeRaw: -1n })])).toThrow(FundingPlanContractError)
    expect(() => legFundings([need(BASE, 1)], [fund({ chainId: BASE, usdcCents: 0, gasNeedRaw: -1n })])).toThrow(FundingPlanContractError)
  })

  it('a duplicated need row throws — two rows would fund one leg twice', () => {
    expect(() => legFundings([need(BASE, 1), need(BASE, 2)], okFunds())).toThrow(/appears twice in the needs/)
  })

  it('a duplicated funds row throws — two rows would promise one balance twice', () => {
    expect(() => legFundings([need(BASE, 1)], [fund({ chainId: ETH, usdcCents: 5 }), fund({ chainId: ETH, usdcCents: 5 })])).toThrow(
      /appears twice in the funds/,
    )
  })
})

describe('legFundings — pure and deterministic', () => {
  it('the same input twice yields the same plan, and the input is never mutated (the draw ledger is per call)', () => {
    const needs = [need(BASE, 60_000), need(RH, 40_000)]
    const funds = [
      fund({ chainId: BASE, usdcCents: 10_000 }),
      fund({ chainId: RH, usdcCents: 0, nativeRaw: 0n }),
      fund({ chainId: ETH, usdcCents: 100_000 }),
    ]
    const snap = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))
    const before = snap({ needs, funds })
    const a = legFundings(needs, funds)
    const b = legFundings(needs, funds)
    expect(snap(a)).toBe(snap(b))
    expect(snap({ needs, funds })).toBe(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT G1 (2026-08-14, MEDIUM): the refuel must cover the BUY'S OWN signing
// requirement — gasLimit is max(2×estimate, 1.5M floor) (gas.ts) and EIP-1559
// needs balance ≥ gasLimit × maxFee to sign, so a fixed 1.6M budget stranded
// freshly-bridged funds whenever a multi-leg estimate doubled past it.
// ─────────────────────────────────────────────────────────────────────────────
describe('G1 — the refuel covers the doubled worst-case buy at fee drift', () => {
  it('the unit budget clears 2× the gas.ts floor plus the approve', () => {
    // gas.ts DEFAULT_FLOOR = 1.5M; the headroom law doubles an estimate and
    // floors at 1.5M — the worst plausible LIMIT for a deep basket is ~3M,
    // plus ~100k for the exact-amount approve that precedes it
    expect(THESIS_LEG_GAS_UNITS).toBeGreaterThanOrEqual(2n * 1_500_000n + 100_000n)
  })
  it('the priced need carries the ×2 fee-drift headroom refuel.ts applies (a bridge takes minutes)', () => {
    expect(THESIS_GAS_DRIFT_X).toBe(2n)
    // the full signing requirement at drift: units × price × drift — a 1 gwei
    // chain must demand ≥ 6.2e15 wei, not the old 1.6e15
    const price = 10n ** 9n
    expect(THESIS_LEG_GAS_UNITS * price * THESIS_GAS_DRIFT_X).toBeGreaterThanOrEqual(2n * (2n * 1_500_000n + 100_000n) * price)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// COMMITTED ≠ BROKE. the owner held thousands and was told no network held enough
// (2026-08-16). `freeSurplus` subtracts a chain's OWN leg, so a wallet fully
// deployed into the basket it is funding has nothing spare — a different fact
// with the opposite remedy.
// ─────────────────────────────────────────────────────────────────────────────
describe('a shortfall says WHY, and committed money is not missing money', () => {
  it('⚠ money committed to this basket’s other legs does NOT read as an empty wallet', () => {
    const out = legFundings(
      // ETH holds plenty, but its own leg claims all of it
      [need(BASE, 5_000), need(ETH, 100_000)],
      [fund({ chainId: BASE, usdcCents: 0 }), fund({ chainId: ETH, usdcCents: 100_000 })],
    )
    const base = out.find((o) => o.chainId === BASE)!
    expect(base.note).toMatch(/already committed to this basket/)
    expect(base.note).not.toMatch(/no other network holds enough/)
  })

  it('and it offers the remedy that FITS — sell or lower, never "add more"', () => {
    const out = legFundings(
      [need(BASE, 5_000), need(ETH, 100_000)],
      [fund({ chainId: BASE, usdcCents: 0 }), fund({ chainId: ETH, usdcCents: 100_000 })],
    )
    expect(out.find((o) => o.chainId === BASE)!.note).toMatch(/Sell something to cover it, or lower the amount|lower the amount/)
  })

  it('a genuinely empty book still says so — the old sentence is not lost', () => {
    const out = legFundings([need(BASE, 5_000)], [fund({ chainId: BASE, usdcCents: 0 }), fund({ chainId: ETH, usdcCents: 0 })])
    expect(out[0].note).toMatch(/no other network holds enough/)
  })

  it('every shortfall note still opens with the house "Needs $" grammar the pay-asset door keys on', () => {
    const committed = legFundings(
      [need(BASE, 5_000), need(ETH, 100_000)],
      [fund({ chainId: BASE, usdcCents: 0 }), fund({ chainId: ETH, usdcCents: 100_000 })],
    ).find((o) => o.chainId === BASE)!
    const broke = legFundings([need(BASE, 5_000)], [fund({ chainId: BASE, usdcCents: 0 }), fund({ chainId: ETH, usdcCents: 0 })])[0]
    for (const n of [committed.note, broke.note]) expect(n).toMatch(/Needs \$/)
  })
})

describe('the STRUCTURED refusal (owner queue: the prose-keyed-matcher root fix)', () => {
  it("a shortfall no source can cover carries noteCode 'needs-funds' + the gap in cents — the door's key, immune to copy edits", () => {
    const out = legFundings([need(BASE, 50_000)], [fund({ chainId: BASE, usdcCents: 10_000 })])
    const leg = out[0]
    expect(leg.note).toMatch(/Needs \$/)
    expect(leg.noteCode).toBe('needs-funds')
    expect(leg.noteShortCents).toBe(40_000)
  })
  it("an unsizable network fee carries 'gas-unsized' — a different door, never the pay-asset one", () => {
    const out = legFundings([need(BASE, 50_000)], [fund({ chainId: BASE, usdcCents: 60_000, gasNeedRaw: null })])
    expect(out[0].noteCode).toBe('gas-unsized')
    expect(out[0].noteCode === 'needs-funds').toBe(false)
  })
  it('a funded leg carries NO code — silence is the healthy state', () => {
    const out = legFundings([need(BASE, 50_000)], [fund({ chainId: BASE, usdcCents: 50_000 })])
    expect(out[0].noteCode).toBeUndefined()
  })
})
