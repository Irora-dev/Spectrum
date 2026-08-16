#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// WHAT REACHES THE CLIENT BUNDLE — the credential gate (A9).
//
// ⚠⚠ THIS FILE HAS NOW FAILED ITS OWN TITLE TWICE, and the second failure is
// the instructive one.
//
// ROUND 1 printed "no credential reaches the client" while
// `VITE_ALCHEMY_API_KEY` — live, paid, metered — sat in the bundle. It checked
// two hardcoded NAMES and one SHAPE (a UUID), and that key matched neither.
//
// ROUND 2 (this rewrite's predecessor) claimed to fix the CLASS by going
// value-based. It did not. Review measured it: the name filter
// (`VITE_` prefix + a name regex + a length cut) sat IN FRONT of the value
// scan, so the value scan only ever saw what the name list had already
// approved — a name-filtered value list, which is the same failure one layer
// down. It skipped 14 of 16 resolved variables without naming or counting
// them; it could not see a credential embedded in `VITE_*_RPC_URL` (the
// DOCUMENTED first-precedence path for exactly the key it was built around);
// its hand-rolled env parser diverged from vite on `export`, on inline `#`
// comments and on `${}` expansion, printing "value NOT present in the build
// output" over secrets that demonstrably were; and a `dist/` containing no
// scanned extension passed green while deleting the accepted-exposure
// disclosure.
//
// THE LESSON, and the reason this header is long: the danger was never one
// missing rule. It was the OUTPUT GRAMMAR — "unresolvable", "unparsed",
// "unscanned" and "checked and clean" all rendered as the same reassuring
// line. A gate whose clean output is identical whether it checked everything
// or nothing is still a banner people trust for untrue reasons.
//
// SO THIS VERSION:
//   · resolves env with VITE'S OWN `loadEnv` — the exact function the build
//     uses, so a parser divergence is not expressible.
//   · value-scans EVERY resolved value. No name pre-filter. Names decide the
//     SEVERITY of a hit, never whether we look.
//   · reports DENOMINATORS on every run: resolved vs scanned, files present vs
//     read, and every skip with its reason.
//   · says NOT CHECKED, loudly, wherever it could not check — including a
//     server-only name that resolves to nothing, which is the production case.
//
// Run: node scripts/no-client-secrets.mjs   (exit 1 on any finding)
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(APP, '..')
const findings = []
const notes = []

/** Genuinely non-textual output — the ONLY reason to skip a shipped file.
 *  Everything else is decoded latin1 so a NUL cannot hide a credential (F1). */
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|pdf|zip|gz|br|wasm|xpi)$/i

/** Never in the bundle, under any name or prefix. */
const SERVER_ONLY = ['ZEROX_API_KEY']

/** Keys accepted as public, each with WHY and what bounds the damage. Iterated
 *  INDEPENDENTLY below, so every entry reports its status every run — the
 *  previous cut consulted this list only inside a filtered loop, which made
 *  one of its two entries structurally unreachable. */
const ACCEPTED_PUBLIC = [
  {
    name: 'VITE_ALCHEMY_API_KEY',
    why: 'an RPC key, and the app carries keyless public fallbacks, so a burned key degrades reads rather than breaking the app.',
    control: 'MUST be origin-restricted in the Alchemy dashboard. That is the whole of the protection and it is NOT verifiable from here.',
  },
  {
    name: 'VITE_WALLETCONNECT_PROJECT_ID',
    why: 'a project identifier for the WalletConnect relay, public by design in every dapp.',
    control: 'allowlist the deployed origins in the WalletConnect dashboard.',
  },
  {
    name: 'VITE_SITE_URL',
    why: "the site's own canonical URL — substituted into index.html's og:url/og:image meta tags at build time, which is the one job it exists for. It is the address the page is served FROM: a reader of the deployed page already knows it.",
    control: 'none needed — an origin is an address, not a credential. The operator sets it per deploy (site.config.json siteUrl or the env override).',
  },
  {
    name: 'VITE_LIFI_INTEGRATOR',
    why: 'the LI.FI integrator LABEL — it rides every quote request the browser makes, so it is published by design; it is an attribution tag, not a credential. (Its value is also a common word in this app, so a bundle hit cannot even distinguish the tag from ordinary copy — either way there is nothing to protect.)',
    control: 'none needed — LI.FI attributes fee share by this label plus the API key, and the key is server-side only.',
  },
]

