import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, zeroAddress, type Address, type Hex } from 'viem'
import {
  directSwapWrapperAbi,
  directSwapWrapperAbiGen2,
  swapWithFeeCall,
  wrapperFeeRaw,
  WRAPPER_MAX_DEADLINE_SEC,
  WRAPPER_MAX_FEE_BPS,
} from './direct-swap-wrapper'
import { deploymentFor } from '../chain/deployments'

// gen-2 pins flip the GENERATION only — every other deployment fact stays the
// real book's, so the seated/unseated guards keep meaning what they meant
// the real book is generation 2 since the gen-3 ceremony — tests of the
// RETAINED gen-1 call shape force 1, gen-2 tests force 2, book tests force none
const force: { gen: 1 | 2 | null } = { gen: null }
const gen2 = {
  get on() {
    return force.gen === 2
  },
  set on(v: boolean) {
    force.gen = v ? 2 : null
  },
}
vi.mock('../chain/deployments', async (orig) => {
  const real = (await orig()) as typeof import('../chain/deployments')
  return { ...real, feeGenerationFor: (id: number) => force.gen ?? real.feeGenerationFor(id) }
})

// ─────────────────────────────────────────────────────────────────────────────
// THE WRAPPER CALL BUILDER, PINNED (SpectrumContracts w-91 integration brief,
// 2026-08-16). The laws under test are the CONTRACT's own: exclusive floor
// fee · native value = sellAmount + fee byte-exact · ERC-20 value = 0 ·
// feeBps ceiling inclusive at 200 · deadline capped 24h · null (keep the
// direct path) whenever the wrapper is unseated or the recipient is missing —
// a misconfiguration keeps today's lane, never invents an address.
// ─────────────────────────────────────────────────────────────────────────────

const PRISM = '0xcf4d29f14cc585ddd1167f956092852af844e040' as Address
const SINK = '0x1111111111111111111111111111111111111111' as Address
const POOL_DATA = '0x3593564cdeadbeef' as Hex
const NOW = 1_760_000_000

const call = (over: Partial<Parameters<typeof swapWithFeeCall>[0]> = {}) =>
  swapWithFeeCall({
    chainId: 1,
    sellToken: null,
    sellAmount: 10n ** 18n,
    buyToken: PRISM,
    minBuyAmount: 5n * 10n ** 18n,
    poolData: POOL_DATA,
    feeBps: 40,
    feeRecipient: SINK,
    nowSec: NOW,
    ...over,
  })

const seated = deploymentFor(1).directSwapWrapper != null

describe('wrapperFeeRaw — the contract’s exclusive floor fee', () => {
  it('floors exactly like solidity integer division', () => {
    expect(wrapperFeeRaw(10n ** 18n, 40)).toBe(4n * 10n ** 15n)
    expect(wrapperFeeRaw(10_001n, 40)).toBe(40n) // 10_001*40/10_000 = 40.004 → 40
    expect(wrapperFeeRaw(1n, 40)).toBe(0n) // dust below one unit of fee
  })
})

describe('swapWithFeeCall', () => {
  // these pin the RETAINED generation-1 call shape (legacy chains keep it);
  // the live book is gen-2 now, so the shape under test is forced explicitly
  beforeEach(() => {
    force.gen = 1
  })
  afterEach(() => {
    force.gen = null
  })
  it.skipIf(!seated)('native input sends sellAmount + fee EXACTLY, and the args round-trip', () => {
    const c = call()!
    expect(c).not.toBeNull()
    expect(c.feeRaw).toBe(wrapperFeeRaw(10n ** 18n, 40))
    expect(c.value).toBe(10n ** 18n + c.feeRaw)
    const dec = decodeFunctionData({ abi: directSwapWrapperAbi, data: c.data })
    expect(dec.functionName).toBe('swapWithFee')
    const [sellToken, sellAmount, buyToken, minBuy, poolData, feeBps, feeRecipient, deadline] = dec.args
    expect(sellToken).toBe(zeroAddress) // native = address(0), the contract's form
    expect(sellAmount).toBe(10n ** 18n)
    expect(String(buyToken).toLowerCase()).toBe(PRISM) // decode re-checksums
    expect(minBuy).toBe(5n * 10n ** 18n)
    expect(poolData).toBe(POOL_DATA) // VERBATIM — no wrapper-specific encoding
    expect(feeBps).toBe(40)
    expect(feeRecipient).toBe(SINK)
    expect(deadline).toBe(BigInt(NOW + 1200))
  })

  it.skipIf(!seated)('ERC-20 input carries ZERO value — the fee travels in the sell token', () => {
    const c = call({ sellToken: PRISM })!
    expect(c.value).toBe(0n)
    const dec = decodeFunctionData({ abi: directSwapWrapperAbi, data: c.data })
    expect(String(dec.args[0]).toLowerCase()).toBe(PRISM)
  })

  it.skipIf(!seated)('the feeBps ceiling is INCLUSIVE at 200 — exactly 200 builds, 201 keeps the direct path', () => {
    expect(call({ feeBps: WRAPPER_MAX_FEE_BPS })).not.toBeNull()
    expect(call({ feeBps: WRAPPER_MAX_FEE_BPS + 1 })).toBeNull()
    expect(call({ feeBps: -1 })).toBeNull()
    expect(call({ feeBps: 40.5 })).toBeNull()
  })

  it.skipIf(!seated)('the deadline clamps to the contract’s 24h horizon', () => {
    const c = call({ deadlineAheadSec: 10 * 24 * 3600 })!
    const dec = decodeFunctionData({ abi: directSwapWrapperAbi, data: c.data })
    expect(dec.args[7]).toBe(BigInt(NOW + WRAPPER_MAX_DEADLINE_SEC))
  })

  it('a missing or zero fee recipient keeps the direct path — never a zero-sink fee', () => {
    expect(call({ feeRecipient: null })).toBeNull()
    expect(call({ feeRecipient: zeroAddress })).toBeNull()
  })

  it('an unseated chain keeps the direct path', () => {
    // 999999 is no chain of ours — deploymentFor returns empty fields
    expect(call({ chainId: 999_999 })).toBeNull()
  })

  it.skipIf(!seated)('a non-positive sell amount never builds a call', () => {
    expect(call({ sellAmount: 0n })).toBeNull()
    expect(call({ sellAmount: -1n })).toBeNull()
  })
})


