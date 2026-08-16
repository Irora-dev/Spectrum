import { useEffect, useState } from 'react'
import { deploymentFor } from '../lib/chain/deployments'
import { blockscoutIconUrl, coingeckoLogoUrl, logoSources } from '../lib/spectrum/token-art'
import { stockLogoUrl } from '../lib/spectrum/token-meta'

// Token icon with a multi-source fallback chain (token-art.ts: DexScreener →
// TrustWallet → async Coingecko contract lookup) and an initials terminal state.
/** The native-ETH sentinel the holdings reader keys native rows on (0xeee…)
 *  plus the zero address — neither exists on any explorer or logo registry. */
function isNativeSentinel(addr: string): boolean {
  const a = (addr || '').toLowerCase()
  return a === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || a === '0x0000000000000000000000000000000000000000'
}

/** The chain's wrapped-native address, or null — a failed config read means
 *  the ladder simply runs on the sentinel and falls to initials, as before. */
function wethAddressFor(chainId: number): string | null {
  try {
    return deploymentFor(chainId).weth ?? null
  } catch {
    return null
  }
}

export function AssetLogo({
  address,
  symbol,
  chainId,
  size = 26,
  discColor,
  preferredSrc,
}: {
  address: string
  symbol: string
  chainId: number
  size?: number
  // When set (bento tiles pass a darkened tile color), the logo is inset inside a
  // disc of this color so the rim shows around it — a softer, on-brand frame in
  // place of the hard black ring — lifted by a subtle drop shadow.
  discColor?: string
  // A caller-known logo URL tried BEFORE the ladder (e.g. the verified token
  // list's logoURI in search rows) — the ladder still backs it up on failure.
  preferredSrc?: string
}) {
  const [srcIdx, setSrcIdx] = useState(0)
  // undefined = not looked up yet · null = looked up, no logo · string = the URL
  const [cgUrl, setCgUrl] = useState<string | null | undefined>(undefined)
  const [tries, setTries] = useState(0)
  const box = { width: size, height: size }
  // A TOKENISED STOCK LEADS WITH ITS COMPANY'S MARK (the owner 2026-08-06: "it just
  // shows robinhood logo for the stocks"). Robinhood's CDN serves the same
  // feather for every one of them — verified by fetching NVDA, AAPL and TSLA,
  // all byte-identical — so the address-keyed rungs below can never produce a
  // company logo. This rung is registry-gated and returns null for everything
  // else, so on failure the ladder is exactly what it always was.
  const stockSrc = stockLogoUrl(symbol)
  // NATIVE ETH wears the chain's WETH mark (the owner, live 13:19: "the ETH logo
  // doesn't appear — it should appear definitely"). The book keys native rows
  // on a sentinel, and every address-keyed rung below answers nothing for a
  // sentinel — so resolve it to the chain's wrapped-native address FIRST and
  // let the same ladder do its normal work.
  const effAddress = isNativeSentinel(address) ? wethAddressFor(chainId) ?? address : address
  const srcs = [
    ...(preferredSrc ? [preferredSrc] : []),
    ...(stockSrc ? [stockSrc] : []),
    ...logoSources(effAddress, chainId),
    ...(cgUrl ? [cgUrl] : []),
  ]
  const src = srcs[srcIdx] as string | undefined
  const initials = (symbol || '?').replace(/^\$/, '').slice(0, 3).toUpperCase()
  const next = () => setSrcIdx((i) => i + 1)

  // A recycled component (same element, new token) must restart the ladder —
  // and must not keep the previous token's latched lookup state.
  useEffect(() => {
    setSrcIdx(0)
    setCgUrl(undefined)
    setTries(0)
  }, [address, chainId])

  // Static rungs exhausted → async lookups before initials: Blockscout's token
  // icon on Robinhood Chain (the only registry that covers it), else Coingecko.
  // A null result may be TRANSIENT (the producers un-cache 429/network blips) —
  // latching it in state defeated their retry-on-next-ask design for the whole
  // mounted lifetime (verify pass). Bounded backoff instead: definitive misses
  // are memoized upstream, so those retries cost zero network.
  useEffect(() => {
    if (src != null || cgUrl !== undefined) return
    let stale = false
    let timer: number | undefined
    void blockscoutIconUrl(effAddress, chainId)
      .then((bs) => bs ?? coingeckoLogoUrl(effAddress, chainId))
      .then((u) => {
        if (stale) return
        if (u == null && tries < 2) {
          timer = window.setTimeout(() => setTries((t) => t + 1), 4000 * (tries + 1))
          return
        }
        setCgUrl(u)
      })
    return () => {
      stale = true
      if (timer != null) window.clearTimeout(timer)
    }
  }, [src, cgUrl, address, chainId, tries])

  // Framed variant — used by the bento tiles. Padding makes the disc a visible
  // rim (most logos are opaque circles, so a plain bg behind them never shows).
  if (discColor) {
    const pad = Math.max(2, Math.round(size * 0.06))
    // A COMPANY MARK NEEDS A LIGHT DISC. The disc normally tints from the tile
    // so the rim reads as part of it — but now that tiles carry the BRAND
    // colour and stocks carry the BRAND mark, those are the same hue by
    // definition, and Tesla's red T on a Tesla-red disc disappeared (my own
    // regression, same session). Company favicons are drawn for light
    // backgrounds, so stock marks get one; every other token keeps the tinted
    // rim exactly as before.
    const disc = src === stockSrc ? '#F4F0F4' : discColor
    return (
      <span
        className="grid shrink-0 place-items-center rounded-full"
        style={{ ...box, padding: pad, backgroundColor: disc, boxShadow: '0 2px 5px rgba(0,0,0,0.3)' }}
      >
        {src ? (
          <img src={src} alt={symbol} onError={next} className="h-full w-full rounded-full object-cover" />
        ) : (
          <span
            className="font-semibold leading-none text-white/90"
            style={{ fontSize: Math.max(6, Math.round(size * 0.26)) }}
          >
            {initials}
          </span>
        )}
      </span>
    )
  }

  // Default variant — a 1px white@10% containment outline (matches BasketAvatar).
  if (!src) {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-full bg-white/10 font-semibold text-ink-dim ring-1 ring-white/10"
        style={{ ...box, fontSize: Math.max(7, Math.round(size * 0.3)) }}
      >
        {initials}
      </span>
    )
  }
  // A REAL DISC BEHIND THE MARK, not bg-white/5 (owner 2026-08-07: "the stock
  // logos look broken, they have no bg / cutout").
  //
  // The old background was 5% white — invisible on a near-black card — and the
  // comment that used to sit above stated the assumption which made that fine:
  // "most logos are opaque circles, so a plain bg behind them never shows".
  // True of crypto tokens, FALSE of the company marks that came with the
  // tokenised stocks: NVIDIA's eye, Tesla's T and USDG's G are transparent
  // brand art, so the page showed straight through them and the hairline ring
  // drew a circle around nothing.
  //
  // The remedy is the treatment this component already proves one element away:
  // the bento tiles frame these very same logos on a disc, which is why on a
  // basket page the tiles read as finished while the table beneath them read as
  // broken. An opaque logo covers the disc completely, so this costs those
  // nothing — and a transparent one finally has something to sit on.
  return (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-full bg-white ring-1 ring-white/10"
      style={{ ...box, padding: Math.max(1, Math.round(size * 0.04)) }}
    >
      <img src={src} alt={symbol} onError={next} className="h-full w-full rounded-full object-cover" />
    </span>
  )
}
