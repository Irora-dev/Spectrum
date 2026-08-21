import { describe, expect, it } from 'vitest'
import { isShortfall } from './CrossChainLaunchFlow'

// ─────────────────────────────────────────────────────────────────────────────
// THE BRIDGE DOOR'S ONE CONDITION.
//
// use-deploy phrases a short first deposit in the HOUSE SHORTFALL GRAMMAR
// ("Needs $X more…") on purpose: its own comment says a shortfall worded that
// way is recognisable to the surfaces that can OFFER a way through instead of
// dead-ending (the owner 2026-08-15: "we should accommodate… rather than throw
// an error"). The one-button launch flow is such a surface — it opens BridgeFund
// for that chain when it sees this shape.
//
// Which makes the match load-bearing in the quiet direction: if the grammar or
// the regex drifts, nothing throws and no test elsewhere goes red. The bridge
// door simply stops appearing, and a creator whose wallet is $3 short on one
// chain is back to a dead end. These pins are the alarm for that.
//
// The strings below are the REAL ones, copied from their sources:
//   use-deploy.ts     — the seed shortfall
//   thesis-funding.ts — the same grammar for a per-chain leg
// ─────────────────────────────────────────────────────────────────────────────

describe('isShortfall — the bridge door opens on the house grammar', () => {
  it('recognises the deploy seed shortfall verbatim', () => {
    expect(
      isShortfall(
        'Needs $3.00 more to make this deposit. It costs $25.00 and this wallet holds $22.00. Add it, or start the deposit again at the smaller amount.',
      ),
    ).toBe(true)
  })

  it('recognises the thesis funding variant (the same grammar, a chain name after)', () => {
    expect(isShortfall('Needs $12.50 more on Base. Your other networks do hold enough, but it is already committed')).toBe(true)
  })

  it('handles thousands separators and whole dollars', () => {
    expect(isShortfall('Needs $1,250 more to make this deposit.')).toBe(true)
    expect(isShortfall('Needs $1,250.75 more to make this deposit.')).toBe(true)
  })

  it('stays shut on every other failure — those have no way through', () => {
    // the deploy fee is NATIVE coin: BridgeFund lands settlement dollars, so it
    // is not the answer here and must not be offered as if it were
    expect(
      isShortfall(
        'Not enough ETH to deploy: this wallet holds 0.0210 ETH, the deploy needs 0.1000 ETH for the launch fee plus roughly 0.0100 for gas. Top up and try again.',
      ),
    ).toBe(false)
    expect(isShortfall('a leg did not resolve')).toBe(false)
    expect(isShortfall('User rejected the request.')).toBe(false)
    expect(isShortfall('swapExactIn reverted with 0x356680b7')).toBe(false)
    expect(isShortfall(null)).toBe(false)
    expect(isShortfall(undefined)).toBe(false)
    expect(isShortfall('')).toBe(false)
  })

  it('anchors at the start, so a sentence merely mentioning a shortfall does not qualify', () => {
    expect(isShortfall('The deposit failed. Needs $3.00 more to make this deposit.')).toBe(false)
  })
})
