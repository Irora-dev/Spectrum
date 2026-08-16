import { describe, expect, it } from 'vitest'
import type { PublicClient } from 'viem'
import {
  BARE_SPLIT_NOT_DERIVABLE_SELECTOR,
  MISSING_HOOK_DATA_SELECTOR,
  bareLegMinsAbi,
  decodeBareLegMin,
  readContractSplit,
} from './contract-split'

// ─────────────────────────────────────────────────────────────────────────────
// The packed shape is contracts' spec verbatim: split bps in bits [255:240],
// floor in [239:0]. Their side is still moving, so every assumption their spec
// gave us is PINNED here — if their landing shifts the shape, these break
// loudly instead of the comparison silently reading garbage.
// ─────────────────────────────────────────────────────────────────────────────

const pack = (splitBps: bigint, floorRaw: bigint) => (splitBps << 240n) | floorRaw

const FACTORY = '0x07Bfce0976b205FcfDF115F7aD1401Ab1f197e6f' as const
const BASKET = '0x0000000000000000000000000000000000000b0b' as const

/** A PublicClient stand-in whose readContract resolves or throws as directed. */
const clientThat = (behaviour: () => Promise<readonly bigint[]>): PublicClient =>
  ({ readContract: behaviour }) as unknown as PublicClient

describe('decodeBareLegMin: the packed word', () => {
  it('unpacks split and floor from the spec positions', () => {
    const { splitBps, floorRaw } = decodeBareLegMin(pack(3400n, 123_456_789_000_000_000n))
    expect(splitBps).toBe(3400)
    expect(floorRaw).toBe(123_456_789_000_000_000n)
  })

  it('survives the extremes: full split, giant floor', () => {
    const maxFloor = (1n << 240n) - 1n
    const { splitBps, floorRaw } = decodeBareLegMin(pack(10_000n, maxFloor))
    expect(splitBps).toBe(10_000)
    expect(floorRaw).toBe(maxFloor)
  })

  it('reads the 9999/0 failure shape contracts measured', () => {
    expect(decodeBareLegMin(pack(9999n, 1n)).splitBps).toBe(9999)
    expect(decodeBareLegMin(pack(0n, 0n))).toEqual({ splitBps: 0, floorRaw: 0n })
  })

  it('a floor never bleeds into the split bits', () => {
    // The largest possible floor must leave the split untouched.
    expect(decodeBareLegMin(pack(425n, (1n << 240n) - 1n)).splitBps).toBe(425)
  })
})

describe('the pinned contract shape', () => {
  it('pins the call signature the comparison relies on', () => {
    // One function, address + uint256 in, uint256[] out. A different shape on
    // their side must fail HERE, not deep in a quote path.
    expect(bareLegMinsAbi).toHaveLength(1)
    const fn = bareLegMinsAbi[0]
    expect(fn.name).toBe('bareLegMins')
    expect(fn.stateMutability).toBe('view')
    expect(fn.inputs.map((i) => i.type)).toEqual(['address', 'uint256'])
    expect(fn.outputs.map((o) => o.type)).toEqual(['uint256[]'])
  })

  it('pins the BareSplitNotDerivable selector', () => {
    // keccak("BareSplitNotDerivable()")[0..4]. If contracts land the error with
    // arguments (a different signature), this literal changes — and this test
    // is the loud place that says so.
    expect(BARE_SPLIT_NOT_DERIVABLE_SELECTOR).toBe('0xebb958bd')
  })
})

