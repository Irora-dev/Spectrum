// The chat kit's sync tool (the napkyn resync contract, chat edition):
// vendors the manifest's file set into a consumer tree. Files land read-only
// in spirit — the consumer adapts its DOMAIN at the seams (CHAT-KIT.md), and
// fixes to the kit itself flow through THIS source, then re-sync.
//
//   node scripts/chat-kit/resync.mjs /path/to/consumer/app [--dry]
//
// Copies app-relative paths verbatim (directories recursively), prints what
// moved, then prints the seam checklist. It never deletes on the target and
// never rewrites imports: mapping `lib/spectrum/*` to the consumer's own
// modules IS the adoption work, and doing it explicitly is the point.
import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = join(HERE, '..', '..')
const target = process.argv[2]
const dry = process.argv.includes('--dry')
if (!target) {
  console.error('usage: node scripts/chat-kit/resync.mjs /path/to/consumer/app [--dry]')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'))
const groups = ['shell', 'brain', 'cards', 'mascot', 'docs', 'driver']
let copied = 0
for (const g of groups) {
  for (const rel of manifest[g]) {
    const src = join(APP, rel)
    if (!existsSync(src)) {
      console.error(`MISSING in source: ${rel} — the manifest is stale, fix it first`)
      process.exit(1)
    }
    const dst = join(target, rel)
    const isDir = statSync(src).isDirectory()
    console.log(`${dry ? 'would copy' : 'copy'} ${g.padEnd(6)} ${rel}${isDir ? '/' : ''}`)
    if (!dry) {
      mkdirSync(dirname(dst), { recursive: true })
      cpSync(src, dst, { recursive: true })
    }
    copied++
  }
}
console.log(`\n${dry ? 'would sync' : 'synced'} ${copied} entries → ${target}`)
console.log(`\nNOT copied (deliberate):
- index.css blocks — lift the marked blocks by hand: ${manifest.cssBlocks.markers.join(' · ')}
- app dependencies — map to YOUR modules (the domain seam):`)
for (const m of manifest.appDependencies.modules) console.log(`    · ${m}`)
console.log(`\nNext: read src/components/chat/CHAT-KIT.md — the adoption seams, in order.`)
