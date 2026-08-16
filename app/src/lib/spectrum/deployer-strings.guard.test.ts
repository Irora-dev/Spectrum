import { describe, expect, it } from 'vitest'
// ?raw, not node:fs — a browser project's tsconfig carries no node types, and
// Vite's raw import is how the repo's other source-scanning tests read files
// (see redirects-coverage.test.ts).


// ─────────────────────────────────────────────────────────────────────────────
// NO DEPLOYER STRING REACHES A RENDER SITE RAW.
//
// A basket's name and ticker are whatever its deployer typed at the factory,
// and an attacker can deploy a basket — so those strings are hostile input.
// `safe-copy.ts` (showSymbol / showName) is where they become text we will
// SHOW: it strips bidi overrides and zero-width characters and clips length.
// The whole bug class is a render site that interpolates the raw field and
// skips that helper — and the 2026-08-07 audit found five of them (the embed
// snippet, the wallet prompt, the /embed card, the creator label, the token
// h1) plus, when this guard was first run, three more (the token pill, the
// forwarded-version strip, the "Visit $SYM" button, and MigrateModal's ~40
// interpolations). Every one had been live; none was caught by a test, because
// no test mounted a component.
//
// WHY A SOURCE SCAN, NOT A DOM RENDER. A render test is stronger but needs
// jsdom + testing-library and enough router/wagmi/query scaffolding to mount
// these pages — a real dependency and brittle setup for a lean kit — and it
// could not run in the console smoke at all, since fixtures are
// `import.meta.env.DEV`-only and the smoke serves a production build. This scan
// reads the actual shipped source, needs nothing, and targets the failure
// exactly. Its stated limit: it reasons about source text, so a field aliased
// to a fresh variable first would slip past; the canonical `ix.symbol` /
// `ix.name` / `.symbol}` forms are what it pins. That is why the fix in
// MigrateModal shadows the prop names rather than aliasing them away.
// ─────────────────────────────────────────────────────────────────────────────

