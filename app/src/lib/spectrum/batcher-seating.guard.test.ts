import { describe, expect, it } from 'vitest'
import deploymentsRaw from '../chain/deployments.json'
import RUNNER_EFFECTS from './runner-effects.ts?raw'

// ─────────────────────────────────────────────────────────────────────────────
// THE BATCHER-SEATING TRIPWIRE — a CONFIG change arms a CODE defect, and no
// other test judges the pair. (The standing pre-condition for ANY batcher
// seating: "a cheap tripwire asserting the executor's ABI matches the seated
// contract.")
//
// THE DEFECT, KNOWN AND DORMANT: runner-effects.ts encodes its batchCall with
// the RETIRED `batcherAbi` (SpectrumBatcher batchBuy, selector 0xc3b25c36).
// The SHIPPING SpectrumPortfolioBatcher's batchBuy is 0x0c8ef5f9 — calldata
// encoded with the retired ABI does not resolve against the deployed contract
// at all. Today the defect cannot fire because both of its preconditions are
// absent: `useExecutionRunner` is mounted in ZERO components, and no chain in
// deployments.json carries a `batcher` address (the runner refuses a null
// batcher at the door; the portfolio engine is SIMULATED=true by code
// constant besides). But seating a batcher is a deployments.json EDIT — not a
// code change — so every unit's own tests stay green while the combination
// goes live. This guard reads the config and the shipped source TOGETHER:
//   · PASSES with no batcher seated (the committed state);
//   · PASSES while a batcher is seated and the runner stays unmounted (the
//     2026-08-12 rehearsal's working-tree state);
//   · FAILS the dangerous combination — a seated batcher WITH a mounted
//     runner while the encoder still pins the retired ABI.
// Mounting the runner for real is an owner decision; meeting this guard
// deliberately (repoint the encoder, then loosen the mount assertion) is part
// of that arming, not an obstacle to it.
// ─────────────────────────────────────────────────────────────────────────────

// The working-tree deployments.json AS THE TESTS RUN — the same file, through
// the same loader, that deploymentFor() reads. Under `vitest run` this is the
// file on disk at test time: seating a `batcher` key arms the assertions
// below without any code changing anywhere. Cast wide on purpose — the guard
// must typecheck in BOTH file states (key present and absent).
const deployments = deploymentsRaw as unknown as Record<string, Record<string, unknown>>
const seatedChains = Object.entries(deployments)
  .filter(([, entry]) => Boolean(entry?.batcher))
  .map(([id]) => id)

// Every SHIPPED source file — tests and fixtures excluded (a test calling the
// hook is coverage, not a mount). The deployer-strings.guard glob idiom: a
// hand-written file list is a memory test, and a merge does not have to pass
// a memory test.
const SHIPPED: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob('../../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
  ).filter(([path]) => !/\.test\.tsx?$/.test(path) && !/__(fixtures|mocks)__/.test(path)),
)

/** A mount is a CALL — or an import, which exists only to call. The hook's
 *  own definition file is the one lawful holder of the name. */
const HOOK_CALL = /\buseExecutionRunner\s*\(/
const HOOK_IMPORT = /from\s+['"][^'"]*use-execution-runner['"]/
function mountsIn(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([path]) => !path.endsWith('/use-execution-runner.ts'))
    .filter(([, src]) => HOOK_CALL.test(src) || HOOK_IMPORT.test(src))
    .map(([path]) => path)
}

/** The door refusal: a chain whose deployment carries no batcher refuses
 *  before anything composes (runner-effects' own "No batch contract is
 *  deployed" gate). */
const REFUSES_NULL_BATCHER =
  /const batcher = ctx\.batcherAddress\(chainId\)[\s\S]{0,120}?if \(!batcher\)[\s\S]{0,120}?throw new RunnerRefusal/
/** The honest future: the batchCall encoder repointed at the shipping
 *  SpectrumPortfolioBatcher ABI (selector 0x0c8ef5f9). */
