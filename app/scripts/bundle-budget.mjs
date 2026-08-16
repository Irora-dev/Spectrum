#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// BUNDLE BUDGET — a regression tripwire, not a diet plan.
//
// WHY. A single dependency can quietly double first load, and nothing failed
// when it did: turning WalletConnect on added ~1MB of vendor code (@reown/
// appkit-utils + the walletconnect provider) and it was invisible until it was
// measured by hand. This fails the build when the shipped JS grows past a
// ceiling with headroom over today's size, and prints the per-chunk breakdown
// so the offender is obvious rather than a mystery.
//
// It measures GZIPPED bytes, because that is what a user downloads and what a
// CDN serves — raw size overstates the cost of the repetitive vendor code that
// dominates here. The ceiling is the total across all chunks: most are route-
// split and lazy, so the total is the honest "how much code did this app grow"
// number, while the entry chunk is reported separately for the first-load view.
//
// Raise the ceiling deliberately, in the same commit that adds the weight and
// says why — never to make a red build green. Run after `npm run build`.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(appDir, 'dist', 'assets')

// BASELINE 2026-08-07: total gzipped JS measured at 1908 KB (web3 2.0MB raw
// dominated by WalletConnect + wagmi/viem; prism-claims, three and charts are
// route-split and lazy). Ceiling ~15% over, so ordinary growth passes and a
// dependency that doubles a chunk fails loudly.
const TOTAL_CEILING_KB = 2200
// The eager first-load entry chunk on its own. Reported and bounded separately:
// a route-split chunk growing is one thing, the entry every visitor downloads
// growing is another. Today's `index-*.js` is ~348 KB raw / well under this.
const ENTRY_CEILING_KB = 700

if (!existsSync(assets)) {
  console.error('bundle-budget: no dist/assets — run `npm run build` first.')
  process.exit(2)
}

const gz = (f) => gzipSync(readFileSync(join(assets, f))).length
const js = readdirSync(assets).filter((f) => f.endsWith('.js') && statSync(join(assets, f)).isFile())

let total = 0
const rows = js
  .map((f) => {
    const kb = gz(f) / 1024
    total += kb
    return { f, kb }
  })
  .sort((a, b) => b.kb - a.kb)

const totalKb = Math.round(total)
// the entry chunk vite names `index-*.js` (the app's own entry, not a vendor split)
const entry = rows.find((r) => /^index-/.test(r.f))
const entryKb = entry ? Math.round(entry.kb) : 0

console.log(`bundle-budget: ${js.length} JS chunks, ${totalKb} KB gzipped total (ceiling ${TOTAL_CEILING_KB})`)
console.log(`  entry chunk: ${entry?.f ?? '(none found)'} — ${entryKb} KB gzipped (ceiling ${ENTRY_CEILING_KB})`)
console.log('  largest chunks:')
for (const r of rows.slice(0, 6)) console.log(`    ${String(Math.round(r.kb)).padStart(5)} KB  ${r.f}`)

const fails = []
if (totalKb > TOTAL_CEILING_KB) fails.push(`total ${totalKb} KB over the ${TOTAL_CEILING_KB} KB ceiling (+${totalKb - TOTAL_CEILING_KB})`)
if (entryKb > ENTRY_CEILING_KB) fails.push(`entry chunk ${entryKb} KB over the ${ENTRY_CEILING_KB} KB ceiling (+${entryKb - ENTRY_CEILING_KB})`)

if (fails.length) {
  console.error(`\nbundle-budget: FAILED\n  ${fails.join('\n  ')}\n  If this growth is intended, raise the ceiling in this file in the same commit and say why.`)
  process.exit(1)
}
console.log('bundle-budget: within budget.')
