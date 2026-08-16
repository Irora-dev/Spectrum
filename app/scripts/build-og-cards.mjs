#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// PER-BASKET SHARE CARDS — the image half of per-URL OpenGraph.
//
// The edge function already personalises og:TITLE and og:DESCRIPTION per shared
// URL. The IMAGE stayed generic, so every basket anyone shared showed the same
// picture: the thesis travelled in the text and nothing travelled in the
// preview, which is the part people actually see in a feed.
//
// This is option 1 from netlify/edge-functions/README.md — render at BUILD,
// serve from the CDN, no runtime rendering and no wasm/font bundling to validate
// on a live deploy. It reuses the satori→resvg render already proven in
// handover/og-worker (its own test-render.mjs is the pin).
//
// Writes public/og/<chainId>/<address>.png. The edge function points og:image
// there and FALLS BACK to the generic card when a file is missing — which it
// will be for any basket launched after the last build. That fallback is the
// honest behaviour, not a bug: a stale-but-branded card beats a broken one.
//
//   node scripts/build-og-cards.mjs            # reads public/tokenlist.json
//   node scripts/build-og-cards.mjs --self-test # renders a fixture, no data needed
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')
const WORKER = resolve(APP, 'handover/og-worker')

if (!existsSync(resolve(WORKER, 'node_modules'))) {
  console.error('og cards: handover/og-worker deps are not installed — run `npm install` there first.')
  console.error('og cards: skipping (the generic card stays in place).')
  process.exit(0) // never fail an operator's build over a preview image
}

const { default: satori } = await import(resolve(WORKER, 'node_modules/satori/dist/index.js'))
const { Resvg, initWasm } = await import(resolve(WORKER, 'node_modules/@resvg/resvg-wasm/index.mjs'))
const { buildCard } = await import(resolve(WORKER, 'src/card.mjs'))

await initWasm(readFileSync(resolve(WORKER, 'node_modules/@resvg/resvg-wasm/index_bg.wasm')))

const fonts = [
  { name: 'Chakra Petch', data: readFileSync(resolve(WORKER, 'fonts/ChakraPetch-Bold.ttf')), weight: 700, style: 'normal' },
  { name: 'Chakra Petch', data: readFileSync(resolve(WORKER, 'fonts/ChakraPetch-Regular.ttf')), weight: 400, style: 'normal' },
]

/** The operator's own name — never the literal "Spectrum" (name-neutrality rule). */
function brandName() {
  try {
    const src = readFileSync(resolve(APP, 'src/brand.config.ts'), 'utf8')
    return src.match(/name:\s*'([^']+)'/)?.[1] || 'Spectrum'
  } catch { return 'Spectrum' }
}

async function renderCard({ symbol, name, address, brand }) {
  const svg = await satori(buildCard({ symbol, name, address, brand }), { width: 1200, height: 630, fonts })
  return new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng()
}

const brand = brandName()
const selfTest = process.argv.includes('--self-test')

const tokens = selfTest
  ? [{ chainId: 4663, address: '0x2937000000000000000000000000000000008088', symbol: 'LPADS', name: 'Launchpads' }]
  : (() => {
      try {
        const list = JSON.parse(readFileSync(resolve(APP, 'public/tokenlist.json'), 'utf8'))
        return Array.isArray(list.tokens) ? list.tokens : []
      } catch { return [] }
    })()

if (!tokens.length) {
  console.log('og cards: no baskets in the tokenlist — nothing to render (generic card stays).')
  process.exit(0)
}

let written = 0
for (const t of tokens) {
  if (!t?.address || !t?.chainId) continue
  const dir = resolve(APP, `public/og/${t.chainId}`)
  mkdirSync(dir, { recursive: true })
  const out = resolve(dir, `${String(t.address).toLowerCase()}.png`)
  try {
    const png = await renderCard({
      symbol: String(t.symbol || '').replace(/^\$/, ''),
      name: t.name || t.symbol || 'Basket',
      address: String(t.address),
      brand,
    })
    writeFileSync(out, png)
    written++
    console.log(`  ${t.chainId}/${t.symbol} → ${(png.length / 1024).toFixed(1)} KB`)
  } catch (e) {
    // One bad token must never fail the build; that basket keeps the generic card.
    console.error(`  ! ${t.chainId}/${t.symbol}: ${e.message}`)
  }
}
console.log(`og cards: ${written}/${tokens.length} rendered as "${brand}".`)
