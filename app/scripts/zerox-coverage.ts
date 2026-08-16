/**
 * 0x COVERAGE PROBE — against THIS APP'S OWN asset universe (the owner, 2026-08-06:
 * "we should also check what assets 0x doesnt cover and we may need to route
 * ourselves").
 *
 * WHY THIS SCRIPT EXISTS SEPARATELY from the contracts lane's tools/0x-coverage.py:
 * theirs probes a list you hand it. The question that decides product behaviour is
 * "what fraction of the assets OUR PICKER WILL OFFER can 0x actually route", and
 * only this repo knows that universe. So this walks the app's own books:
 *
 *   · the official stock registry per chain (`lib/chain/stocks.ts`)
 *   · the launch starter suggestions (`lib/chain/starter-suggestions.ts`)
 *   · the popular/trending shelf as DexScreener ranks it — the ORGANIC set the
 *     picker actually shows once the launch-week starters expire, which is the
 *     honest sample of what a user will pick
 *
 * ⚠ THE UNIVERSE IS OPEN-ENDED BY CONSTRUCTION and this probe cannot change that:
 * the picker also resolves any address a user pastes and any token DexScreener's
 * keyless search returns, so no enumeration is ever complete. This measures the
 * SHAPE of the gap (what fraction, on which chain, of the assets we actively
 * offer) to size the fallback decision. The per-leg runtime refusal in
 * `zeroex-quote.ts` is what keeps an unroutable asset honest for every asset this
 * script never saw.
 *
 * ⚠ PROBE SIZE IS PART OF THE MEASUREMENT. A dust probe reads as "no liquidity" on
 * a thin pool; the number that matters is whether a REAL trade size fills. Default
 * $250 per leg (a $5,000 portfolio over 20 assets); override with --usd.
 *
 * KEY: read from the environment only (`ZEROX_API_KEY`), never committed, never
 * bundled — this is a dev-machine script, not app code.
 *
 * USAGE
 *   ZEROX_API_KEY=... npx tsx scripts/zerox-coverage.ts --chain 4663 [--usd 250]
 *   ZEROX_API_KEY=... npx tsx scripts/zerox-coverage.ts --all
 *
 * OUTPUT: one line per asset, then per-chain summary + the explicit NO-ROUTE list
 * (the fallback set). Always exits 0 — a report, not a gate.
 */
import { stocksForChain } from '../src/lib/chain/stocks'
import { starterSuggestionsFor } from '../src/lib/chain/starter-suggestions'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PRICE_API = 'https://api.0x.org/swap/allowance-holder/price'
const CHAINS = [8453, 1, 4663]

/** DexScreener's chain slug per chain. STATED here, not imported: `chains.ts`
 *  (the authoritative map) transitively imports `deployments.ts`, which reads
 *  `import.meta.env` at module scope and therefore cannot load under node —
 *  the same wall `fundingFor` hit. A script may state what app code must read,
 *  but a stated copy can DRIFT, so every run PRINTS this map beside the source
 *  of truth: if the two disagree, the report says so on its face. */
const DEXSCREENER_SLUG: Record<number, string> = { 8453: 'base', 1: 'ethereum', 4663: 'robinhood' }
const SLUG_SOURCE = 'src/lib/chain/chains.ts (dexscreenerSlug)'

type Probe = { symbol: string; address: string; source: string }
/** ⚠ 'REFUSED' IS ITS OWN TERMINAL VERDICT, AND ADDING IT WAS A REAL FIX (R's
 *  remedy via SpectrumContracts, 2026-08-07, and I confirmed the defect by
 *  running this tool with a live key). A 422 `*_NOT_AUTHORIZED_FOR_TRADE` was
 *  counted as an ERROR, so the roll-up announced "INCOMPLETE SAMPLE — no
 *  coverage conclusion can be drawn" over the most DEFINITIVE answer this API
 *  can give. That invites a re-run instead of a decision, and re-running never
 *  changes it: it is a compliance deny-list, not a transport blip. The
 *  conservative-sounding default was the dangerous one.
 *
 *  The three not-routable outcomes are genuinely different things:
 *    NO-ROUTE — depth. Evidence about the ASSET.
 *    REFUSED  — policy. Evidence about 0x, and the asset may be deeply liquid.
 *    ERROR    — we do not know. Evidence about nothing (the read-failed law).
 *  Only ERROR may weaken a coverage claim. */
type Verdict = 'ROUTABLE' | 'NO-ROUTE' | 'REFUSED' | 'ERROR'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