describe('generation 2 (the production fee model) — feeRecipient GONE from the call', () => {
  it('gen-2 encodes SEVEN args through the gen-2 ABI, no recipient anywhere in the calldata', () => {
    if (!seated) return // the committed book seats no wrapper; the local never-commit json does
    gen2.on = true
    try {
      const c = call({ feeRecipient: null })
      expect(c).not.toBeNull()
      const decoded = decodeFunctionData({ abi: directSwapWrapperAbiGen2, data: c!.data })
      expect(decoded.functionName).toBe('swapWithFee')
      expect(decoded.args).toHaveLength(7)
      // the sink must not appear in the bytes at all
      expect(c!.data.toLowerCase().includes(SINK.slice(2).toLowerCase())).toBe(false)
    } finally {
      gen2.on = false
    }
  })

  it('gen-2: a missing feeRecipient does NOT keep the direct path — there is no recipient to be missing', () => {
    if (!seated) return
    gen2.on = true
    try {
      expect(call({ feeRecipient: null })).not.toBeNull()
      expect(call({ feeRecipient: zeroAddress })).not.toBeNull()
    } finally {
      gen2.on = false
    }
  })

  it('gen-1 (forced): eight args, recipient in the bytes, null-recipient keeps the direct path', () => {
    if (!seated) return
    force.gen = 1
    const c = call()
    expect(c).not.toBeNull()
    const decoded = decodeFunctionData({ abi: directSwapWrapperAbi, data: c!.data })
    expect(decoded.args).toHaveLength(8)
    expect(call({ feeRecipient: null })).toBeNull()
  })

  it('the two generations produce DIFFERENT selectors — a cross-aim cannot parse', () => {
    if (!seated) return
    gen2.on = true
    let g2: Hex
    try {
      g2 = call({ feeRecipient: null })!.data
    } finally {
      gen2.on = false
    }
    force.gen = 1
    const g1 = call()!.data
    force.gen = null
    expect(g1.slice(0, 10)).not.toBe(g2.slice(0, 10))
    expect(() => decodeFunctionData({ abi: directSwapWrapperAbi, data: g2 })).toThrow()
  })
})

describe('the bounds are exactly the contract’s — [0, 200] fee, floors at zero lawful here (the audit sweep’s :133/:134 edges)', () => {
  const base = {
    chainId: 4663,
    sellToken: null,
    sellAmount: 1_000_000n,
    buyToken: '0x1111111111111111111111111111111111111111' as const,
    minBuyAmount: 0n,
    poolData: '0x00' as const,
    feeRecipient: null,
    nowSec: 1_700_000_000,
  }
  it('feeBps 0 composes (a feeless wrapped call is lawful input; the RATE is the composer’s law, not this builder’s)', () => {
    const call = swapWithFeeCall({ ...base, feeBps: 0 })
    expect(call).not.toBeNull()
    expect(call!.feeRaw).toBe(0n)
    expect(call!.value).toBe(1_000_000n)
  })
  it('feeBps exactly 200 composes; 201 answers null (the ceiling is inclusive)', () => {
    expect(swapWithFeeCall({ ...base, feeBps: 200 })).not.toBeNull()
    expect(swapWithFeeCall({ ...base, feeBps: 201 })).toBeNull()
  })
  it('minBuyAmount 0 composes — the floor is the caller’s law and the lint’s watch, never silently rewritten here', () => {
    expect(swapWithFeeCall({ ...base, feeBps: 40, minBuyAmount: 0n })).not.toBeNull()
  })
})