/** Values that are public BY DESIGN and would otherwise be reported on every
 *  run as noise. Shape-based, not name-based: an EVM address and a chain id
 *  are public facts whatever variable carries them. */
const isPublicByShape = (v) => /^0x[0-9a-fA-F]{40}$/.test(v) || /^\d{1,7}$/.test(v) || /^(true|false)$/i.test(v)

/** Does this look like it carries a credential? Used ONLY to grade a hit that
 *  the value scan already found — never to decide whether to look. */
const NAMED_SECRET = /(KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|CREDENTIAL|AUTH|DSN|APIKEY|PRIVATE|MNEMONIC|SEED|PHRASE|SALT|COOKIE|SESSION|JWT|BEARER|PIN|OTP|WEBHOOK)/i
const looksLikeCredential = (name, value) => {
  if (NAMED_SECRET.test(name)) return true
  // an RPC/provider URL with a path segment is the documented way an Alchemy
  // key reaches this app without a *_KEY name
  if (/^https?:\/\/[^/]+\/.+/.test(value)) return true
  // a long mixed-alphanumeric run with no spaces
  return value.length >= 20 && /[A-Za-z]/.test(value) && /[0-9]/.test(value) && !/\s/.test(value)
}

// ── env resolution: VITE'S OWN LOADER, so a divergence cannot exist ─────────
const MODE = process.env.NODE_ENV === 'development' ? 'development' : 'production'
const viteEnv = loadEnv(MODE, APP, 'VITE_') // exactly what the build inlines
const resolved = new Map(Object.entries(viteEnv).filter(([, v]) => v))
notes.push(`env: vite loadEnv(mode=${MODE}) → ${resolved.size} VITE_ value(s)`)

// SERVER-ONLY names are NOT VITE_-prefixed by design, so they never appear in
// the map above. Read them directly — the previous cut looked for them only in
// the VITE_ map, which made the check dead in exactly the documented
// production configuration (key set in the host dashboard).
const serverValues = new Map()
for (const name of SERVER_ONLY) {
  const v = process.env[name] || viteEnv[name] || ''
  if (v) serverValues.set(name, v)
}

function walkAll(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try {
      st = lstatSync(p)
    } catch {
      findings.push(`${relative(APP, p)}: could not stat — the scan could not cover it`)
      continue
    }
    if (st.isSymbolicLink()) {
      // ⚠⚠ F3 HIGH (SpectrumContracts, 2026-08-07 — AN EXIT-0 BYPASS, MEASURED).
      // This was a NOTE, so a symlinked source file defeated ALL THREE
      // source-side rules at once. Measured with byte-identical content: as a
      // real file, evil-probe.ts produced 3 findings (the VITE_ZEROX prefix
      // rule, the client-reads-it rule, and the direct-0x-fetch rule), exit 1;
      // as a SYMLINK, 0 findings and exit 0 with one dot-note. And a symlinked
      // source module IS COMPILED INTO THE BUNDLE (verified with an isolated
      // real build) as long as its target is inside the project root — the
      // src/generated → monorepo shape. A symlinked DIRECTORY removes its whole
      // subtree from every rule.
      //
      // Three of the four routes the change protocol calls "each verified to
      // bite" were defeated by one symlink, leaving a dot-note — against this
      // file's own law: fail closed, and SAY WHICH.
      findings.push(
        `${relative(APP, p)} is a SYMLINK and was not followed — a symlinked source file still compiles into the bundle, so it must not be able to skip the source-side rules. Replace it with a real file, or scan its target explicitly.`,
      )
      continue
    }
    if (st.isDirectory()) walkAll(p, out)
    else out.push(p)
  }
  return out
}

