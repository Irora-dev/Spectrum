import { describe, expect, it } from 'vitest'
import { DEV_PREVIEW_ADDRESS } from './dev-preview'
import { realExecutionArming, walkthroughAllowed, type ArmingSeams } from './execution-arming'
import type { AllocationDraft } from './allocation'

// ─────────────────────────────────────────────────────────────────────────────
// THE ARMING GATE'S MATRIX. Two properties matter beyond the row-by-row
// refusals: (1) the TODAY answer is deterministic on every checkout — the
// global flags are judged before per-chain seating, so a working tree with a
// rehearsal batcher seated in deployments.json answers the same sentence as a
// clean one; (2) the desk-204 provenance refusal (a demo-seeded draft under a
// REAL signer) outranks everything except the signer's own identity — it is
// the exact laundering seam the field exists for.
// ─────────────────────────────────────────────────────────────────────────────

const REAL = '0x29eE56bA30c02667972756b829e2B10DF1733AE2'
const DEMO_LEG = '0x00000000000000000000000000000000de500001'

const asset = (chainId: number, sym: string, address = `0x${'a'.repeat(39)}${chainId % 10}`) => ({
  chainId,
  address,
  symbol: sym,
})

const draft = (over: Partial<Pick<AllocationDraft, 'targets' | 'seedBookOwner'>> = {}) => ({
  targets: [
    { asset: asset(8453, 'AAVE'), weight: 50 },
    { asset: asset(1, 'UNI'), weight: 50 },
  ],
  ...over,
})

/** Flip-day seams: both flags open, every chain seated. */
const OPEN: ArmingSeams = {
  composeEnabled: true,
  simulated: false,
  batcherFor: () => REAL as `0x${string}`,
}

describe('walkthroughAllowed — the simulated walk is the demo identity’s only', () => {
  it('demo yes, real no, guest/absent no', () => {
    expect(walkthroughAllowed(DEV_PREVIEW_ADDRESS)).toBe(true)
    expect(walkthroughAllowed(DEV_PREVIEW_ADDRESS.toUpperCase().replace('0X', '0x'))).toBe(true)
    expect(walkthroughAllowed(REAL)).toBe(false)
    expect(walkthroughAllowed('guest')).toBe(false)
    expect(walkthroughAllowed(null)).toBe(false)
    expect(walkthroughAllowed(undefined)).toBe(false)
  })
})

describe('realExecutionArming — identity and provenance refuse first', () => {
  it('no wallet refuses with connect words', () => {
    const v = realExecutionArming(draft(), null)
    expect(v.armed).toBe(false)
    if (!v.armed) expect(v.reason).toMatch(/connect a wallet/i)
  })

  it('a non-address scope (guest) refuses the same way', () => {
    const v = realExecutionArming(draft(), 'guest')
    expect(v.armed).toBe(false)
    if (!v.armed) expect(v.reason).toMatch(/connect a wallet/i)
  })

  it('the demo identity itself refuses as a simulation — even with every seam open', () => {
    const v = realExecutionArming(draft(), DEV_PREVIEW_ADDRESS, OPEN)
    expect(v.armed).toBe(false)
    if (!v.armed) expect(v.reason).toMatch(/demo book/i)
  })

  it('desk-204: a draft SEEDED from the demo book refuses under a REAL signer — the laundering seam', () => {
    const v = realExecutionArming(draft({ seedBookOwner: DEV_PREVIEW_ADDRESS }), REAL, OPEN)
    expect(v.armed).toBe(false)
    if (!v.armed) expect(v.reason).toMatch(/demo book/i)
  })

  it('and that provenance refusal outranks the global flags — the reason names the demo, not the dark path', () => {
    const v = realExecutionArming(draft({ seedBookOwner: DEV_PREVIEW_ADDRESS }), REAL, { composeEnabled: false })
    expect(v.armed).toBe(false)
    if (!v.armed) expect(v.reason).toMatch(/demo book/i)
  })

  it('a draft seeded from a REAL book does not trip the provenance guard', () => {
    const v = realExecutionArming(draft({ seedBookOwner: REAL.toLowerCase() }), REAL, OPEN)
    expect(v.armed).toBe(true)
  })

  it('demo/synthetic assets refuse by symbol — they exist on no chain', () => {
    const v = realExecutionArming(
      draft({ targets: [{ asset: asset(8453, 'DEMO', DEMO_LEG), weight: 100 }] }),
      REAL,
      OPEN,
    )
    expect(v.armed).toBe(false)
    if (!v.armed) {
      expect(v.reason).toMatch(/demo assets/i)
      expect((v.detail ?? []).join(' ')).toMatch(/\$DEMO/)
    }
  })

  it('an empty plan refuses — nothing to execute', () => {
    const v = realExecutionArming(draft({ targets: [] }), REAL, OPEN)
    expect(v.armed).toBe(false)
    if (!v.armed) expect(v.reason).toMatch(/empty plan/i)
  })
})

describe('the global flags — judged BEFORE per-chain seating, so today’s answer is one sentence on every checkout', () => {
  it('TODAY (real constants, LIVE since the 2026-08-14 flip): the flags no longer block — the verdict falls to seating', () => {
    // no seams: the real ZEROEX_COMPOSE_ENABLED / SIMULATED constants decide.
    // Pre-flip this pinned the not-switched-on sentence; post-flip both flags
    // pass, so on a COMMITTED checkout (no batcher seated) the honest verdict
    // is the seating refusal — and on a rehearsal-seated working tree it arms.
    // Either way the FLAG gate stands down, which is exactly the flip's claim.
    const v = realExecutionArming(draft(), REAL)
    if (!v.armed) expect(v.reason).not.toMatch(/not switched on|pinned simulated/i)
  })

  it('compose open but the engine still simulated → the simulated sentence', () => {
    const v = realExecutionArming(draft(), REAL, { composeEnabled: true, simulated: true, batcherFor: () => null })
    expect(v.armed).toBe(false)
    if (!v.armed) expect(v.reason).toMatch(/simulated/i)
  })

  it('flags open, a chain unseated → the seating refusal names the chain', () => {
    const v = realExecutionArming(draft(), REAL, {
      composeEnabled: true,
      simulated: false,
      batcherFor: (cid) => (cid === 8453 ? (REAL as `0x${string}`) : null),
    })
    expect(v.armed).toBe(false)
    if (!v.armed) {
      expect(v.reason).toMatch(/no batch contract/i)
      expect((v.detail ?? []).join(' ')).toMatch(/chain 1 /)
      expect((v.detail ?? []).join(' ')).not.toMatch(/chain 8453/)
    }
  })

  it('flip-day: everything open and seated → armed, carrying the plan’s chains', () => {
    const v = realExecutionArming(draft(), REAL, OPEN)
    expect(v).toEqual({ armed: true, chains: [8453, 1] })
  })
})
