import { describe, expect, it } from 'vitest'
import HOOK from './use-dex-swap.ts?raw'
import CARD from '../../components/DexSwapCard.tsx?raw'

// ─────────────────────────────────────────────────────────────────────────────
// A SOURCE GUARD, because the unit tests for shownFloorMismatch would keep
// passing perfectly if nobody ever CALLED it. That is the vacuous-gate failure
// this repo has hit before: the logic is right, the coverage looks real, and the
// wiring is gone. These assertions read the actual source, so deleting a call
// site or quietly reverting the capture to a click-time read fails here rather
// than in production.
//
// `?raw` rather than node:fs — this file is under the BROWSER tsconfig, which
// has no node types (same reason learn-search.test.ts does it).
// ─────────────────────────────────────────────────────────────────────────────

describe('the displayed-vs-signed gate is actually wired', () => {
  it('execute takes the painted floor as an argument', () => {
    expect(HOOK).toMatch(/shown\?:\s*ShownFloor\s*\|\s*null/)
  })

  it('THREE gates — buy-early, buy-SIGNED and sell', () => {
    const calls = HOOK.match(/shownFloorMismatch\(/g) ?? []
    expect(calls.length, 'buy needs TWO (the early one and the signed one) plus sell').toBe(3)
  })

  it('⚠ THE BUY GATE CHECKS THE NUMBER THAT IS SIGNED, not the one that was quoted', () => {
    // THE REGRESSION THIS EXISTS FOR (adversarial review, 2026-08-08): the first
    // version gated `bq.minOutRaw`, but `minShares` is rebuilt from a fresh
    // probe afterwards and THAT is what reaches the contract. On the normal
    // path the signed floor was a number nothing had ever compared to the
    // screen — the module's own headline defect, reproduced inside its fix.
    expect(HOOK).toMatch(/const signedGate = [\s\S]{0,140}?shownFloorMismatch\(shown, usdcIn, minShares[,)]/)
    expect(HOOK).toMatch(/const signedGate[\s\S]{0,200}?if \(signedGate\) throw/)
    // and it must sit BEFORE the args that carry minShares to the wallet
    const gate = HOOK.indexOf('const signedGate')
    const signs = HOOK.indexOf('minOut: minShares')
    expect(gate).toBeGreaterThan(-1)
    expect(signs).toBeGreaterThan(-1)
    expect(gate, 'the signed-number gate must run before the number is encoded').toBeLessThan(signs)
  })

  it('each gate REFUSES rather than merely computing a value it ignores', () => {
    expect(HOOK).toMatch(/const buyGate = [\s\S]{0,160}?if \(buyGate\) throw/)
    expect(HOOK).toMatch(/const sellGate = [\s\S]{0,160}?if \(sellGate\) throw/)
  })

  it('every gate binds only on the DIRECT route — the units are comparable there and nowhere else', () => {
    // the sell version of this refused EVERY non-USDC sell: the card paints the
    // receive token's floor (18dp ETH) and the leg signs USDC at 6dp, so the
    // comparison was a units error that could never agree
    for (const name of ['buyGate', 'sellGate', 'signedGate']) {
      expect(HOOK, `${name} must gate on the direct route only`).toMatch(
        new RegExp(`const ${name} = hub === 'USDC' \\? shownFloorMismatch\\(`),
      )
    }
  })

  it('every gate names the TRADE it is about — a claim from another basket must not arm it', () => {
    // the card does not remount on a basket switch, so without this a claim
    // painted for one basket stays armed for the next
    expect(HOOK).toMatch(/shownFloorMismatch\(shown, usdcIn, bq\.minOutRaw, about\)/)
    expect(HOOK).toMatch(/shownFloorMismatch\(shown, usdcIn, minShares, about\)/)
    expect(HOOK).toMatch(/shownFloorMismatch\(shown, amountInRaw, bq\.minOutRaw, sellAbout\)/)
  })

  it('the buy gate runs BEFORE the approval, not after money has moved', () => {
    const gate = HOOK.indexOf('const buyGate')
    const approve = HOOK.indexOf("approveIfNeeded('approve-usdc'")
    expect(gate).toBeGreaterThan(-1)
    expect(approve).toBeGreaterThan(-1)
    expect(gate, 'a gate after the approval has already cost the user gas').toBeLessThan(approve)
  })

  it('the card passes the CAPTURED ref, never a freshly-read value', () => {
    // the exact f(x) === f(x) regression: passing dex.quote.minOutRaw here would
    // compare a click-time read against a click-time recomputation and never fire
    expect(CARD).toMatch(/dex\.execute\(amountRaw, slippageBps, feeFrac, shownFloorRef\.current\)/)
    expect(CARD).not.toMatch(/dex\.execute\([^)]*dex\.quote/)
  })

  it('the capture happens in an effect, so it holds what was painted', () => {
    expect(CARD).toMatch(/useEffect\(\(\) => \{[\s\S]{0,400}?shownFloorRef\.current =/)
  })

  it('the claim is STICKY PER QUOTE, so closing the fold cannot discard it', () => {
    // the regression specallocator's cold pass found: keying the clear on
    // `detailsOpen` alone meant read-the-minimum → close-the-fold → swap
    // silently disabled a money gate via a UI action. Only a NEWER quote retires
    // a claim now, which is what `paintedForRef` exists to detect.
    expect(CARD).toMatch(/paintedForRef/)
    expect(CARD).toMatch(/else if \(q !== paintedForRef\.current\)/)
    // and the effect still watches both, so a new quote while the fold is shut
    // is still seen
    expect(CARD).toMatch(/\}, \[dex\.quote, detailsOpen\]\)/)
  })

  it('a never-opened fold still makes NO claim — the opposite over-correction', () => {
    // keying on [dex.quote] alone would carry a claim about a number nobody saw;
    // the capture must still require detailsOpen to SET one
    expect(CARD).toMatch(/if \(detailsOpen && q\) \{[\s\S]{0,200}?shownFloorRef\.current = \{/)
  })
})
