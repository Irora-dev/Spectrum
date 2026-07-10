// Local smoke test (node): renders every card through the exact same satori
// template + resvg pipeline the worker uses, writing sample-*.png. No deploy,
// no network. Run `npm install` here first, then `npm run test:render`.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import satori from 'satori'
import { Resvg, initWasm } from '@resvg/resvg-wasm'
import { buildCard, buildCreatorCard, buildReferCard } from './src/card.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
await initWasm(readFileSync(join(HERE, 'node_modules/@resvg/resvg-wasm/index_bg.wasm')))

const FONTS = [
  { name: 'Chakra Petch', data: readFileSync(join(HERE, 'fonts/ChakraPetch-Regular.ttf')), weight: 400, style: 'normal' },
  { name: 'Chakra Petch', data: readFileSync(join(HERE, 'fonts/ChakraPetch-Bold.ttf')), weight: 700, style: 'normal' },
]

async function render(name, element) {
  const svg = await satori(element, { width: 1200, height: 630, fonts: FONTS })
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng()
  writeFileSync(join(HERE, `sample-${name}.png`), png)
  if (png.length < 10_000) throw new Error(`suspiciously small ${name} PNG (${png.length} bytes)`)
  console.log(`sample-${name}.png written (${(png.length / 1024).toFixed(1)} KB, 1200x630)`)
}

const ADDR = '0x0000000000000000000000000000000000ba5e0c'
await render('og', buildCard({ symbol: 'ROTATE2', name: 'Sector Rotator v2', address: ADDR }))
await render('creator', buildCreatorCard({ address: ADDR }))
await render('refer', buildReferCard())
