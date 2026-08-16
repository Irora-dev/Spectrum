import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { DEMO_COUNT, demoAddress, demoBasket, demoChain } from './demo-baskets'
import { isDemoLegAddress, THESIS_DEMO_ADDR_RE } from './thesis-run-types'

// ─────────────────────────────────────────────────────────────────────────────
// THE PAIRED REGEX. thesis-run-types.ts carries its own copy of the demo
// address pattern because demo-baskets is dev-only by law — a static import
// would drag twenty fixtures into the production bundle. Two copies of one
// pattern is exactly the drift shape this repo keeps paying for, so this test
// pins them TOGETHER, behaviorally: demo-baskets' regex is private, but what
// it accepts is observable through demoBasket()/demoAddress(). If either side
// changes its pattern, this goes red before a run can arm against a synthetic
// address it no longer recognises as synthetic.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 8453
const ETH = 1
const RH = 4663

describe('THESIS_DEMO_ADDR_RE agrees with demo-baskets on every demo address', () => {
  it('covers the full list, including the thesis triplet', () => {
    // the brief's floor: 20 singles + the 3-chain AICYCLE triplet
    expect(DEMO_COUNT).toBeGreaterThanOrEqual(23)
  })

  it('every demoAddress(0..N-1) matches the thesis pattern AND resolves as a demo basket', () => {
    for (let i = 0; i < DEMO_COUNT; i++) {
      const addr = demoAddress(i)
      expect(THESIS_DEMO_ADDR_RE.test(addr), `demo ${i} (${addr}) must match the thesis pattern`).toBe(true)
      expect(isDemoLegAddress(addr), `demo ${i} via isDemoLegAddress`).toBe(true)
      // demo-baskets' own acceptance, through its public surface
      expect(demoBasket(addr, demoChain(i)!), `demo ${i} must resolve in demo-baskets`).not.toBeNull()
    }
  })

  it('both sides are case-insensitive — an uppercased marker still reads as a demo', () => {
    const upper = demoAddress(0).replace('de50', 'DE50') as Address
    expect(THESIS_DEMO_ADDR_RE.test(upper)).toBe(true)
    expect(demoBasket(upper, demoChain(0)!)).not.toBeNull()
  })
})

describe('and both sides reject real-looking addresses', () => {
  // Real leg addresses demo-baskets itself ships (USDC/WETH/USDG…), one
  // demo-creator address, and the near-miss family: the marker off by one, the
  // marker not at the tail, and a tail one hex digit short.
  const nonDemo: string[] = [
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC (Base)
    '0x4200000000000000000000000000000000000006', // WETH
    '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', // USDG (Robinhood Chain)
    '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
    `0x${'0'.repeat(36)}d0e1`, // a demo CREATOR address — synthetic, but not a basket
    `0x${'0'.repeat(32)}de4f0001`, // marker off by one
    `0x${'0'.repeat(30)}de50000100`, // de50NNNN present but not at the end
    `0x${'0'.repeat(33)}de50001`, // marker + only three trailing hex digits
  ]

  it.each(nonDemo)('%s is a demo for NEITHER side', (addr) => {
    expect(THESIS_DEMO_ADDR_RE.test(addr)).toBe(false)
    expect(isDemoLegAddress(addr)).toBe(false)
    for (const chainId of [BASE, ETH, RH]) expect(demoBasket(addr as Address, chainId)).toBeNull()
  })
})

describe('the one designed asymmetry, stated so nobody "fixes" it', () => {
  it('an out-of-range demo index matches the PATTERN but resolves to no basket', () => {
    // The thesis regex is a pattern gate; demo-baskets adds a range gate on
    // top. Over-matching is the safe direction for the thesis run — the
    // pattern is used to REFUSE arming real money, so a de50 address beyond
    // the list is refused as demo-shaped even though no fixture backs it.
    const beyond = demoAddress(DEMO_COUNT)
    expect(THESIS_DEMO_ADDR_RE.test(beyond)).toBe(true)
    expect(demoBasket(beyond, BASE)).toBeNull()
    expect(demoChain(DEMO_COUNT)).toBeNull()
  })
})
