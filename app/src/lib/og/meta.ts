// Pure helpers for per-URL OpenGraph/Twitter meta, shared by the Netlify edge
// middleware (../../netlify/edge-functions/og.ts) and its unit test. Social
// crawlers don't run JS, so an SPA can only ever show them the ONE generic card
// baked into index.html; the edge function rewrites those tags per shared URL.
//
// Pure string ops — NO Netlify/Deno/DOM APIs — so this is unit-tested in the
// app's vitest even though the edge function runs on Deno at the edge.
//
// Card COPY carries no numbers (§9): crawlers cache previews for days and a stale
// NAV/perf figure would mislead. og:image points at the branded generic card for
// now; per-basket card IMAGES are a follow-up (see netlify/edge-functions/README).

export interface OgMeta {
  title: string
  description: string
  image: string
  url: string
  imageAlt: string
}

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

/** Swap the content="" of a `<meta property|name="key" content="…">` tag, matching
 *  index.html's exact attribute order (key then content). */
function setContent(html: string, keyAttr: string, value: string): string {
  const re = new RegExp(`(<meta\\s+${keyAttr}\\s+content=")[^"]*(")`, 'i')
  return html.replace(re, `$1${escAttr(value)}$2`)
}

/** Rewrite the static index.html's <title> + og/twitter tags for one URL. Any tag
 *  not present is left untouched (the replace simply no-ops). */
export function rewriteOgHtml(html: string, m: OgMeta): string {
  let out = html.replace(/<title>[^<]*<\/title>/i, `<title>${escText(m.title)}</title>`)
  out = setContent(out, 'name="description"', m.description)
  out = setContent(out, 'property="og:title"', m.title)
  out = setContent(out, 'property="og:description"', m.description)
  out = setContent(out, 'property="og:url"', m.url)
  out = setContent(out, 'property="og:image"', m.image)
  out = setContent(out, 'property="og:image:alt"', m.imageAlt)
  out = setContent(out, 'name="twitter:title"', m.title)
  out = setContent(out, 'name="twitter:description"', m.description)
  out = setContent(out, 'name="twitter:image"', m.image)
  return out
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

// og:image = the branded generic card (absolute). Swap for `${origin}/og/${chain}/
// ${addr}.png` once per-basket card rendering is wired (the image follow-up).
export function basketMeta(t: { symbol: string; name: string }, chain: number, addr: string, origin: string): OgMeta {
  return {
    title: `$${t.symbol} · ${t.name} · Spectrum`,
    description: `${t.name}, an onchain basket token on Spectrum. One token, a whole basket of assets.`,
    image: `${origin}/og.png`,
    url: `${origin}/token?addr=${addr}&chain=${chain}`,
    imageAlt: `${t.name} on Spectrum`,
  }
}

export function creatorMeta(addr: string, origin: string): OgMeta {
  const s = short(addr)
  return {
    title: `${s} · Spectrum creator`,
    description: `Onchain basket tokens created by ${s} on Spectrum. One token, a whole basket of assets.`,
    image: `${origin}/og.png`,
    url: `${origin}/creator/${addr}`,
    imageAlt: `${s}, a creator on Spectrum`,
  }
}

export function referMeta(origin: string): OgMeta {
  return {
    title: 'Refer & earn · Spectrum',
    description: 'Share Spectrum and earn a slice of the protocol fee, onchain in USDC, on every trade and launch through your link. No signup.',
    image: `${origin}/og.png`,
    url: `${origin}/refer`,
    imageAlt: 'Refer & earn on Spectrum',
  }
}