describe('readContractSplit: three outcomes, never a throw', () => {
  it('decodes a good read', async () => {
    const client = clientThat(async () => [pack(3400n, 5n), pack(3300n, 7n), pack(3300n, 9n)])
    const res = await readContractSplit(client, FACTORY, BASKET, 1_000_000n)
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.legs.map((l) => l.splitBps)).toEqual([3400, 3300, 3300])
      expect(res.legs.map((l) => l.floorRaw)).toEqual([5n, 7n, 9n])
    }
  })

  it('a PRE-PACKING factory that ANSWERS with plain floors is unavailable, not ok', async () => {
    // Measured on live 4663 (calibration harness, 2026-08-03): bareLegMins
    // exists pre-rev and returns UNPACKED floors — all-zero splits after the
    // bit decode. Treating that as ok would refuse-to-quote every live basket.
    // The rule is exact, not a tolerance (contracts, same day): a succeeding
    // packing factory never answers all-zero splits, so all-zero top fields
    // prove the pre-packing format.
    const client = clientThat(async () => [123_456n, 789_012n, 345_678n]) // plain floors, no top bits
    expect((await readContractSplit(client, FACTORY, BASKET, 1_000_000n)).kind).toBe('unavailable')
  })

  it('ONE non-zero top field proves the packed format — ok even far under a 10000 sum', async () => {
    // Pins the exact discriminator over the retired sum<5000 heuristic: a
    // floor (~1e30 max) cannot reach the 2^240 field, so a single non-zero
    // [255:240] is only ever a split — the answer is packed, and judging its
    // CONTENT belongs to the guard layers, not the format check.
    const client = clientThat(async () => [pack(100n, 5n), 7n, 9n])
    const res = await readContractSplit(client, FACTORY, BASKET, 1_000_000n)
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') expect(res.legs.map((l) => l.splitBps)).toEqual([100, 0, 0])
  })

  it('an EMPTY revert is a pre-rev factory: unavailable, not an error', async () => {
    // A call to a missing selector reverts with no data. Every factory deployed
    // before the rev takes this path, and it must read as "the cross-check did
    // not run", never as the contract refusing.
    const client = clientThat(async () => {
      throw Object.assign(new Error('execution reverted'), { data: '0x' })
    })
    expect((await readContractSplit(client, FACTORY, BASKET, 1n)).kind).toBe('unavailable')
  })

  it('a plain network failure also reads unavailable', async () => {
    const client = clientThat(async () => {
      throw new Error('fetch failed')
    })
    expect((await readContractSplit(client, FACTORY, BASKET, 1n)).kind).toBe('unavailable')
  })

  it('the NAMED refusal is a hard signal, found even when nested', async () => {
    // viem nests revert data under cause chains depending on transport; the
    // walker must find it there, because swallowing this one is the failure
    // mode the spec called out by name.
    const client = clientThat(async () => {
      const inner = Object.assign(new Error('reverted'), { data: `${BARE_SPLIT_NOT_DERIVABLE_SELECTOR}` })
      throw Object.assign(new Error('call failed'), { cause: inner })
    })
    const res = await readContractSplit(client, FACTORY, BASKET, 1n)
    expect(res).toEqual({ kind: 'not-derivable', named: true })
  })

  it('viem’s decoded errorName counts as the named refusal too', async () => {
    const client = clientThat(async () => {
      throw Object.assign(new Error('reverted'), { errorName: 'BareSplitNotDerivable' })
    })
    const res = await readContractSplit(client, FACTORY, BASKET, 1n)
    expect(res).toEqual({ kind: 'not-derivable', named: true })
  })

  it('any OTHER data-carrying revert from a factory that has the function still refuses', async () => {
    // The factory spoke and said no. Unknown reasons do not get optimism.
    const client = clientThat(async () => {
      throw Object.assign(new Error('reverted'), { data: '0xdeadbeef00' })
    })
    const res = await readContractSplit(client, FACTORY, BASKET, 1n)
    expect(res).toEqual({ kind: 'not-derivable', named: false })
  })

  // A payload shape is DECIDED from this read (mint-funding.ts), so "no split" has to
  // say whether the DEPLOYMENT has none or whether we simply never reached it. Guessing
  // "pre-packing" on a flaky RPC is how a zero-split payload would ship again.
  it('says WHY there is no split: the deployment, or a read that did not land', async () => {
    const unpacked = await readContractSplit(clientThat(async () => [123n, 456n]), FACTORY, BASKET, 1n)
    expect(unpacked).toEqual({ kind: 'unavailable', why: 'unpacked' })

    const missingFn = await readContractSplit(
      clientThat(async () => {
        throw Object.assign(new Error('execution reverted'), { data: '0x' })
      }),
      FACTORY,
      BASKET,
      1n,
    )
    expect(missingFn).toEqual({ kind: 'unavailable', why: 'no-function' })

    const offline = await readContractSplit(
      clientThat(async () => {
        throw new Error('fetch failed')
      }),
      FACTORY,
      BASKET,
      1n,
    )
    expect(offline).toEqual({ kind: 'unavailable', why: 'read-failed' })
  })

  it('the lens first-mint refusal (MissingHookData) is reported as such, not as distrust', async () => {
    // SpectrumFactory.sol:347 — every unseeded basket hits this by design, and a first
    // buy must not read as "this basket cannot be priced".
    const bySelector = await readContractSplit(
      clientThat(async () => {
        throw Object.assign(new Error('reverted'), { data: MISSING_HOOK_DATA_SELECTOR })
      }),
      FACTORY,
      BASKET,
      1n,
    )
    expect(bySelector).toEqual({ kind: 'not-derivable', named: false, firstMint: true })

    const byName = await readContractSplit(
      clientThat(async () => {
        throw Object.assign(new Error('reverted'), { errorName: 'MissingHookData' })
      }),
      FACTORY,
      BASKET,
      1n,
    )
    expect(byName).toEqual({ kind: 'not-derivable', named: false, firstMint: true })
  })

  it('refuses to read a nonsense amount without calling the chain', async () => {
    let called = false
    const client = clientThat(async () => {
      called = true
      return []
    })
    expect((await readContractSplit(client, FACTORY, BASKET, 0n)).kind).toBe('unavailable')
    expect(called).toBe(false)
  })
})
