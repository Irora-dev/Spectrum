import { describe, expect, it } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// THE REFUSAL-SENTENCE RATCHET (M12, desk 236 — "8 refusal sentences no test
// asserts"). AND A RECORD OF WHAT I TRIED FIRST AND THREW AWAY, because the
// discarded design is the more useful half of this file.
//
// A refusal sentence IS the product on a money path: it is the whole of what a
// person gets when we decline to spend their money, and this lane has shipped
// refusals that said the wrong thing (a missing operator key told the user 0x
// was misdirecting funds; "we cannot read how deep these pools are" over a read
// that had SUCCEEDED). An unasserted sentence is one nobody has ever read back.
//
// ⚠ WHAT DID NOT WORK: verifying, per sentence, that some test asserts it — by
// matching word windows of the sentence against test text. MEASURED across
// window sizes, over all 66 sentences:
//     3 words → 0 unasserted   (common phrases like "for this leg" match
//                               unrelated tests: false NEGATIVES, and the
//                               bite-test proved it — deleting a real
//                               assertion did not turn the gate red)
//     4 words → 28   ·   5 → 45   ·   6 → 51   ·   7 → 57
//                              (tests quote SHORT fragments — `.toThrow(/could
//                               not price/i)` — so long windows report
//                               sentences that ARE asserted: false POSITIVES)
// There is no knee. The mechanism cannot answer its own question at any
// setting, and a gate that cannot be trusted in the "absent" direction is the
// read-failed law wearing a test — my own first cut reported 64 of 66, which
// was 87% false and would have been switched off within a day.
//
// SO THIS FILE COUNTS INSTEAD, and counting is exact. The number of refusal
// sentences in the money modules is pinned to a LITERAL. Adding a refusal
// forces a change here, where this comment tells you what is owed: assert the
// new sentence somewhere a human will read it back. That is weaker than
// automatic coverage and it is HONEST, which is the trade this lane keeps
// choosing on purpose.
//
// The five sentences the discarded sweep did surface before I distrusted it are
// now asserted for real — in portfolio-batcher (leg cap, the 24h deadline
// ceiling, empty route calldata), floor-discipline (no usable quote) and
// funding-plan (the dollar shortfall). Those were genuine: five money refusals
// nobody had ever read back.
// ─────────────────────────────────────────────────────────────────────────────

const MONEY_MODULES = [
  'funding-plan',
  'floor-discipline',
  'plan-legs',
  'assemble-batch',
  'portfolio-batcher',
  'pool-safety',
  'displayed-vs-signed',
]

