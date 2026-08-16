import { describe, expect, it } from 'vitest'
import { autoSwitchVerdict, shouldAutoSwitch, type AutoSwitchInput } from './auto-switch'

// The four laws of the owner's 2026-08-13 auto-switch ruling, pinned. The call
// itself needs a real wallet (headless cannot connect one), so the DECISION is
// what carries the guarantees — the hook around it (use-auto-switch.ts) owns
// only the ref and the call.

const BASE = 8453
const ETH = 1

/** Everything lined up to ask: shipping, on the switch step, wallet elsewhere. */
const asking: AutoSwitchInput = {
  shipping: true,
  demo: false,
  laneChainId: BASE,
  laneState: 'switch',
  connected: true,
  walletChainId: ETH,
  signing: false,
  switching: false,
  declined: false,
  asked: [],
}

const on = (over: Partial<AutoSwitchInput>): AutoSwitchInput => ({ ...asking, ...over })

describe('the auto-switch decision', () => {
  it('asks when a lane goes active on a network the wallet is not on', () => {
    expect(autoSwitchVerdict(asking)).toBe('ask')
    expect(shouldAutoSwitch(asking)).toBe(true)
  })

  it('(a) fires ONCE per lane — the second pass over the same chain is a no-op', () => {
    expect(autoSwitchVerdict(on({ asked: [BASE] }))).toBe('already-asked')
    expect(shouldAutoSwitch(on({ asked: [BASE] }))).toBe(false)
  })

  it('(a) the NEXT lane still gets its ask — the memory is per chain, not per ceremony', () => {
    expect(autoSwitchVerdict(on({ asked: [ETH], laneChainId: BASE, walletChainId: ETH }))).toBe('ask')
  })

  it('(a) never re-fires after the wallet rejects — that is the manual button’s job', () => {
    expect(autoSwitchVerdict(on({ declined: true }))).toBe('declined')
    // and it stays refused however the rest of the cursor's inputs churn
    expect(autoSwitchVerdict(on({ declined: true, asked: [] }))).toBe('declined')
  })

  it('(a) no retry loop: a call already in flight is never doubled', () => {
    expect(autoSwitchVerdict(on({ switching: true }))).toBe('already-asking')
  })

  it('(b) never while a signature is out', () => {
    expect(autoSwitchVerdict(on({ signing: true }))).toBe('signature-out')
    // outranks even a lane that has never been asked for
    expect(autoSwitchVerdict(on({ signing: true, asked: [] }))).toBe('signature-out')
  })

  it('(c) the observation is the truth: a wallet already there is asked nothing', () => {
    expect(autoSwitchVerdict(on({ walletChainId: BASE }))).toBe('already-there')
  })

  it('(d) a walkthrough never asks — before anything else is considered', () => {
    expect(autoSwitchVerdict(on({ demo: true }))).toBe('walkthrough')
    expect(shouldAutoSwitch(on({ demo: true }))).toBe(false)
    // even with every other condition screaming yes
    expect(autoSwitchVerdict(on({ demo: true, signing: false, declined: false, asked: [] }))).toBe('walkthrough')
  })

  it('only the switch step asks — a deploy or a signature step never does', () => {
    for (const state of ['queued', 'deploying', 'signing-lineage', 'done', 'failed', 'skipped']) {
      expect(autoSwitchVerdict(on({ laneState: state }))).toBe('not-the-switch-step')
    }
  })

  it('an editor stage never asks, and neither does a finished ceremony', () => {
    expect(autoSwitchVerdict(on({ shipping: false }))).toBe('not-shipping')
    expect(autoSwitchVerdict(on({ laneChainId: null }))).toBe('no-lane')
  })

  it('no wallet, or a wallet whose chain is unknown, is never a reason to ask', () => {
    expect(autoSwitchVerdict(on({ connected: false }))).toBe('no-wallet')
    expect(autoSwitchVerdict(on({ walletChainId: null }))).toBe('no-wallet')
  })
})
