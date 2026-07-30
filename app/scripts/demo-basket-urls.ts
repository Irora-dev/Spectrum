// Print the trailer demo baskets as openable dev URLs, one per tab.
//   npx vite-node scripts/demo-basket-urls.ts                 (defaults to :5311)
//   npx vite-node scripts/demo-basket-urls.ts http://localhost:5309
import { demoBasketUrls, DEMO_COUNT } from '../src/lib/spectrum/demo-baskets'

const origin = process.argv[2] || 'http://localhost:5311'
const rows = demoBasketUrls(origin)
console.log(`\n${DEMO_COUNT} demo baskets — dev only, needs the dev server on ${origin}\n`)
for (const [i, r] of rows.entries()) {
  console.log(`${String(i + 1).padStart(2)}. ${r.label}\n    ${r.url}`)
}
console.log('\nAll URLs, space-separated (paste into a browser or `open`):\n')
console.log(rows.map((r) => r.url).join(' '))
console.log()