const isTest = (f) => /\.(test|spec)\.[jt]sx?$/.test(f)
// F6: the source-side rules were blind to .json/.yml/.css/.html under src/ —
// several are imported and SHIP, and concretely `api.0x.org` in
// src/site.config.json bypassed the direct-fetch rule entirely. They were also
// absent from buildInputs, so editing one did not even trip the freshness rule.
const codeExt = (f) => /\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml|css|html)$/.test(f)
const allSrc = walkAll(join(APP, 'src')).filter(codeExt)
const clientFiles = allSrc.filter((f) => !isTest(f))
const CONFIG_PATHS = [join(APP, 'vite.config.ts'), join(APP, 'index.html'), join(APP, '.env.example'), join(APP, 'vercel.json'), join(ROOT, 'netlify.toml')]
for (const p of CONFIG_PATHS) if (!existsSync(p)) findings.push(`${relative(ROOT, p)} is listed for scanning but does not exist — a path that scans nothing is not a check`)
// ⚠ EXCLUDES tests and scripts/: neither is compiled into the bundle, and
// including them made the freshness check fire on a test file another reviewer
// had just created — a finding about the bundle caused by a file with nothing
// to do with it. Editing this very gate also used to trip it.
const buildInputs = [...clientFiles, ...CONFIG_PATHS.filter(existsSync)]
const serverFiles = walkAll(join(APP, 'netlify')).filter(codeExt)

const readOr = (f, onFail) => {
  try {
    return readFileSync(f, 'utf8')
  } catch {
    findings.push(`${relative(APP, f)}: ${onFail}`)
    return null
  }
}

// ── 1. no server-only secret may wear the VITE_ prefix, any spelling/case ───
const SERVER_FAMILY = /^VITE_[A-Z0-9_]*(ZEROX|ZERO_X|0X|ZRX|MATCHA|AGGREGATOR)[A-Z0-9_]*$/i
for (const f of [...allSrc, ...CONFIG_PATHS.filter(existsSync), ...serverFiles]) {
  const text = readOr(f, 'unreadable — the scan could not cover it')
  if (text === null) continue
  const rel = relative(APP, f)
  const isServerFile = rel.split(sep)[0] === 'netlify'
  for (const nm of text.match(/VITE_[A-Za-z0-9_]+/g) ?? []) {
    if (SERVER_FAMILY.test(nm) && !isServerFile) findings.push(`${rel}: ${nm} — the VITE_ prefix INLINES the value into the client bundle. This family is server-side only.`)
    // a SERVER file must not read a VITE_ var for a credential either
    if (isServerFile && SERVER_FAMILY.test(nm)) findings.push(`${rel}: reads ${nm} — a server file must read the UNPREFIXED name; the VITE_ form is the published one.`)
  }
}

// ── 2. client code may not READ a server-only secret ────────────────────────
for (const f of clientFiles) {
  const text = readOr(f, 'unreadable — the scan could not cover it')
  if (text === null) continue
  const rel = relative(APP, f)
  for (const s of SERVER_ONLY) {
    if (new RegExp(`(import\\.meta\\.env|process\\.env)\\s*(\\.\\s*(VITE_)?${s}\\b|\\[\\s*['"\`](VITE_)?${s})`, 'i').test(text)) {
      findings.push(`${rel}: reads ${s}. Client code cannot hold a credential — call the proxy instead.`)
    }
  }
  if (/process\.env\s*\.\s*[A-Z_]*(KEY|SECRET|TOKEN)/.test(text)) findings.push(`${rel}: reads a KEY/SECRET/TOKEN from process.env in CLIENT code.`)
}