// EVOLVED 2026-08-16 (the fee-generation build): the runner now encodes
// through encodePortfolioBatchBuy — the ONE generation-discriminated encoder
// in portfolio-batcher.ts, which itself pins both shipping ABIs and their
// selectors (0x0c8ef5f9 gen-1 · 0x2c84261e gen-2). A mount is healthy when it
// speaks THAT encoder; the raw-literal forms stay recognized so a revert to
// the old direct encode does not read as a regression.
const ENCODER_PINS_SHIPPING = /encodePortfolioBatchBuy\(|abi:\s*portfolioBatcherAbi\b|0x0c8ef5f9/

describe('the batcher-seating tripwire — config and code judged together', () => {
  it('has real source to scan — an empty import would make this vacuous', () => {
    expect(Object.keys(SHIPPED).length).toBeGreaterThan(100)
    expect(RUNNER_EFFECTS.length).toBeGreaterThan(1_000)
    expect(Object.keys(SHIPPED).some((p) => p.endsWith('/runner-effects.ts'))).toBe(true)
    expect(Object.keys(deployments).length).toBeGreaterThan(0)
  })

  it('the mount matcher actually bites — a probe call, a probe import, and the definition are all judged right', () => {
    expect(mountsIn({ probe: 'const runner = useExecutionRunner({ composeStep, shownFor, logShape })' })).toEqual(['probe'])
    expect(mountsIn({ probe: "import { useExecutionRunner } from './use-execution-runner'" })).toEqual(['probe'])
    expect(mountsIn({ 'x/use-execution-runner.ts': 'export function useExecutionRunner(args: A) {}' })).toEqual([])
  })

  it('runner-effects keeps the door refusal, or has repointed its encoder at the shipping ABI', () => {
    // Unconditional — not only when seated: losing BOTH halves at once is the
    // state the armed assertion below could no longer tell apart from health.
    expect(
      REFUSES_NULL_BATCHER.test(RUNNER_EFFECTS) || ENCODER_PINS_SHIPPING.test(RUNNER_EFFECTS),
      'runner-effects lost its null-batcher door refusal AND still encodes the retired ABI — re-read this file’s header',
    ).toBe(true)
  })

  it('while ANY chain seats a batcher: a mounted runner requires the SHIPPING encoder', () => {
    if (seatedChains.length === 0) return // nothing armed — the committed state
    // EVOLVED 2026-08-14 (the wiring commit, per this file's own header: "meeting
    // this guard deliberately — repoint the encoder, then loosen the mount
    // assertion — is part of that arming"). The runner is now mounted for real
    // (PortfolioFlow), and the encoder speaks the shipping SpectrumPortfolioBatcher
    // (portfolioBatcherAbi / 0x0c8ef5f9) — so the DANGEROUS combination this
    // tripwire exists for is no longer "any mount", it is a mount while the
    // encoder has regressed to the retired ABI. That is what fails now.
    const mounts = mountsIn(SHIPPED)
    if (mounts.length > 0) {
      expect(
        ENCODER_PINS_SHIPPING.test(RUNNER_EFFECTS),
        `deployments.json seats a batcher on chain(s) ${seatedChains.join(', ')} and ${mounts.length} file(s) mount ` +
          'useExecutionRunner, while runner-effects no longer pins the shipping SpectrumPortfolioBatcher ABI — the ' +
          'mounted runner would sign calldata the deployed contract cannot answer. Repoint the encoder or unmount.',
      ).toBe(true)
    }
    // the door refusal (or the shipping pin) must hold regardless of mounts
    expect(
      REFUSES_NULL_BATCHER.test(RUNNER_EFFECTS) || ENCODER_PINS_SHIPPING.test(RUNNER_EFFECTS),
      'a batcher is seated and runner-effects neither refuses a missing batcher nor encodes the shipping ABI',
    ).toBe(true)
  })
})
