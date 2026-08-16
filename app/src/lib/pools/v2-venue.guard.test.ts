import { describe, expect, it } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// NOTHING MINTS A VENUE-2 ROUTE OUTSIDE THE TWO PLACES ALLOWED TO.
//
// The V2 law is only as strong as the number of places that can produce a leg.
// Detection refuses one (find-best-pool), the last line before money refuses
// another (deploy.ts → toBasketEntries), and the CTA refuses a third
// (BasketBuilder) — but all three are bypassed the moment a NEW surface writes
// `venue: Venue.V2` into a route of its own. That is not hypothetical: the
// route struct is six lines of object literal, and the codebase already builds
// one by hand in a fallback path.
//
// A HAND-WRITTEN LIST OF FILES IS A MEMORY TEST, AND A MERGE DOES NOT HAVE TO
// PASS IT (the exact reasoning of deployer-strings.guard.test.ts, which learned
// it the hard way when an absorption dropped a guard on a file that was not on
// the list). So this scans EVERY shipped source file by glob: a surface added
// next month is covered by construction, not by someone remembering this file.
//
// ITS STATED LIMIT: it reasons about source text. A venue computed into a
// variable first (`const v = 2; route: { venue: v }`) would slip past. It pins
// the canonical spellings, which is what every real construction site uses —
// and the runtime guards above are what actually stop the money either way.
// ─────────────────────────────────────────────────────────────────────────────

// Vite keys a glob RELATIVE TO THE IMPORTING FILE, so from here they arrive as
// './types.ts', '../chain/rpc.ts', '../../pages/Token.tsx'. Resolved against
// this file's own directory so every assertion below can name a file the way a
// human would (`lib/spectrum/deploy.ts`) instead of by its distance from here.
const BASE = 'lib/pools'
function srcPath(rel: string): string {
  const out = BASE.split('/')
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

const FILES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob('../../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
  )
    .filter(([path]) => !/\.test\.tsx?$/.test(path) && !/__(fixtures|mocks)__/.test(path))
    .map(([path, src]) => [srcPath(path), src]),
)

/** Writing a venue-2 route: `venue: Venue.V2` or `venue: 2` in an object. */
const MINTS_V2 = /venue:\s*(?:Venue\.V2\b|2\b)/

/** The files allowed to name venue 2 when BUILDING a route, and why.
 *
 *  Deliberately tiny. Anything else that starts constructing V2 routes has to
 *  come here and say why in one line — which is the whole point of the gate. */
const ALLOWED: Record<string, string> = {
  'lib/pools/find-best-pool.ts':
    'the detector itself — it MINTS the route, and it is where the rejection is enforced first (a rejecting chain never reaches toRoute with a V2 candidate)',
  'lib/spectrum/version-seed.ts':
    'the no-pool-infra fallback: a placeholder route on a build with no pool engine, labelled "unverified" and carrying a ZERO pair — it is a shape, not a routing decision (and unreachable wherever a poolManager is configured, which is every seated chain)',
}

describe('venue 2 is minted in two places, and both are accounted for', () => {
  it('no other shipped source file constructs a V2 route', () => {
    const offenders = Object.entries(FILES)
      .filter(([path]) => !(path in ALLOWED))
      .filter(([, src]) => MINTS_V2.test(src))
      .map(([path]) => path)
    expect(
      offenders,
      'a new surface builds a venue-2 route without going through v2-legs.ts — add the guard there, or justify it in ALLOWED',
    ).toEqual([])
  })

  it('the allow-list is not stale — every entry still mints one', () => {
    // An allowance that no longer applies is a hole waiting to be reused.
    for (const [path, why] of Object.entries(ALLOWED)) {
      expect(FILES[path], `${path} is on the allow-list but is not a shipped source file`).toBeTruthy()
      expect(MINTS_V2.test(FILES[path]), `${path} no longer mints a V2 route — drop it from ALLOWED (${why})`).toBe(
        true,
      )
    }
  })
})

describe('the refusal sentence has exactly one author', () => {
  it('no file writes the clause by hand — every surface imports it', () => {
    // The failure this stops is a surface rendering its own, softer wording
    // ("this pool may not work"), which is how a refusal quietly becomes a
    // warning. The clause exists in v2-legs.ts and nowhere else.
    const CLAUSE = /contracts reject Uniswap V2 legs/
    const authors = Object.entries(FILES)
      .filter(([, src]) => CLAUSE.test(src))
      .map(([path]) => path)
    expect(authors).toEqual(['lib/pools/v2-legs.ts'])
  })

  it('every V2-refusal surface reaches the law through the shared module', () => {
    // The enforcement points, asserted to actually import the law rather than
    // re-deriving `rejectsV2Legs` on their own.
    const wired = ['lib/pools/find-best-pool.ts', 'lib/spectrum/deploy.ts', 'components/launch/BasketBuilder.tsx']
    for (const path of wired) {
      expect(FILES[path], `${path} is missing`).toBeTruthy()
      expect(FILES[path], `${path} must reach the V2 law through v2-legs.ts`).toMatch(
        /from '(\.\.\/)+(lib\/)?pools(\/v2-legs)?'|from '\.\/v2-legs'/,
      )
    }
  })

  it('nobody reads the raw flag except the law module', () => {
    // `rejectsV2Legs` is a config field; `chainRejectsV2()` is the question.
    // One reader means one place to change when the rule moves.
    // A property READ (`cfg.rejectsV2Legs`), not a mention of the name in prose —
    // the field is documented in several comments, and documenting it is fine.
    const readers = Object.entries(FILES)
      .filter(([, src]) => /\.rejectsV2Legs\b/.test(src))
      .map(([path]) => path)
      .sort()
    expect(readers).toEqual(['lib/chain/deployments.ts', 'lib/pools/v2-legs.ts'])
  })
})