// ── 3. the browser must not reach the aggregator, by host OR by constant ────
const PROXY_MODULE = join('src', 'lib', 'spectrum', 'zerox-proxy-request.ts')
for (const f of clientFiles) {
  const rel = relative(APP, f)
  if (rel === PROXY_MODULE) continue // EXACT path — a suffix match exempted `evil-zerox-proxy-request.ts`
  const text = readOr(f, 'unreadable — the scan could not cover it')
  if (text === null) continue
  if (/api\.0x\.org/.test(text) && /fetch\s*\(/.test(text)) findings.push(`${rel}: names api.0x.org in a file that fetches — it must go through /api/zerox.`)
  if (/\bZEROX_HOST\b/.test(text)) findings.push(`${rel}: references ZEROX_HOST — that constant is for the PROXY to build an upstream URL, not for client code.`)
}

// ── 4. THE GROUND TRUTH: what is actually in the built output ───────────────
const dist = join(APP, 'dist')
if (!existsSync(dist)) {
  findings.push('dist/ is absent, so the BUILT-OUTPUT scan did not run — run `npm run build` first. A skipped backstop is not a pass.')
} else {
  const present = walkAll(dist)
  // read EVERYTHING, skipping only what is genuinely binary (a NUL in the head
  // sample). An extension allowlist had left 17 of 131 files unread, including
  // `_headers` and `_redirects` — extensionless, and a standard place a key
  // lands in a proxy rule.
  const texts = []
  const skipped = []
  for (const f of present) {
    let buf
    try {
      buf = readFileSync(f)
    } catch {
      findings.push(`${relative(APP, f)}: unreadable in dist — the scan could not cover it`)
      continue
    }
    // ⚠⚠ F1 HIGH (SpectrumContracts, 2026-08-07 — AN EXIT-0 BYPASS, MEASURED).
    // This used to skip any file with a NUL in its first 8KB and print only a
    // COUNT. The live bundle contains dist/assets/safe-copy-*.js — 279 bytes of
    // real JavaScript with its first NUL at BYTE 10, because safe-copy.ts
    // commits a literal NUL in its control-character regex. Permanent, every
    // build. Measured with one identical plant: in index-*.js → 2 findings,
    // exit 1; in safe-copy-*.js → 0 findings, EXIT 0, printing "nothing
    // UNACCOUNTED found". So a secret rollup happened to group into that chunk
    // was invisible to BOTH the env-value scan and the UUID rule — coverage
    // decided by WHICH CHUNK THE BYTES LANDED IN, which is exactly what this
    // file's own provenance section rejects. And the denominator was a count
    // WITHOUT NAMES, so no reader could tell a .js file was among the skipped.
    //
    // A NUL no longer decides anything for a file we can read as text: decode
    // latin1 (byte-preserving, so a value scan still matches exactly) and skip
    // only what is genuinely non-textual by EXTENSION. Every skip is NAMED, and
    // a skipped CODE file is a FINDING rather than a note.
    const rel = relative(APP, f)
    if (BINARY_EXT.test(rel)) {
      skipped.push(rel)
      continue
    }
    texts.push({ rel, text: buf.toString('latin1') })
  }
  notes.push(`built output: read ${texts.length} of ${present.length} file(s); skipped ${skipped.length} by extension${skipped.length ? `: ${skipped.join(', ')}` : ''}`)
  for (const sk of skipped) {
    if (/\.(js|mjs|cjs|json|css|html|txt|map)$/i.test(sk))
      findings.push(`${sk}: a shipped TEXT file was not scanned — coverage must never be decided by which chunk the bytes landed in`)
  }

  if (texts.length === 0) {
    findings.push('dist/ contains no readable files — the scan covered NOTHING, which is not a pass. Rebuild and re-run.')
  }

  // freshness, scoped to what actually compiles into the bundle
  const newest = (files) => files.reduce((m, f) => Math.max(m, lstatSync(f).mtimeMs), 0)
  const compiled = present.filter((f) => f.includes(`${sep}assets${sep}`))
  if (compiled.length && newest(buildInputs) > newest(compiled)) {
    findings.push('the compiled bundle is OLDER than the sources it is built from — this scan would describe a bundle nobody is shipping. Rebuild, then re-run.')
  }

  const findValue = (v) => texts.filter((t) => t.text.includes(v)).map((t) => t.rel)

  // (a) SERVER-ONLY — and say NOT CHECKED when there is nothing to look for
  for (const name of SERVER_ONLY) {
    const v = serverValues.get(name)
    if (!v) {
      notes.push(`⚠ ${name}: NOT CHECKED — no value resolvable here. In production this is set in the host dashboard, so this run cannot prove its absence from the bundle.`)
      continue
    }
    const hits = findValue(v)
    if (hits.length) findings.push(`${name}'s VALUE appears in ${hits.length} built file(s) (${hits[0]}) — a server-side credential is being published.`)
    else notes.push(`${name}: value resolvable and NOT present in the build output`)
  }

  // (b) EVERY resolved value, no name pre-filter. Names grade a hit; they
  //     never decide whether we look.
  let scanned = 0
  const benign = []
  for (const [name, value] of resolved) {
    if (value.length < 8) {
      notes.push(`${name}: not value-scanned (under 8 chars — too short to identify in the bundle)`)
      continue
    }
    scanned += 1
    const hits = findValue(value)
    if (!hits.length) continue
    const accepted = ACCEPTED_PUBLIC.find((a) => a.name === name)
    if (accepted) continue // reported independently below
    // ⚠⚠ F2 HIGH (SpectrumContracts, 2026-08-07 — AN EXIT-0 BYPASS, MEASURED).
    // A name+shape test used to decide whether a hit was REPORTED AT ALL, which
    // is verbatim how this file's own header describes ROUND 2's defect — "the
    // same failure one layer down". Round 2 put a name filter IN FRONT of the
    // value scan; this one sat BEHIND it.
    //
    // MEASURED: VITE_DEV_MNEMONIC="test test … junk" — A BIP-39 SEED PHRASE —
    // present in the bundle, EXIT 0, and reported as "published and
    // public-by-shape". It escaped on the whitespace clause (!/\s/), and
    // VITE_ADMIN_OVERRIDE=abcdefghijklmnopqrstuvwx escaped identically for
    // having no digits. NAMED_SECRET also omitted MNEMONIC, SEED, PHRASE,
    // PASSPHRASE, SALT, COOKIE, SESSION, JWT, BEARER, PIN, OTP and WEBHOOK.
    //
    // AND THE LABEL WAS A FALSE SENTENCE: benign[] was filled BOTH from
    // isPublicByShape AND from this else-branch, then the summary called the
    // whole array "published and public-by-shape". Neither measured value
    // matched isPublicByShape. The gate asserted a provenance it never
    // established — the exact sin this file exists to refuse.
    //
    // SO A HIT IS NOW ALWAYS A FINDING unless the value is public BY SHAPE
    // (an address, a chain id, a boolean — facts that are public whatever
    // variable carries them) or explicitly ACCEPTED_PUBLIC. `looksLikeCredential`
    // no longer decides visibility; it only grades the WORDING, which is what
    // the header always claimed.
    if (isPublicByShape(value)) {
      benign.push(name)
      continue
    }
    const graded = looksLikeCredential(name, value)
      ? 'it looks like a credential'
      : 'we cannot tell what it is, which is not the same as knowing it is safe'
    findings.push(
      `${name}: its VALUE is in ${hits.length} built file(s) (${hits[0]}) and it is NOT on the accepted-public list — ${graded}. Route it through a server-side proxy, or add it to ACCEPTED_PUBLIC with its reason and compensating control.`,
    )
  }
  notes.push(
    `value-scanned ${scanned} of ${resolved.size} resolved VITE_ value(s); ${benign.length} PUBLIC BY SHAPE — an EVM address, a chain id or a boolean (${benign.join(', ') || 'none'}). Nothing else is excused by its shape.`,
  )

  // (c) the accepted list, ALWAYS, whatever else happened
  for (const a of ACCEPTED_PUBLIC) {
    const v = resolved.get(a.name)
    if (!v) notes.push(`⚠ ${a.name}: ACCEPTED-PUBLIC but NOT SET here — status in production unknown from this run. ${a.control}`)
    else if (findValue(v).length) notes.push(`⚠ ${a.name}: PUBLISHED — ACCEPTED. ${a.why} Control: ${a.control}`)
    else findings.push(`${a.name}: is set and accepted-as-published, but its value is NOT in the build output — either the scan is broken or the build is stale. An accepted exposure that cannot be found is not reassurance.`)
  }

  // ── (d) UUID-SHAPED LITERALS, SORTED BY PROVENANCE ────────────────────────
  //
  // ⚠ THIS RULE WENT RED ON A CORRECTLY CONFIGURED BUILD, and the way it did
  // is the interesting part. Turning WalletConnect on (UIGuy, 2026-08-07,
  // the owner's call) took this rule from 2 literals to 41. Reproduced here
  // exactly, one env var the only difference: 39 findings, and they were TWO
  // separate defects wearing one error message.
  //
  //  1. THE FIRST FINDING WAS `VITE_WALLETCONNECT_PROJECT_ID` ITSELF — a value
  //     this gate had already resolved, already matched to ACCEPTED_PUBLIC, and
  //     already reported correctly in section (c) with its reason and its
  //     compensating control. The shape rule then flagged it a SECOND time as
  //     "not accounted for", because it never asked whether the gate already
  //     knew what the literal was.
  //  2. THE OTHER 38 SHIP INSIDE DEPENDENCIES — @reown/appkit-utils'
  //     PresetsUtil chain-id→network-image table, pulled in transitively by the
  //     walletConnect connector (e.g. 3897a66d-… keyed to chain 1088, Metis).
  //     Public asset ids that were on npm before they were in our bundle.
  //
  // WHY NOT THE TWO OBVIOUS FIXES. Skipping vendor chunks decides coverage by
  // WHERE THE BYTES LANDED — and chunk membership is a rollup decision, not a
  // trust boundary, so a credential grouped into a vendor chunk would walk
  // straight past. That is this file's ROUND 2 defect exactly: a filter in
  // front of a scan IS the scan's real coverage. Listing the 38 literals by
  // name rots on Reown's next release, and a maintainer meeting a 39th just
  // pastes it in — a control maintained by paperwork is a control that gets
  // switched off.
  //
  // SO SORT BY PROVENANCE, which is the question actually worth asking: did
  // this literal come from US, or does it ship inside a package? Both halves
  // are decidable. Ours = it equals a value `loadEnv` resolved. Vendored = the
  // exact literal exists in installed node_modules. What remains — in neither
  // place — is hardcoded in our own source, and that is the only case this rule
  // was ever built to catch.
  //
  // FAIL-CLOSED, AND SAY WHICH: where the vendor question is UNANSWERABLE every
  // unresolved literal stays a finding and the note says NOT CHECKED. "Could
  // not clear it" must never print as "cleared it".
  //
  // ⚠ AND THE FINDING MAY NOT OVERCLAIM. My earlier note here claimed the
  // absent-node_modules branch was UNREACHABLE because this file imports
  // `loadEnv` from vite and would die at import. **That claim was wrong and a
  // reviewer measured it** (F5, 2026-08-07): with node_modules HOISTED TO THE
  // REPO ROOT, node resolution walks up parents so the vite import resolves
  // fine while `existsSync(join(APP,'node_modules'))` is false — the branch
  // fires correctly and exits 1. My reasoning held only for the layout I
  // happened to test. Corrected rather than deleted, because a file whose whole
  // thesis is not printing sentences you have not earned should show its own. The
  // REACHABLE version is a PARTIAL tree (`npm ci --omit=dev`, a pruned deploy
  // image), where grep runs fine and simply does not find a package that was
  // never installed. So an unresolved literal is reported as "not from env and
  // not in any installed package" and NOT as "hardcoded in our source": the
  // scan cannot distinguish those two, and asserting the stronger one would be
  // a false sentence on a security surface — this file's own recurring sin.
  // Pruned to empty 2026-08-14: both prior entries (the UUID-v4 generation
  // template; Coinbase SDK's component id) left the bundle with the wagmi 2→3
  // upgrade and stood as DEAD CONSENT — this file's own note called for the
  // prune. If either literal ever returns, it gets fresh eyes, not a stale pass.
  const BENIGN_UUIDS = []
  // F6: the DASHED canonical form is not the only shipping form — NO-DASH
  // 32-hex is how WalletConnect/Infura/Sentry project ids are stored, and it was
  // invisible here. Both forms now, and the printed prefix is long enough to
  // TELL TWO LITERALS APART (slice(0,8) printed three distinct planted values
  // identically, so triaging 39 findings degraded into guesswork).
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{32}\b/gi
  const seen = new Map()
  for (const { rel, text } of texts) for (const hit of text.match(uuid) ?? []) if (!seen.has(hit.toLowerCase())) seen.set(hit.toLowerCase(), rel)

  const named = []
  const fromEnv = []
  let candidates = []
  for (const [v, rel] of seen) {
    if (BENIGN_UUIDS.some((b) => b.value.toLowerCase() === v)) {
      named.push(v)
      continue
    }
    // OURS: it is a value the build was given. Sections (b)/(c) own the verdict
    // on whether that value may be published — this rule must not double-report
    // it, and must not let it be silently cleared as "vendored" either.
    const envName = [...resolved, ...serverValues].find(([, value]) => value.toLowerCase() === v)?.[0]
    if (envName) {
      fromEnv.push(`${v.slice(0, 16)}… = ${envName}`)
      continue
    }
    candidates.push([v, rel])
  }

  const vendored = []
  if (candidates.length === 0) {
    notes.push('no UUID-shaped literal needed vendor-provenance checking')
  } else if (!existsSync(join(APP, 'node_modules'))) {
    notes.push(
      `⚠ VENDOR PROVENANCE NOT CHECKED — node_modules is absent, so this run could not tell a library constant from a hardcoded secret. All ${candidates.length} unresolved literal(s) are reported as findings (fail-closed). Run \`npm ci\` and re-run to clear the vendored ones.`,
    )
  } else {
    // ONE grep pass, and `-a` is load-bearing: grep calls a minified file
    // binary on a stray byte and then MATCHES NOTHING IN IT, which would turn
    // "I could not look" into "it is not there" — the read-failed law wearing a
    // grep. `-o` with filenames lets one traversal both clear a literal and
    // name the package it came from.
    const patterns = candidates.map(([v]) => v).join('\n')
    let out = null
    try {
      out = execFileSync(
        'grep',
        ['-roaiF', '--include=*.js', '--include=*.mjs', '--include=*.cjs', '--include=*.json', '-f', '-', 'node_modules'],
        { cwd: APP, input: patterns, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      )
    } catch (e) {
      // grep exits 1 on "no matches" — that is a real answer, not a failure.
      if (e.status === 1) out = e.stdout ?? ''
      else
        notes.push(
          `⚠ VENDOR PROVENANCE NOT CHECKED — the node_modules scan itself failed (${e.code ?? e.status ?? 'unknown'}). All ${candidates.length} unresolved literal(s) stay findings.`,
        )
    }
    // ⚠ F4 (SpectrumContracts, 2026-08-07): BSD grep -r REFUSES TO DESCEND a
    // symlinked directory and exits 1 WITH EMPTY STDERR — indistinguishable
    // from "no matches" — and existsSync FOLLOWS symlinks, so the fail-closed
    // branch above was skipped. Measured on a symlinked node_modules: "0
    // vendored, 1 unexplained", no warning. The same empty-stderr status 1
    // happens on a MISSING directory with these exact flags. So the comment
    // claiming "grep exits 1 on no-matches — that is a real answer" was FALSE
    // here: grep exited 1 having searched NOTHING.
    //
    // A POSITIVE CONTROL settles it, which is the only honest way to tell "found
    // nothing" from "looked at nothing": search for a literal that MUST be
    // present in any real node_modules. If the control does not come back, the
    // scan did not look, and every unresolved literal stays a finding.
    if (out !== null) {
      let searched = false
      try {
        const control = execFileSync('grep', ['-roaslF', '--include=package.json', '-e', '"name"', 'node_modules'], {
          cwd: APP,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8',
        })
        searched = control.trim().length > 0
      } catch {
        searched = false
      }
      if (!searched) {
        out = null
        notes.push(
          `⚠ VENDOR PROVENANCE NOT CHECKED — the positive control found nothing in node_modules, so the scan did not actually read it (a symlinked or missing directory makes grep exit 1 with empty stderr, which is indistinguishable from "no matches"). All ${candidates.length} unresolved literal(s) stay findings.`,
        )
      }
    }
    if (out !== null) {
      const pkgOf = new Map()
      for (const line of out.split('\n')) {
        const cut = line.lastIndexOf(':')
        if (cut < 0) continue
        const path = line.slice(0, cut)
        const lit = line.slice(cut + 1).trim().toLowerCase()
        if (!lit || pkgOf.has(lit)) continue
        const after = path.split(`node_modules${sep}`).pop() ?? path
        const parts = after.split(sep)
        pkgOf.set(lit, parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0])
      }
      const still = []
      for (const [v, rel] of candidates) {
        const pkg = pkgOf.get(v)
        if (pkg) vendored.push(`${v.slice(0, 16)}… (${pkg})`)
        else still.push([v, rel])
      }
      candidates = still
    }
  }

  for (const [v, rel] of candidates)
    findings.push(
      `${rel}: UUID-shaped literal ${v.slice(0, 16)}… matches NO env value this run resolved and was NOT found in any installed package. Either it is hardcoded in our own source (identify it, then remove it or add it to BENIGN_UUIDS with a reason), or the package that carries it is not installed here (run \`npm ci\` and re-run before concluding anything). This check cannot tell those two apart.`,
    )

  // DENOMINATORS, always: the four buckets must sum to the total, so a reader
  // can see what was cleared and on what grounds rather than reading one word.
  notes.push(
    `${seen.size} distinct UUID literal(s): ${named.length} named-benign, ${fromEnv.length} from env values (${fromEnv.join(', ') || 'none'}), ${vendored.length} vendored in node_modules, ${candidates.length} unexplained`,
  )
  // ⚠ A BLESSING NOBODY RE-EXAMINES IS A BLESSING WAITING TO BE MISUSED (found
  // by the wagmi 2→3 upgrade, 2026-08-07: it slimmed the connector tree and both
  // BENIGN_UUIDS entries stopped appearing in the bundle at all). A named
  // exception that no longer matches anything is dead consent — and if a future
  // dependency ships that same literal, the stale entry pre-approves it with
  // nobody having looked. Same reasoning this file already applies to an
  // ACCEPTED_PUBLIC var that is set but absent: an exception you cannot find is
  // not reassurance. A NOTE, not a finding — the exposure is zero today; the
  // point is that pruning becomes a decision instead of an accumulation.
  for (const b of BENIGN_UUIDS) {
    if (!seen.has(b.value.toLowerCase()))
      notes.push(`⚠ BENIGN_UUID ${b.value.slice(0, 16)}… is no longer in the bundle — its exception is now DEAD CONSENT (${b.why}) Prune it, or state why it should keep standing.`)
  }
  if (vendored.length)
    notes.push(`vendored (library constants, not credentials we can leak): ${vendored.slice(0, 6).join(', ')}${vendored.length > 6 ? `, +${vendored.length - 6} more` : ''}`)
  notes.push(
    '⚠ WHAT THIS RUN CANNOT SEE: a hardcoded secret is only caught here if it is UUID-shaped. Vendor provenance clears a literal because it ships in an installed package — which is the right question for a leak of OUR secret, but it is not a supply-chain audit (that is gate A8). Values set exclusively in the host dashboard are not resolvable here and are marked NOT CHECKED above.',
  )
}

// ── report — coverage prints regardless of verdict ──────────────────────────
const line = '─'.repeat(74)
console.log(`\n${line}\nWHAT REACHES THE CLIENT BUNDLE (A9)\n${line}`)
for (const n of notes) console.log(`  · ${n}`)
if (findings.length) {
  console.log(`\n❌ ${findings.length} finding(s):`)
  for (const f of findings) console.log(`  ✗ ${f}`)
  console.log(`\n${line}\nA static bundle cannot hold a secret. If a value must be secret it belongs in a\nSERVER-side variable behind the 0x proxy function.\n${line}\n`)
  process.exit(1)
}
console.log(`\n✅ nothing UNACCOUNTED found in what this run could read — read the coverage lines above for what it could not\n${line}\n`)
