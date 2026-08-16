#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// THE RELEASE MANIFEST (desk 250's last outside-the-bundle control).
//
// THE QUESTION IT ANSWERS: can an operator — or a user, or us after an
// incident — prove the bundle they were SERVED is the bundle we RELEASED?
// Nothing in this app could, and every other control here guards what happens
// INSIDE a build we assume is ours.
//
// ⚠ AND IT IS DELIBERATELY NOT SRI, which is the trap in the desk note's own
// title. Subresource Integrity secures a CROSS-ORIGIN script against a
// compromised CDN. Our index.html loads ONE module from its OWN origin, so an
// integrity attribute would be signed by the same server that serves the file:
// an attacker who can change the JS can change the hash beside it. Copying a
// CDN-era recipe would produce a reassuring attribute that proves nothing —
// this lane's recurring failure mode, a control announcing a protection it
// never had.
//
// SO THE ARTIFACT IS THE RELEASE, NOT THE PAGE. This writes
// dist/release-manifest.json: every shipped file with its sha256, plus a single
// bundleDigest over the sorted list. That digest is what a human publishes
// somewhere the web server does not control (a release note, a tag, a pinned
// message). Then anyone can recompute it from what they were served and compare
// against a value the serving host never touched. The verification is
// out-of-band BY DESIGN — that is the only place it has any strength.
//
// WHAT THIS DOES NOT DO, stated because a half-claim here is the whole sin:
// it does not sign anything (no key exists in this repo), it does not verify at
// runtime (a page checking its own hash is the same-origin circularity again),
// and it cannot tell a legitimate rebuild from a tampered one — only that two
// artifacts differ. Publishing the digest is a HUMAN step and the control does
// not exist until someone does it.
//
// Runs in `postbuild`, so a release cannot be cut without one.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, lstatSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(APP, 'dist')
const OUT = join(DIST, 'release-manifest.json')

if (!existsSync(DIST)) {
  console.error('release-manifest: no dist/ — build first')
  process.exit(1)
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) continue // a link is not a shipped byte
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

// the manifest never hashes ITSELF (it does not exist yet on a first run and
// would change its own digest on every subsequent one)
const files = walk(DIST)
  .filter((f) => f !== OUT)
  .map((f) => ({ path: relative(DIST, f).split('\\').join('/'), bytes: lstatSync(f).size, sha256: sha(readFileSync(f)) }))
  .sort((a, b) => (a.path < b.path ? -1 : 1))

// ONE digest over the sorted (path, hash) pairs — order-independent because the
// list is sorted, and it covers ADDITIONS and DELETIONS, not just edits: a file
// nobody expected changes the digest exactly as much as a modified one.
const bundleDigest = sha(files.map((f) => `${f.path} ${f.sha256}`).join('\n'))

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      _doc: 'Hashes of every file in this release. VERIFY OUT-OF-BAND: recompute bundleDigest from what you were served and compare it against a value published where the web server cannot change it. A digest read from the same host it describes proves nothing.',
      algorithm: 'sha256',
      fileCount: files.length,
      bundleDigest,
      files,
    },
    null,
    2,
  )}\n`,
)

console.log(`release-manifest: ${files.length} files, bundleDigest ${bundleDigest}`)
console.log('  ⚠ PUBLISH THAT DIGEST somewhere this server does not control, or this control does not exist.')