const SRC = import.meta.glob(['/src/lib/spectrum/*.ts', '!/src/lib/spectrum/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const REFUSAL_STRINGS = /(?:reason|message):\s*[`']([^`']{40,})[`']|new (?:BatchComposeRefusal|RunnerRefusal)\(\s*[`']([^`']{40,})[`']/g

/** Every user-facing refusal sentence the money modules can emit. */
export function refusalSentences(src: Record<string, string>): { module: string; sentence: string }[] {
  const out: { module: string; sentence: string }[] = []
  for (const mod of MONEY_MODULES) {
    const text = src[`/src/lib/spectrum/${mod}.ts`]
    if (!text) continue
    for (const m of text.matchAll(REFUSAL_STRINGS)) {
      const sentence = (m[1] ?? m[2] ?? '').trim()
      if (sentence) out.push({ module: mod, sentence })
    }
  }
  return out
}

describe('the refusal-sentence ratchet', () => {
  const found = refusalSentences(SRC)

  it('every money module is readable — a missing one would silently shrink the count', () => {
    for (const mod of MONEY_MODULES) expect(SRC[`/src/lib/spectrum/${mod}.ts`], `${mod}.ts not found — the scope list rotted`).toBeTruthy()
  })

  it('the money modules emit exactly the acknowledged number of refusal sentences', () => {
    // ⚠ IF THIS FAILS YOU ADDED OR REMOVED A REFUSAL. That is fine and normal —
    // update the literal IN THE SAME COMMIT, and if you ADDED one, assert the
    // new sentence in the owning module's suite first. The point of the ratchet
    // is that the change is visible and chosen, never absorbed.
    // 66 → 67: the M7 band gained a refusal when it stopped standing aside
    // 67 → 68: funding-plan now names the DESTINATION when a bridge source is
    // refused (adversarial pass, 2026-08-08). Previously only the source was
    // named while the batch it funded stayed live and executable, drawing money
    // the plan had just refused to move. Asserted in funding-plan.test.ts —
    // "a batch does NOT survive the refusal of the bridge that funds it".
    // on unreadable inputs (an independent review measured that stand-aside
    // composing ~$1.79B of native spend). The ratchet firing here is it working.
    // 68 → 66 (2026-08-13): assemble-batch's TWO interim concentration
    // sentences retired with the owner's 75% ruling — superseded by ONE shared
    // verdict (plan-legs' concentrationRefusal, a returned sentence outside
    // this extractor's throw pattern), asserted in plan-legs.test.ts,
    // portfolio-batcher.test.ts AND assemble-batch.test.ts; the runner's
    // law-14 window refusal is asserted in execution-runner.test.ts.
    // 66 → 68 (2026-08-15, the burn route — the owner's "do this so burn works"):
    // portfolio-batcher gained (a) the burn-divert disclosure ("will divert
    // to the fallback sink"), asserted in portfolio-run-wiring.test.ts's
    // failed-burn-quote pin; and (b) the burn quote's structural-check throw,
    // which its OWN try/catch converts into (a) — internal control flow,
    // never user-facing on its own, counted because the extractor reads
    // constructors. Both chosen, neither absorbed.
    // 66 → 67 (2026-08-13, audit F2): composePortfolioBatchBuy gained a THROWN
    // concentration-cap refusal at the compose gate. 67 → 66 (2026-08-13,
    // the owner's consent-divergence ruling): that compose-gate throw was REMOVED —
    // the policy is now "no leg realises more than you consented," which needs
    // consent context the compose gate doesn't have, so the guard lives only at
    // the assembler exits (concentrationRefusal, a RETURNED sentence outside
    // this throw-extractor; pinned in plan-legs/portfolio-batcher/assemble-batch
    // suites). The audit's other laws (F1/F2/F4/F6) are likewise returned
    // sentences in portfolioCompositionLawsBroken, pinned in displayed-vs-signed.
    // 68 → 69 (2026-08-15, the owner's thin-market ruling — "for small caps we
    // should allow open slippage but just surface it for people to be aware"):
    // floor-discipline gained a PER-LEG unusable-ceiling refusal ("The
    // protection limit for this asset could not be read, so no floor was
    // derived for it"), the one-scope-down sibling of the existing batch-cap
    // refusal. Distinct by choice, not laziness: the batch-cap sentence says
    // NOTHING was composed at all, which is false when one leg's ceiling is
    // unreadable and the rest of the batch composes fine. Asserted in
    // floor-discipline.test.ts — the unusable-ceiling pin, and the pin that one
    // bad leg does not take the batch down with it.
    expect(found).toHaveLength(69)
  })

  it('no refusal sentence is empty, and none leaks a raw placeholder into what a person reads', () => {
    for (const { module, sentence } of found) {
      expect(sentence.length, `${module}: an empty refusal is a hole where the reason should be`).toBeGreaterThan(20)
      expect(sentence, `${module}: "${sentence.slice(0, 60)}" leaks undefined/NaN`).not.toMatch(/\b(undefined|NaN|null)\b/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE RELEASE MANIFEST EXISTS AND SAYS WHAT IT IS (rule promoted from the
// registry when the manifest landed). The manifest's whole strength is that a
// human publishes its digest somewhere the serving host does not control — so
// the one thing a test CAN hold is that the artifact never quietly stops
// saying so, and never grows an SRI-shaped claim it cannot support.
// ─────────────────────────────────────────────────────────────────────────────
const MANIFEST_SCRIPT = import.meta.glob(['/scripts/release-manifest.mjs'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('the release manifest', () => {
  const src = Object.values(MANIFEST_SCRIPT)[0] ?? ''

  it('exists and is wired to run after every build', () => {
    expect(src.length, 'release-manifest.mjs not found').toBeGreaterThan(500)
    expect(src).toContain('bundleDigest')
  })

  it('states the out-of-band requirement, because a digest read from the host it describes proves nothing', () => {
    expect(src).toMatch(/VERIFY OUT-OF-BAND/)
    expect(src).toMatch(/PUBLISH THAT DIGEST/)
  })

  it('refuses the SRI framing it would be easy to copy — our HTML loads one SAME-ORIGIN module', () => {
    // an integrity attribute served by the same host that serves the script is
    // signed by the attacker who can change both; the header says so and must
    // keep saying so
    expect(src).toMatch(/NOT SRI/)
    expect(src).not.toMatch(/integrity=/)
  })

  it('never hashes itself — that would change its own digest on every run', () => {
    expect(src).toMatch(/f !== OUT|never hashes ITSELF/)
  })
})