// ⚠ EVERY SOURCE FILE, NOT A LIST — the list WAS the hole (specallocator's
// measurement, 2026-08-07). This gate used to scan six enumerated files, so a
// raw `${ix.symbol}` reintroduced anywhere else kept the suite green. That is
// exactly what happened: the absorption's union dropped the guard on
// BasketListRow's ticker, the file was not on the list, and nothing failed.
//
// A HAND-WRITTEN LIST IS A MEMORY TEST, AND A MERGE DOES NOT HAVE TO PASS IT.
// The matcher was never the weak part — measured over all 408 source files it
// found 12 real offenders and no false ones in the six already covered. So the
// reach is what changes: a glob means a NEW file, or a file someone forgets,
// is scanned by construction rather than by remembering to add it here.
const FILES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob('../../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
  )
    // the scan reads SHIPPED source: its own fixtures and every test file are
    // not render sites, and a test asserting on a raw form would self-trip
    .filter(([path]) => !/\.test\.tsx?$/.test(path) && !/__(fixtures|mocks)__/.test(path))
    .map(([path, src]) => [path.replace(/^\.\.\/\.\.\//, ''), src]),
)

// PRECISELY the BASKET-IDENTITY fields, rendered as text. Two forms:
//   · a template interpolation — `${ix.symbol}`, `${ix.name}`, `${toSymbol}`…
//   · a bare JSX interpolation — `{ix.name …}`, `{toSymbol}`, `{fromSymbol}`
// Scoped to these four identifiers on purpose. Constituent-leg symbols
// (`h.symbol`), spotlight-card symbols (`c.symbol`) and object keys
// (`symbol: dom.symbol`) are a DIFFERENT, weaker class (asset-registry text,
// not the basket's own deployer field) and are a documented follow-up, not
// this gate — widening the pattern to them produced only false positives here.
//
// ⚠ RE-TESTED 2026-08-08 AND THE SCOPE STANDS, with a caveat worth having.
// An adversarial pass found three raw BASKET-identity renders this gate cannot
// see — `fallbackHead!.symbol`, `best.symbol`, `worst.symbol` in CreatorJourney
// — because the pattern names four identifiers and those are the same class
// under different variable names. That IS the six-file-list failure one axis
// over: an enumerated list is a memory test.
//
// But widening it is not the fix it looks like. Matching any `X.symbol` /
// `X.name` produces 64 hits, and inverting to a safe-list (brand, chain cfg)
// still leaves 64 — because nearly all of them are the weaker class this
// comment already excludes on purpose. A gate that reports 64 findings, most of
// which are deliberate, is a gate someone switches off.
//
// So the three were bounded AT THE SOURCE instead, and the honest statement of
// this gate's reach is: it covers the basket's own deployer fields WHERE THEY
// ARE NAMED `ix.*`, and nothing guarantees a new render uses that name. The
// real follow-up is a typed brand on the deployer-controlled fields so the
// compiler enforces it — which is a project, not a pattern tweak.
const IDENTITY = String.raw`(?:ix\.symbol|ix\.name|toSymbol|fromSymbol)`
const TEMPLATE = new RegExp(String.raw`\$\{\s*${IDENTITY}\b`)
const JSX = new RegExp(String.raw`\{\s*${IDENTITY}\b`)
/** Already safe on this line. */
const SANITISED = /show(Symbol|Name)\s*\(/
/** Handed DOWN to a child as a prop (`symbol={ix.symbol}`, `toSymbol={toSymbol}`)
 *  — the child owns its own sanitisation. Recognised by an identifier + `=`
 *  immediately before the interpolation. */
const PROP_PASS = new RegExp(String.raw`\b[A-Za-z]+=\{\s*(?:${IDENTITY}|forwarded)`)

/** An identity name SHADOWED by a sanitised local at file scope —
 *  `const toSymbol = showSymbol(rawToSymbol)` — is safe everywhere below it.
 *  This IS the recommended fix (sanitise once, shadow the prop name), so the
 *  guard has to recognise it rather than flag every use of the shadowed name. */
function locallySafe(text: string): Set<string> {
  const safe = new Set<string>()
  for (const m of text.matchAll(/const\s+(toSymbol|fromSymbol|ix)\b[^=]*=\s*show(?:Symbol|Name)\s*\(/g)) safe.add(m[1])
  return safe
}

function rawRenders(file: string, text: string): string[] {
  const safe = locallySafe(text)
  const hits: string[] = []
  text.split('\n').forEach((line, i) => {
    if (!TEMPLATE.test(line) && !JSX.test(line)) return
    if (SANITISED.test(line)) return
    if (PROP_PASS.test(line)) return
    // the render uses a name this file already re-bound to a sanitised value
    if ([...safe].some((name) => new RegExp(String.raw`\$?\{\s*${name}\b`).test(line))) return
    hits.push(`${file}:${i + 1} → ${line.trim().slice(0, 90)}`)
  })
  return hits
}

describe('deployer strings never render raw', () => {
  it('has real source to scan — an empty import would make this vacuous', () => {
    for (const [f, src] of Object.entries(FILES)) {
      expect(src.length, `${f} raw import must resolve`).toBeGreaterThan(200)
    }
  })

  it('routes every basket name/ticker render through safe-copy', () => {
    const offenders = Object.entries(FILES).flatMap(([f, src]) => rawRenders(f, src))
    expect(offenders).toEqual([])
  })

  it('the scan actually bites — a raw render in a probe string is caught', () => {
    const probe = ['              {ix.symbol}', '              <span>${ix.name}</span>'].join('\n')
    expect(rawRenders('probe', probe).length).toBe(2)
  })

  it('does not false-positive on a sanitised line or a prop-pass', () => {
    const ok = ['  {showSymbol(ix.symbol)}', '  <Foo symbol={ix.symbol} name={ix.name} />'].join('\n')
    expect(rawRenders('probe', ok)).toEqual([])
  })
})