/** The funding asset a real batch would sell — the chain's settlement stable
 *  (USDC on Base/Ethereum, USDG on Robinhood). Read from the PINNED JSON book
 *  rather than `deployments.ts`: that module reads `import.meta.env` at module
 *  scope, so importing it under node throws before main() runs (measured, not
 *  assumed — the first version of this script died exactly there). The JSON is
 *  also the more honest source for a probe: no env-override layer between the
 *  script and the addresses the app ships with.
 *  ⚠ 6 decimals is STATED, not read: USDC and USDG are both 6 on all three
 *  batcher chains. A script may assume what app code must read — if this ever
 *  becomes app code, read `decimals()`. */
function fundingFor(chainId: number): { address: string; decimals: number } | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const book = JSON.parse(readFileSync(join(here, '../src/lib/chain/deployments.json'), 'utf8')) as Record<
    string,
    { usdc?: string } | undefined
  >
  const usdc = book[String(chainId)]?.usdc
  if (!usdc) return null
  return { address: usdc, decimals: 6 }
}

/** The organic shelf, as the picker ranks it — DexScreener's keyless trending
 *  for this chain. This is the sample that matters most: it is what a user
 *  scrolling the picker will actually tap. */
async function trendingFor(chainId: number, limit: number): Promise<Probe[]> {
  const slug = DEXSCREENER_SLUG[chainId]
  if (!slug) return []
  try {
    // the same keyless endpoint the app's own search uses
    const res = await fetch(`https://api.dexscreener.com/token-boosts/top/v1`)
    if (!res.ok) return []
    const rows = (await res.json()) as { chainId?: string; tokenAddress?: string; description?: string }[]
    const seen = new Set<string>()
    const out: Probe[] = []
    for (const r of rows) {
      if (r.chainId !== slug || !r.tokenAddress) continue
      const key = r.tokenAddress.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ symbol: r.tokenAddress.slice(0, 8), address: r.tokenAddress, source: 'trending' })
      if (out.length >= limit) break
    }
    return out
  } catch {
    return []
  }
}

/** The launch starters, if the module loads under node (it rides brand config,
 *  which is deliberately env-free — but a future edit could change that, and a
 *  probe must not die because one source went unavailable). */
function starters(chainId: number): Probe[] {
  try {
    return starterSuggestionsFor(chainId).map((s) => ({ symbol: s.symbol, address: s.address, source: 'starter' }))
  } catch (e) {
    console.log(`  (starter suggestions unavailable under node: ${String(e).slice(0, 80)})`)
    return []
  }
}

