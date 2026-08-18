import { describe, expect, it } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// THE SEAM-SUPPLY GUARD — no optional money-context member ships unwired.
//
// The bug class this kills recurred twice in ONE week, live (docs/
// BUG-CLASSES.md class 1): an optional member on the runner's context that
// production never supplied. Every unit test stayed green — units are handed
// the seam by hand — while in production the gas-refuel pricing member was
// never wired (every refuel bridge refused) and the burn-route bytes went up
// empty (an entire batch fee diverted). The composition root was the one
// place nobody checked.
//
// So this guard checks exactly that place, from source: it parses the OPTIONAL
// members off RunnerEffectsContext, then demands each one is either
//   · SUPPLIED at the hook root (use-execution-runner.ts's createRunnerEffects
//     call) with a real value, or
//   · FORWARDED there (`name: args.name`) — in which case the app root
//     (PortfolioFlow.tsx, the production mount) must supply it, or
//   · ALLOWLISTED below with a reason that survives reading the call sites
//     (a test seam whose absent default IS the real function, or plumbing
//     with a safe default).
// A NEW optional member matches none of these and fails until its author
// classifies it — which is the entire point: optional-on-a-money-path is a
// decision someone must be seen making, never a default someone forgot.
// ─────────────────────────────────────────────────────────────────────────────

import runnerEffectsSrc from './runner-effects.ts?raw'
import hookSrc from './use-execution-runner.ts?raw'
import flowSrc from '../../components/allocate/PortfolioFlow.tsx?raw'

/** Optional members whose ABSENCE is a verified design, not a gap. Each reason
 *  was checked by reading the default at the consuming site. */
const ALLOWLIST: Record<string, string> = {
  lifiQuote: 'test seam — absent binds the REAL fetchLifiQuote (runner-effects defaults it); production wants the default',
  lifiStatus: 'test seam — absent binds the REAL fetchLifiStatus; production wants the default',
  zeroExQuote: 'test seam — absent binds the real proxy fetcher the token page already trades through',
  nowMs: 'plumbing — absent binds Date.now; a test injects a clock, production wants the real one',
  sleep: 'plumbing — absent binds real setTimeout waiting',
  store: 'plumbing — absent binds window.localStorage inside submission-store; the hook leaves it default in the browser',
}

function optionalMembersOf(src: string): string[] {
  const start = src.indexOf('export interface RunnerEffectsContext')
  expect(start, 'RunnerEffectsContext must exist in runner-effects.ts — the guard lost its subject').toBeGreaterThan(-1)
  // the interface ends at the first line that is exactly '}' at column 0
  const end = src.indexOf('\n}', start)
  const body = src.slice(start, end)
  const names: string[] = []
  for (const m of body.matchAll(/^  (\w+)\?:/gm)) names.push(m[1])
  return names
}

/** `name:` appearing as a property key in the createRunnerEffects argument —
 *  supply or forward. Cheap and honest about being a source scan: an aliased
 *  supply would need its own allowlist entry, which is the visible choice. */
const suppliesAt = (src: string, name: string) => new RegExp(`\\b${name}\\s*:`).test(src)
const forwardsAt = (src: string, name: string) => new RegExp(`\\b${name}\\s*:\\s*args\\.${name}\\b`).test(src)

describe('every optional runner-context seam is supplied, forwarded-and-supplied, or a seen decision', () => {
  const optionals = optionalMembersOf(runnerEffectsSrc)

  it('found the optional members at all — an empty list means the parse rotted, not that the type went strict', () => {
    expect(optionals.length).toBeGreaterThan(8)
    expect(optionals).toContain('nativeUsd')
    expect(optionals).toContain('directLane')
  })

  it.each(optionalMembersOf(runnerEffectsSrc))('%s', (name) => {
    if (ALLOWLIST[name]) return // a seen decision, reason above
    expect(
      suppliesAt(hookSrc, name),
      `RunnerEffectsContext.${name} is optional and the hook root never supplies it — ` +
        `this is the unsupplied-seam class (two live incidents 2026-08-18: every refuel refused; a whole batch fee diverted). ` +
        `Supply it in use-execution-runner.ts, or allowlist it here with a reason that survives reading the defaults.`,
    ).toBe(true)
    if (forwardsAt(hookSrc, name)) {
      expect(
        suppliesAt(flowSrc, name),
        `RunnerEffectsContext.${name} is FORWARDED by the hook (name: args.${name}) and the app root ` +
          `(PortfolioFlow) never supplies it — a forward with no upstream supply is exactly how the refuel seam shipped undefined. ` +
          `Pass it at the useExecutionRunner call, or allowlist with a reason.`,
      ).toBe(true)
    }
  })
})
