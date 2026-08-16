import { describe, expect, it } from 'vitest'
import { SIMULATED } from './allocation'
import { brand } from '../../brand.config'
import { pageEnabled } from '../../theme/brand'

// ─────────────────────────────────────────────────────────────────────────────
// THE LAUNCH INTERLOCK (owner 2026-08-02: "we need to flag that we should turn
// off the simulated = true before launch").
//
// A note in a doc is not a flag, it is a hope. This is the flag.
//
// TWO SWITCHES, AND NEITHER IS SAFE ALONE:
//
//   SIMULATED  (lib/spectrum/allocation.ts) — the portfolio engine advances on
//              TIMERS, not on chain. It walks approve → confirming → done and
//              reports success having moved nothing.
//   create     (brand.config.ts pages)      — whether an operator build serves
//              the flow to real visitors at all.
//
// The catastrophic combination is `create: true` WHILE `SIMULATED` is true: a
// real user is then told their rebalance executed when nothing happened. This
// test makes that combination impossible to ship silently.
//
// And the ORDER matters, which is the part a reminder would miss. `SIMULATED`
// must not simply be flipped to false either: it is not a debug leftover, it is
// an honest LABEL on machinery that does not exist yet (Phase 3 real execution,
// `batchRebalance`). Flipping it without building that would remove the
// simulation chip from a flow still running on timers, which is the same lie
// wearing the opposite mask.
//
// The safe sequence is: build real execution → set SIMULATED false → then, and
// only then, consider `create: true`.
// ─────────────────────────────────────────────────────────────────────────────

describe('the launch interlock: a simulated engine must never be served', () => {
  it('does not ship the create flow to operators while the engine is SIMULATED', () => {
    if (SIMULATED) {
      expect(
        pageEnabled(brand.pages, 'create'),
        'SIMULATED is true, so `create` MUST ship false: an operator build would ' +
          'otherwise tell real users a rebalance executed when the engine only ran timers. ' +
          'Build Phase 3 real execution and set SIMULATED false BEFORE enabling this page.',
      ).toBe(false)
    }
  })

  // Dev is exempt on purpose and that exemption is the whole reason the flow
  // could converge onto the release line early — but it must stay a DEV
  // exemption, never a build-time default.
  it('keeps the flow visible in dev regardless, with zero source divergence', async () => {
    const { CREATE_FLOW } = await import('../../App')
    // Under vitest `import.meta.env.DEV` is true, so this proves the dev path is
    // what keeps :5309/:5311/:5313 serving the flow while operators do not.
    expect(CREATE_FLOW).toBe(true)
    // 30s, not the 5s default: this import transforms the ENTIRE App graph in
    // one worker — under a sibling mutation run (load avg ~25) the default
    // timed out in full-suite runs while the test passed alone. The budget is
    // for the transform, not the assertion.
  }, 30_000)

  it('states the interlock in the config, so the reason survives the next reader', () => {
    // ⚠ FLIPPED 2026-08-14 — the deliberate revisit this pin demanded, done:
    // real execution is BUILT (the portfolio engine + run wiring), the go-live
    // interlock's preconditions are all met (SpectrumContracts' clean row at
    // the flipped-tree digest, one-pass bar per the owner's ruling), and the flip
    // landed with the row in one reviewed commit. The create-gate question was
    // revisited deliberately: `create` stays OFF for operators (the first
    // condition above still pins that while any simulation remains anywhere);
    // this pin now holds the flip DOWN — un-flipping SIMULATED back to true
    // would resurrect the timer engine under live-looking chrome, so the
    // reverse transition must be just as deliberate as this one was.
    expect(SIMULATED, 'the engine went LIVE 2026-08-14 with the reviewed flip commit — flipping it back to simulated is a sacred change, not a revert').toBe(false)
  })
})