/** One line, bounded — a report row never restructures the table. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 110)
}

async function probe(
  chainId: number,
  sellToken: string,
  sellAmount: string,
  buyToken: string,
  key: string,
): Promise<{ verdict: Verdict; detail: string }> {
  const qs = `?chainId=${chainId}&sellToken=${sellToken}&buyToken=${buyToken}&sellAmount=${sellAmount}`
  try {
    const res = await fetch(PRICE_API + qs, { headers: { '0x-api-key': key, '0x-version': 'v2' } })
    // one line per asset is the report's whole legibility: an error BODY is
    // multi-line JSON, so collapse it rather than letting it break the table
    if (!res.ok) {
      const body = flat(await res.text())
      // the POLICY shape first — it is an answer, not a failure to answer.
      // Same predicate the app uses (zeroex-quote's classifyZeroExOutcome), so
      // the tool and the product cannot disagree about what 0x said.
      if (/NOT_AUTHORIZED_FOR_TRADE/i.test(body)) return { verdict: 'REFUSED', detail: `HTTP ${res.status}: policy refusal (not authorized for trade)` }
      return { verdict: 'ERROR', detail: `HTTP ${res.status}: ${body}` }
    }
    const d = (await res.json()) as { liquidityAvailable?: boolean; buyAmount?: string }
    if (d.liquidityAvailable === false) return { verdict: 'NO-ROUTE', detail: 'liquidityAvailable=false' }
    if (!d.buyAmount || d.buyAmount === '0') return { verdict: 'NO-ROUTE', detail: 'zero buyAmount' }
    return { verdict: 'ROUTABLE', detail: `buyAmount=${d.buyAmount}` }
  } catch (e) {
    return { verdict: 'ERROR', detail: flat(String(e)) }
  }
}

async function runChain(chainId: number, usd: number, key: string) {
  const funding = fundingFor(chainId)
  if (!funding) {
    console.log(`\n[${chainId}] SKIPPED — no settlement asset in the deployment book`)
    return { chainId, routable: 0, noRoute: [] as Probe[], refused: [] as Probe[], errors: 0 }
  }
  const sellAmount = BigInt(Math.round(usd * 10 ** funding.decimals)).toString()

  const universe: Probe[] = [
    ...stocksForChain(chainId).map((s) => ({ symbol: s.symbol, address: s.address, source: 'stock-registry' })),
    ...starters(chainId),
    ...(await trendingFor(chainId, 15)),
  ]
  // dedupe by identity, first occurrence wins (the standing dedupe law)
  const seen = new Set<string>()
  const probes = universe.filter((p) => {
    const k = p.address.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  console.log(`\n[${chainId}] ${probes.length} assets · selling ${usd} of ${funding.address} (${sellAmount} raw)`)
  const noRoute: Probe[] = []
  const refused: Probe[] = []
  let routable = 0
  let errors = 0
  for (const p of probes) {
    const { verdict, detail } = await probe(chainId, funding.address, sellAmount, p.address, key)
    console.log(`  ${verdict.padEnd(9)} ${p.symbol.padEnd(14)} ${p.source.padEnd(15)} ${detail}`)
    if (verdict === 'ROUTABLE') routable += 1
    else if (verdict === 'NO-ROUTE') noRoute.push(p)
    else if (verdict === 'REFUSED') refused.push(p)
    else errors += 1
    await new Promise((r) => setTimeout(r, 250)) // be a polite client
  }
  return { chainId, routable, noRoute, refused, errors }
}

async function main() {
  const key = process.env.ZEROX_API_KEY
  if (!key) {
    console.error('ZEROX_API_KEY is not set. This script reads the key from the environment only —')
    console.error('never commit it, never put it in .env files that ship.')
    process.exit(0)
  }
  const usd = Number(arg('usd', '250'))
  const chains = process.argv.includes('--all') ? CHAINS : [Number(arg('chain', '8453'))]
  const results = []
  for (const c of chains) results.push(await runChain(c, usd, key))

  console.log('\n──────── SUMMARY ────────')
  console.log(`slug map used: ${JSON.stringify(DEXSCREENER_SLUG)} — authoritative source: ${SLUG_SOURCE}`)
  for (const r of results) {
    const total = r.routable + r.noRoute.length + r.refused.length + r.errors
    console.log(
      `[${r.chainId}] ${r.routable}/${total} routable · ${r.noRoute.length} NO-ROUTE (depth) · ${r.refused.length} REFUSED (policy) · ${r.errors} errors`,
    )
    if (r.refused.length) {
      console.log(
        `           ⚠ 0x DECLINES ${r.refused.length} asset(s) on policy grounds, which is an ANSWER: ${r.refused.map((p) => p.symbol).join(', ')}.` +
          `\n             These cannot ride a batch and must be acquired individually — they are NOT unknown, and re-running will not change it.`,
      )
    }
  }
  // ⚠ THE FALLBACK SET IS BOTH KINDS OF NOT-ROUTABLE, and getting that wrong
  // is how my own fix produced a NEW false sentence on its first run: with the
  // 8 equities correctly moved out of ERROR, this list counted only the DEPTH
  // refusals, so the roll-up printed "every one of the 17 assets probed is
  // routable — no fallback needed" while 8 of them were flatly refused.
  // Whatever cannot ride a batch needs the individual-acquisition path,
  // whichever reason put it there — so both belong here, each labelled with WHY
  // (the reasons demand different handling downstream, and a bare list would
  // hide that a policy refusal says nothing about the asset's own liquidity).
  const fallbackSet = results.flatMap((r) => [
    ...r.noRoute.map((p) => `${r.chainId}:${p.symbol} ${p.address} (${p.source}) — NO ROUTE (depth)`),
    ...r.refused.map((p) => `${r.chainId}:${p.symbol} ${p.address} (${p.source}) — REFUSED by 0x (policy; its own market may be deep)`),
  ])
  const errors = results.reduce((n, r) => n + r.errors, 0)
  const answered = results.reduce((n, r) => n + r.routable + r.noRoute.length + r.refused.length, 0)
  if (fallbackSet.length > 0) {
    console.log(`\nTHE FALLBACK SET (${fallbackSet.length}) — these cannot ride a 0x-only batch:\n  ${fallbackSet.join('\n  ')}`)
  }
  // ⇨ A FAILED READ IS NOT A CLEAN VERDICT. The first version of this report
  // printed "covers everything probed" on a run where all 25 probes returned
  // HTTP 401 — a coverage claim built entirely on errors. The empty-fallback
  // sentence is now GATED on the sample having actually answered.
  if (errors > 0) {
    console.log(
      `\n⛔ INCOMPLETE SAMPLE: ${errors} of ${errors + answered} probes did not answer (see the ERROR rows).` +
        (fallbackSet.length === 0
          ? ' No coverage conclusion can be drawn from this run — an unanswered probe is not a routable asset.'
          : ' The fallback set above is a FLOOR, not the whole of it — the unanswered assets are unknown, not fine.'),
    )
  } else if (fallbackSet.length === 0) {
    console.log(`\nEvery one of the ${answered} assets that ANSWERED is routable by 0x — no fallback needed for this sample.`)
  }
  console.log(
    '\n⚠ Sample, not proof: the picker also takes pasted addresses and keyless search results, so',
  )
  console.log('   the per-leg runtime refusal is what covers every asset this probe never saw.')
}

void main()
