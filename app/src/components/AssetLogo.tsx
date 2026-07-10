import { useEffect, useState } from 'react'
import { coingeckoLogoUrl, logoSources } from '../lib/spectrum/token-art'

// Token icon with a multi-source fallback chain (token-art.ts: DexScreener →
// TrustWallet → async Coingecko contract lookup) and an initials terminal state.
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
  const box = { width: size, height: size }
  const srcs = [...(preferredSrc ? [preferredSrc] : []), ...logoSources(address, chainId), ...(cgUrl ? [cgUrl] : [])]
  const src = srcs[srcIdx] as string | undefined
  const initials = (symbol || '?').replace(/^\$/, '').slice(0, 3).toUpperCase()
  const next = () => setSrcIdx((i) => i + 1)

  // Static rungs exhausted → one cached Coingecko contract lookup before initials.
  useEffect(() => {
    if (src != null || cgUrl !== undefined) return
    let stale = false
    void coingeckoLogoUrl(address, chainId).then((u) => {
      if (!stale) setCgUrl(u)
    })
    return () => {
      stale = true
    }
  }, [src, cgUrl, address, chainId])

  // Framed variant — used by the bento tiles. Padding makes the disc a visible
  // rim (most logos are opaque circles, so a plain bg behind them never shows).
  if (discColor) {
    const pad = Math.max(2, Math.round(size * 0.06))
    return (
      <span
        className="grid shrink-0 place-items-center rounded-full"
        style={{ ...box, padding: pad, backgroundColor: discColor, boxShadow: '0 2px 5px rgba(0,0,0,0.3)' }}
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

  // Default variant — a 1px white@10% containment outline (matches BasketAvatar),
  // no disc. A pure-white hairline catches the logo edge on the dark surface; a
  // tinted/black ring would read as a dirty rim.
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
  return (
    <img
      src={src}
      alt={symbol}
      onError={next}
      className="shrink-0 rounded-full bg-white/5 object-cover ring-1 ring-white/10"
      style={box}
    />
  )
}
