// ─────────────────────────────────────────────────────────────────────────────
// Spectrum OG worker (adoption toolkit 2026-07-06 #4) — deploy IN FRONT of the
// static site so shared links unfurl first-class. Social crawlers don't run JS,
// so rewriting the origin index.html's og/twitter tags per URL is the only way
// an SPA gets per-URL previews.
//
//   • GET /token?addr=&chain=       → index.html with og tags rewritten per basket
//   • GET /creator/<address>        → …rewritten for that creator's profile
//   • GET /refer                    → …rewritten for the refer-&-earn page
//   • GET /og/:chainId/:address.png → 1200×630 basket card (satori → resvg)
//   • GET /og/creator/:address.png  → creator identity card
//   • GET /og/refer.png             → refer-&-earn card
//   • everything else               → passed through to the origin untouched
//
// All cards carry NO numbers (NAV/perf/TVL): crawlers cache images for days, and
// a stale performance figure in a social card is exactly the misleading-claim
// class §9 exists to prevent. Basket names come from the site's /tokenlist.json
// (built by `npm run build:tokenlist`); creator/refer cards need no data lookup.
//
// Config (wrangler.toml [vars]): SITE_ORIGIN — the deployed site's URL.
// ─────────────────────────────────────────────────────────────────────────────
import satori from 'satori'
import { Resvg, initWasm } from '@resvg/resvg-wasm'
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'
import fontRegular from '../fonts/ChakraPetch-Regular.ttf'
import fontBold from '../fonts/ChakraPetch-Bold.ttf'
import { buildCard, buildCreatorCard, buildReferCard } from './card.mjs'

let wasmReady = null
const ensureWasm = () => (wasmReady ??= initWasm(resvgWasm))

const CACHE_HEADERS = { 'cache-control': 'public, max-age=300, s-maxage=3600' }

async function tokenFor(env, chainId, address) {
  const res = await fetch(`${env.SITE_ORIGIN}/tokenlist.json`, { cf: { cacheTtl: 300 } })
  if (!res.ok) return null
  const list = await res.json()
  return (
    (list.tokens ?? []).find(
      (t) => t.chainId === chainId && t.address.toLowerCase() === address.toLowerCase(),
    ) ?? null
  )
}

/** A satori element tree → 1200×630 PNG Response (shared by every card). */
async function toPng(element) {
  await ensureWasm()
  const svg = await satori(element, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Chakra Petch', data: fontRegular, weight: 400, style: 'normal' },
      { name: 'Chakra Petch', data: fontBold, weight: 700, style: 'normal' },
    ],
  })
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng()
  return new Response(png, { headers: { 'content-type': 'image/png', ...CACHE_HEADERS } })
}

/** Basket card — null when the address isn't a known basket (caller 302s to the
 *  generic site card). */
async function renderCard(env, chainId, address) {
  const token = await tokenFor(env, chainId, address)
  if (!token) return null
  return toPng(buildCard({ symbol: token.symbol, name: token.name, address }))
}

/** Escape a string for safe use inside an HTML attribute. */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** Fetch the origin index.html and rewrite its <title> + og/twitter meta. */
async function rewriteMeta(env, { title, desc, image, pageUrl, imageAlt }) {
  const origin = await fetch(`${env.SITE_ORIGIN}/`, { headers: { accept: 'text/html' } })
  if (!origin.ok) return origin
  const content = {
    'og:title': title,
    'og:description': desc,
    'og:image': image,
    'og:url': pageUrl,
    'og:image:alt': imageAlt,
    'twitter:title': title,
    'twitter:description': desc,
    'twitter:image': image,
  }
  let rewriter = new HTMLRewriter().on('title', {
    element(el) {
      el.setInnerContent(title)
    },
  })
  for (const [key, value] of Object.entries(content)) {
    rewriter = rewriter.on(`meta[property="${key}"], meta[name="${key}"]`, {
      element(el) {
        el.setAttribute('content', esc(value))
      },
    })
  }
  return rewriter.transform(new Response(origin.body, origin))
}

async function rewriteTokenPage(env, url) {
  const addr = url.searchParams.get('addr')
  const chain = Number(url.searchParams.get('chain')) || 8453
  const token = addr ? await tokenFor(env, chain, addr) : null
  // Unknown basket → serve the origin untouched (generic site card).
  if (!token) return fetch(`${env.SITE_ORIGIN}/`, { headers: { accept: 'text/html' } })
  const title = `$${token.symbol} · ${token.name} · Spectrum`
  return rewriteMeta(env, {
    title,
    desc: `${token.name}, an onchain basket token on Spectrum. One token, a whole basket of assets.`,
    image: `${url.origin}/og/${chain}/${addr}.png`,
    pageUrl: `${url.origin}/token?addr=${addr}&chain=${chain}`,
    imageAlt: `${token.name} on Spectrum`,
  })
}

async function rewriteCreatorPage(env, url, address) {
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`
  return rewriteMeta(env, {
    title: `${short} · Spectrum creator`,
    desc: `Onchain basket tokens created by ${short} on Spectrum. One token, a whole basket of assets.`,
    image: `${url.origin}/og/creator/${address}.png`,
    pageUrl: `${url.origin}/creator/${address}`,
    imageAlt: `${short}, a creator on Spectrum`,
  })
}

async function rewriteReferPage(env, url) {
  return rewriteMeta(env, {
    title: 'Refer & earn · Spectrum',
    desc: 'Share Spectrum and earn a slice of the protocol fee, onchain in USDC, on every trade and launch through your link. No signup.',
    image: `${url.origin}/og/refer.png`,
    pageUrl: `${url.origin}/refer`,
    imageAlt: 'Refer & earn on Spectrum',
  })
}

/** Serve a card PNG through the edge cache. `render` returns a Response or null
 *  (null → 302 to the generic site card). */
async function cachedCard(request, env, render) {
  const cached = await caches.default.match(request)
  if (cached) return cached
  const res = (await render()) ?? Response.redirect(`${env.SITE_ORIGIN}/og.png`, 302)
  if (res.status === 200) await caches.default.put(request, res.clone())
  return res
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const { pathname } = url

    // ── image cards (cached at the edge) ──
    const ogBasket = pathname.match(/^\/og\/(\d+)\/(0x[0-9a-fA-F]{40})\.png$/)
    if (ogBasket) return cachedCard(request, env, () => renderCard(env, Number(ogBasket[1]), ogBasket[2]))

    const ogCreator = pathname.match(/^\/og\/creator\/(0x[0-9a-fA-F]{40})\.png$/)
    if (ogCreator) return cachedCard(request, env, () => toPng(buildCreatorCard({ address: ogCreator[1] })))

    if (pathname === '/og/refer.png') return cachedCard(request, env, () => toPng(buildReferCard()))

    // ── per-URL meta rewrites (crawlers don't run JS) ──
    if (pathname === '/token' && url.searchParams.has('addr')) return rewriteTokenPage(env, url)

    const creatorPath = pathname.match(/^\/creator\/(0x[0-9a-fA-F]{40})$/)
    if (creatorPath) return rewriteCreatorPage(env, url, creatorPath[1])

    if (pathname === '/refer') return rewriteReferPage(env, url)

    // everything else: straight through to the origin
    return fetch(new Request(`${env.SITE_ORIGIN}${url.pathname}${url.search}`, request))
  },
}
