import { describe, expect, it } from 'vitest'
import { CAP, MAX_ASSETS, MIN, sum } from '../../lib/spectrum/weights'
import { Venue, ZERO_POOL_KEY, type BasketRoute } from '../../lib/pools/types'
import type { ReshapeDraft, ReshapeLeg } from './reshape-types'
import {
  compileChains,
  keptTooFewLegsWords,
  mergeUnion,
  unionKey,
  type CompiledChain,
  type UnionEdits,
} from './bundle-union'

// ─────────────────────────────────────────────────────────────────────────────
// The bundle-union model under test: the NO-EDIT INVARIANT first (the fact
// auto-skip rests on), then the union fold, then compileChains phase by phase.
// Every expected weight below is hand-derived from weights.ts's own law
// (borrow-from-largest, MIN 5 · STEP 5 · Σ=100) — the ops are the law and this
// module only sequences them, so the tests assert EXACT arrays throughout.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE: BasketRoute = {
  venue: Venue.V4,
  ethPool: { ...ZERO_POOL_KEY },
  v3Fee: 0,
  v2Pair: '0x0000000000000000000000000000000000000000',
}

const addr = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`

function leg(n: number, symbol: string, name: string | null = null): ReshapeLeg {
  return { address: addr(n), symbol, name, decimals: 18, route: ROUTE }
}

function draftOf(rows: [ReshapeLeg, number][], over: Partial<ReshapeDraft> = {}): ReshapeDraft {
  return {
    name: 'Bullish EVM',
    symbol: 'BEVMV2',
    legs: rows.map(([l]) => l),
    weights: rows.map(([, w]) => w),
    feeConfig: {
      basketFeeBps: 150,
      creatorShareBps: 1000,
      creatorPayout: addr(0xbeef),
      launcher: addr(0xcafe),
    },
    ...over,
  }
}

const mapOf = (...entries: [number, ReshapeDraft][]): ReadonlyMap<number, ReshapeDraft> => new Map(entries)

function editsOf(
  over: { reweights?: [string, number][]; removals?: string[]; adds?: UnionEdits['adds'] } = {},
): UnionEdits {
  return {
    reweights: new Map(over.reweights ?? []),
    removals: new Set(over.removals ?? []),
    adds: over.adds ?? [],
  }
}

function addOf(
  symbol: string,
  weightPct: number,
  perChain: { chainId: number; leg: ReshapeLeg }[],
): UnionEdits['adds'][number] {
  return { key: unionKey(symbol), symbol, weightPct, perChain }
}

function rowFor(rows: CompiledChain[], chainId: number): CompiledChain {
  const row = rows.find((r) => r.chainId === chainId)
  if (!row) throw new Error(`no compiled row for chain ${chainId}`)
  return row
}

/** Every compiled draft must sit exactly on weights.ts's law. */
function expectLawful(d: ReshapeDraft): void {
  expect(d.legs).toHaveLength(d.weights.length)
  expect(sum(d.weights)).toBe(CAP)
  expect(d.weights.every((w) => w >= MIN)).toBe(true)
  expect(d.legs.length).toBeLessThanOrEqual(MAX_ASSETS)
}

// ── THE NO-EDIT INVARIANT — pinned first: this is what makes auto-skip honest ─

describe('THE NO-EDIT INVARIANT (what makes auto-skip honest)', () => {
  it('empty edits compile every chain to changed:false with a draft deep-equal to current — zero drift', () => {
    const base = draftOf([
      [leg(0xb01, 'WETH'), 50],
      [leg(0xb02, 'AERO'), 30],
      [leg(0xb03, 'DEGEN'), 20],
    ])
    const eth = draftOf([
      [leg(0xe01, 'WETH'), 65],
      [leg(0xe02, 'UNI'), 35],
    ])
    // A single-leg chain must ALSO pass untouched — the <2 refusal only fires
    // when a removal caused the shortfall, never on a basket that arrived so.
    const poly = draftOf([[leg(0xf01, 'SOLO'), 100]])

    const rows = compileChains(mapOf([8453, base], [1, eth], [137, poly]), editsOf())

    expect(rows.map((r) => r.chainId)).toEqual([8453, 1, 137]) // input order kept
    for (const [row, current] of [
      [rowFor(rows, 8453), base],
      [rowFor(rows, 1), eth],
      [rowFor(rows, 137), poly],
    ] as const) {
      expect(row.changed).toBe(false)
      expect(row.kept).toBeNull()
      expect(row.unresolvedAdds).toEqual([])
      expect(row.draft).toEqual(current) // exactly as it went in
    }
    expect(rowFor(rows, 8453).draft!.weights).toEqual([50, 30, 20]) // untouched by any round-trip
    expect(rowFor(rows, 137).draft!.weights).toEqual([100])
  })
})

// ── the union fold (the one edit surface's rows) ─────────────────────────────

describe('unionKey + mergeUnion', () => {
  it('folds by case-folded symbol: one entry per asset, one perChain row per chain, display case first-seen', () => {
    expect(unionKey('WETH')).toBe(unionKey('weth'))

    const base = draftOf([
      [leg(0xb01, 'WETH'), 50], // no name on this chain
      [leg(0xb02, 'AERO'), 50],
    ])
    const eth = draftOf([
      [leg(0xe01, 'weth', 'Wrapped Ether'), 25], // same asset, different case + address
      [leg(0xe02, 'UNI'), 75],
    ])
    const arb = draftOf([
      [leg(0xa01, 'WETH'), 40],
      [leg(0xa02, 'GMX'), 60],
    ])

    const union = mergeUnion(mapOf([8453, base], [1, eth], [42161, arb]))

    const weth = union.find((e) => e.key === 'weth')!
    expect(weth.symbol).toBe('WETH') // first-seen case, not eth's lowercase
    expect(weth.name).toBe('Wrapped Ether') // first non-null name across the fold
    expect(weth.perChain.map((p) => [p.chainId, p.weightPct])).toEqual([
      [8453, 50],
      [1, 25],
      [42161, 40],
    ])
    // each row keeps ITS chain's own leg — addresses differ per chain by construction
    expect(weth.perChain.map((p) => p.leg.address)).toEqual([addr(0xb01), addr(0xe01), addr(0xa01)])
    expect(union).toHaveLength(4) // WETH folded; AERO, UNI, GMX single-chain
  })

  it('orders by combined weight desc; ties keep first-seen order (stable)', () => {
    const a = draftOf([
      [leg(0x11, 'X'), 60],
      [leg(0x12, 'Y'), 40],
    ])
    const b = draftOf([
      [leg(0x21, 'Z'), 40],
      [leg(0x22, 'W'), 60],
    ])
    const union = mergeUnion(mapOf([8453, a], [1, b]))
    // combined: X 60 · W 60 · Y 40 · Z 40 — ties broken by first-seen
    expect(union.map((e) => e.symbol)).toEqual(['X', 'W', 'Y', 'Z'])
  })
})

// ── compileChains · reweights ────────────────────────────────────────────────

describe('compileChains — reweights', () => {
  it('one reweight converges every chain that holds the key; absorption follows the law (largest-first)', () => {
    const base = draftOf([
      [leg(0xb01, 'WETH'), 20],
      [leg(0xb02, 'AERO'), 50],
      [leg(0xb03, 'DEGEN'), 30],
    ])
    const eth = draftOf([
      [leg(0xe01, 'WETH'), 25],
      [leg(0xe02, 'UNI'), 75],
    ])
    const arb = draftOf([
      [leg(0xa01, 'ARB'), 60], // does not hold WETH — must not be touched
      [leg(0xa02, 'GMX'), 40],
    ])

    const rows = compileChains(
      mapOf([8453, base], [1, eth], [42161, arb]),
      editsOf({ reweights: [['weth', 30]] }),
    )

    const b = rowFor(rows, 8453)
    expect(b.changed).toBe(true)
    expect(b.draft!.weights).toEqual([30, 40, 30]) // +10 borrowed from AERO, the largest
    const e = rowFor(rows, 1)
    expect(e.changed).toBe(true)
    expect(e.draft!.weights).toEqual([30, 70])
    const a = rowFor(rows, 42161)
    expect(a.changed).toBe(false)
    expect(a.draft).toEqual(arb)
    for (const r of rows) expectLawful(r.draft!)
  })

  it('a reweight already satisfied on one chain marks only the differing chain changed', () => {
    const base = draftOf([
      [leg(0xb01, 'WETH'), 30], // already at the target
      [leg(0xb02, 'AERO'), 70],
    ])
    const eth = draftOf([
      [leg(0xe01, 'WETH'), 25],
      [leg(0xe02, 'UNI'), 75],
    ])
    const rows = compileChains(mapOf([8453, base], [1, eth]), editsOf({ reweights: [['weth', 30]] }))
    expect(rowFor(rows, 8453).changed).toBe(false) // ships nothing — auto-skip
    expect(rowFor(rows, 1).changed).toBe(true)
    expect(rowFor(rows, 1).draft!.weights).toEqual([30, 70])
  })

  it('targets pass through the op: snapped to STEP', () => {
    const base = draftOf([
      [leg(1, 'T1'), 50],
      [leg(2, 'T2'), 30],
      [leg(3, 'T3'), 20],
    ])
    const rows = compileChains(mapOf([8453, base]), editsOf({ reweights: [['t2', 33]] }))
    expect(rowFor(rows, 8453).draft!.weights).toEqual([45, 35, 20]) // 33 → 35, borrowed from T1
  })

  it('targets pass through the op: clamped to MIN at the floor and CAP−MIN·(n−1) at the ceiling', () => {
    const mk = () =>
      draftOf([
        [leg(1, 'T1'), 50],
        [leg(2, 'T2'), 30],
        [leg(3, 'T3'), 20],
      ])
    const floor = compileChains(mapOf([8453, mk()]), editsOf({ reweights: [['t2', 2]] }))
    // 2 snaps to 0 (STEP), the floor holds it at MIN (=1); freed 29 to the largest
    expect(rowFor(floor, 8453).draft!.weights).toEqual([79, MIN, 20])

    const ceiling = compileChains(mapOf([8453, mk()]), editsOf({ reweights: [['t1', 97]] }))
    // 97 snaps to 95 — inside the MIN=1 ceiling (98), so it lands as snapped;
    // the others pay 45 largest-first down to the floor
    expect(rowFor(ceiling, 8453).draft!.weights).toEqual([95, MIN, 4])
  })

  it('a single-leg chain cannot reweight (the op refuses) — it simply compiles unchanged', () => {
    const poly = draftOf([[leg(0xf01, 'SOLO'), 100]])
    const rows = compileChains(mapOf([137, poly]), editsOf({ reweights: [['solo', 50]] }))
    const row = rowFor(rows, 137)
    expect(row.changed).toBe(false)
    expect(row.kept).toBeNull()
    expect(row.draft!.weights).toEqual([100])
  })
})

// ── compileChains · removals ─────────────────────────────────────────────────

describe('compileChains — removals', () => {
  it("a removal hands the freed weight to the largest remaining (removeDraftLeg's law)", () => {
    const base = draftOf([
      [leg(1, 'T1'), 50],
      [leg(2, 'T2'), 30],
      [leg(3, 'T3'), 20],
    ])
    const rows = compileChains(mapOf([8453, base]), editsOf({ removals: ['t2'] }))
    const row = rowFor(rows, 8453)
    expect(row.changed).toBe(true)
    expect(row.draft!.legs.map((l) => l.symbol)).toEqual(['T1', 'T3'])
    expect(row.draft!.weights).toEqual([80, 20]) // T2's 30 handed to T1, the largest
    expectLawful(row.draft!)
  })

  it('a removal down to ONE leg SHIPS (supersedes the two-leg law — MIN_ASSETS is 1); removal to ZERO refuses with the kept sentence', () => {
    const base = draftOf([
      [leg(0xb01, 'WETH'), 40],
      [leg(0xb02, 'PEPE'), 30],
      [leg(0xb03, 'DOGE'), 30],
    ])
    const eth = draftOf([
      [leg(0xe01, 'WETH'), 60],
      [leg(0xe02, 'PEPE'), 40],
    ])
    const rows = compileChains(
      mapOf([8453, base], [1, eth]),
      editsOf({ removals: ['pepe'], adds: [addOf('NEW', 10, [{ chainId: 8453, leg: leg(0xb0a, 'NEW') }])] }),
    )

    // eth: removing PEPE leaves WETH alone — a LAWFUL single-asset version now.
    const e = rowFor(rows, 1)
    expect(e.draft).not.toBeNull()
    expect(e.changed).toBe(true)
    expect(e.draft!.legs.map((l) => l.symbol)).toEqual(['WETH'])
    expect(e.draft!.weights).toEqual([100])
    expect(e.unresolvedAdds).toEqual(['NEW']) // the no-route add is still stated

    // base: the same edit applies cleanly.
    const b = rowFor(rows, 8453)
    expect(b.changed).toBe(true)
    expect(b.draft!.legs.map((l) => l.symbol)).toEqual(['WETH', 'DOGE', 'NEW'])
    expect(b.draft!.weights).toEqual([60, 30, 10])
    expectLawful(b.draft!)

    // removal to ZERO still refuses, with the sentence saying what happened.
    const zero = compileChains(mapOf([1, draftOf([[leg(0xe01, 'WETH'), 100]])]), editsOf({ removals: ['weth'] }))
    const z = rowFor(zero, 1)
    expect(z.draft).toBeNull()
    expect(z.kept).toBe(keptTooFewLegsWords(0))
    expect(z.kept).toMatch(/no assets at all/)
  })

  it('an add rescues a removal: remove one of two, add a replacement → a lawful 2-leg draft, no refusal', () => {
    const eth = draftOf([
      [leg(0xe01, 'WETH'), 60],
      [leg(0xe02, 'PEPE'), 40],
    ])
    const rows = compileChains(
      mapOf([1, eth]),
      editsOf({ removals: ['pepe'], adds: [addOf('SOL', 20, [{ chainId: 1, leg: leg(0xe0a, 'SOL') }])] }),
    )
    const row = rowFor(rows, 1)
    expect(row.kept).toBeNull()
    expect(row.changed).toBe(true)
    expect(row.draft!.legs.map((l) => l.symbol)).toEqual(['WETH', 'SOL'])
    expect(row.draft!.weights).toEqual([80, 20])
    expectLawful(row.draft!)
  })
})

// ── compileChains · adds ─────────────────────────────────────────────────────

describe('compileChains — adds', () => {
  it('an add lands at its target on resolved chains and is stated in unresolvedAdds elsewhere', () => {
    const base = draftOf([
      [leg(0xb01, 'T1'), 50],
      [leg(0xb02, 'T2'), 50],
    ])
    const eth = draftOf([
      [leg(0xe01, 'E1'), 60],
      [leg(0xe02, 'E2'), 40],
    ])
    const rows = compileChains(
      mapOf([8453, base], [1, eth]),
      editsOf({ adds: [addOf('NEW', 20, [{ chainId: 8453, leg: leg(0xb0a, 'NEW') }])] }),
    )

    const b = rowFor(rows, 8453)
    expect(b.changed).toBe(true)
    expect(b.unresolvedAdds).toEqual([])
    expect(b.draft!.legs.map((l) => l.symbol)).toEqual(['T1', 'T2', 'NEW'])
    expect(b.draft!.weights).toEqual([45, 35, 20]) // in at MIN off T1, risen to 20 off T2 — the law's path
    expectLawful(b.draft!)

    const e = rowFor(rows, 1)
    expect(e.changed).toBe(false)
    expect(e.unresolvedAdds).toEqual(['NEW']) // no route here — stated, never silent
    expect(e.draft).toEqual(eth)
  })

  it('an add under MIN lands at MIN (the op clamps; nothing bends the law)', () => {
    const base = draftOf([
      [leg(0xb01, 'T1'), 50],
      [leg(0xb02, 'T2'), 50],
    ])
    const rows = compileChains(
      mapOf([8453, base]),
      editsOf({ adds: [addOf('NEW', 2, [{ chainId: 8453, leg: leg(0xb0a, 'NEW') }])] }),
    )
    const row = rowFor(rows, 8453)
    // lands at ADD_AT (borrowed from the largest), then the 2% target snaps to
    // 0 and the floor holds it at MIN (=1) — the freed 4 return to the largest
    expect(row.draft!.weights).toEqual([45, 54, MIN])
    expectLawful(row.draft!)
  })

  it('an add past MAX_ASSETS does not land there — stated via unresolvedAdds, the chain otherwise untouched', () => {
    // 20 legs × MIN is the only lawful full basket (Σ=100 forces every leg to 5).
    const full = draftOf(
      Array.from({ length: MAX_ASSETS }, (_, i) => [leg(0x100 + i, `F${i}`), MIN] as [ReshapeLeg, number]),
    )
    const roomy = draftOf([
      [leg(0xe01, 'A'), 60],
      [leg(0xe02, 'B'), 40],
    ])
    const rows = compileChains(
      mapOf([8453, full], [1, roomy]),
      editsOf({
        adds: [
          addOf('X', 10, [
            { chainId: 8453, leg: leg(0xb0a, 'X') },
            { chainId: 1, leg: leg(0xe0a, 'X') },
          ]),
        ],
      }),
    )

    const f = rowFor(rows, 8453)
    expect(f.unresolvedAdds).toEqual(['X']) // the op refused the append — the ceiling holds
    expect(f.changed).toBe(false)
    expect(f.draft).toEqual(full)

    const r = rowFor(rows, 1)
    expect(r.unresolvedAdds).toEqual([])
    expect(r.draft!.weights).toEqual([50, 40, 10])
    expectLawful(r.draft!)
  })

  it('an add whose key a chain already holds becomes a weight target there — never a duplicate leg', () => {
    const base = draftOf([
      [leg(0xb01, 'T1'), 90],
      [leg(0xb02, 'PEPE'), 10],
    ])
    const rows = compileChains(
      mapOf([8453, base]),
      editsOf({ adds: [addOf('PEPE', 20, [{ chainId: 8453, leg: leg(0xb0f, 'PEPE') }])] }),
    )
    const row = rowFor(rows, 8453)
    expect(row.unresolvedAdds).toEqual([])
    expect(row.draft!.legs.map((l) => l.symbol)).toEqual(['T1', 'PEPE']) // still one PEPE
    expect(row.draft!.weights).toEqual([80, 20])
    expectLawful(row.draft!)
  })
})

// ── compileChains · precedence (the phase order is the law) ──────────────────

describe('compileChains — precedence', () => {
  it('removal wins over a reweight of the same key — no resurrection', () => {
    const base = draftOf([
      [leg(0xb01, 'WETH'), 40],
      [leg(0xb02, 'PEPE'), 30],
      [leg(0xb03, 'DOGE'), 30],
    ])
    const rows = compileChains(
      mapOf([8453, base]),
      editsOf({ removals: ['pepe'], reweights: [['pepe', 50]] }),
    )
    const row = rowFor(rows, 8453)
    expect(row.draft!.legs.some((l) => l.symbol === 'PEPE')).toBe(false)
    expect(row.draft!.weights).toEqual([70, 30]) // the removal's law, no reweight ghost
    expect(row.changed).toBe(true)
  })

  it('a reweight of an added key applies exactly where the add landed', () => {
    const base = draftOf([
      [leg(0xb01, 'T1'), 50],
      [leg(0xb02, 'T2'), 50],
    ])
    const eth = draftOf([
      [leg(0xe01, 'E1'), 60],
      [leg(0xe02, 'E2'), 40],
    ])
    const rows = compileChains(
      mapOf([8453, base], [1, eth]),
      editsOf({
        adds: [addOf('NEW', 10, [{ chainId: 8453, leg: leg(0xb0a, 'NEW') }])],
        reweights: [['new', 20]],
      }),
    )
    const b = rowFor(rows, 8453)
    expect(b.draft!.weights).toEqual([35, 45, 20]) // landed at 10, then reweighted to 20
    expectLawful(b.draft!)
    const e = rowFor(rows, 1)
    expect(e.changed).toBe(false) // the add never landed here, so neither does its reweight
    expect(e.unresolvedAdds).toEqual(['NEW'])
  })

  it('a remove/re-add landing the identical mix compiles changed:false — order-insensitive honesty', () => {
    const t2 = leg(2, 'T2')
    const base = draftOf([
      [leg(1, 'T1'), 50],
      [t2, 30],
      [leg(3, 'T3'), 20],
    ])
    const rows = compileChains(
      mapOf([8453, base]),
      editsOf({ removals: ['t2'], adds: [addOf('T2', 30, [{ chainId: 8453, leg: t2 }])] }),
    )
    const row = rowFor(rows, 8453)
    // the leg list reordered (T2 re-entered at the end)…
    expect(row.draft!.legs.map((l) => l.symbol)).toEqual(['T1', 'T3', 'T2'])
    // …but the address→weight mix is exactly the current basket: ships nothing.
    expect(row.draft!.weights).toEqual([50, 20, 30])
    expect(row.changed).toBe(false)
    expect(row.kept).toBeNull()
  })
})

// ── the compound edit — everything at once stays lawful ──────────────────────

describe('compileChains — compound edit', () => {
  it('remove + add + reweight compile every chain to the law, identity fields carried untouched', () => {
    const base = draftOf([
      [leg(0xb01, 'WETH'), 40],
      [leg(0xb02, 'TOSHI'), 30],
      [leg(0xb03, 'AERO'), 20],
      [leg(0xb04, 'BRETT'), 10],
    ])
    const eth = draftOf([
      [leg(0xe01, 'WETH'), 60],
      [leg(0xe02, 'TOSHI'), 40],
    ])
    const rows = compileChains(
      mapOf([8453, base], [1, eth]),
      editsOf({
        removals: ['brett'], // only base holds it
        adds: [
          addOf('NEW', 15, [
            { chainId: 8453, leg: leg(0xb0a, 'NEW') },
            { chainId: 1, leg: leg(0xe0a, 'NEW') },
          ]),
        ],
        reweights: [['weth', 30]],
      }),
    )

    const b = rowFor(rows, 8453)
    expect(b.changed).toBe(true)
    expect(b.draft!.legs.map((l) => l.symbol)).toEqual(['WETH', 'TOSHI', 'AERO', 'NEW'])
    expect(b.draft!.weights).toEqual([30, 35, 20, 15])
    expectLawful(b.draft!)

    const e = rowFor(rows, 1)
    expect(e.changed).toBe(true)
    expect(e.draft!.legs.map((l) => l.symbol)).toEqual(['WETH', 'TOSHI', 'NEW'])
    expect(e.draft!.weights).toEqual([30, 55, 15])
    expectLawful(e.draft!)

    // Identity is not this module's to edit — carried through verbatim.
    for (const [row, current] of [
      [b, base],
      [e, eth],
    ] as const) {
      expect(row.draft!.name).toBe(current.name)
      expect(row.draft!.symbol).toBe(current.symbol)
      expect(row.draft!.feeConfig).toBe(current.feeConfig) // same reference — never rebuilt
    }
  })
})
