// Small shared pieces of the popup's visual language. The asset mark keeps the
// site's identity rules: real logo art where a registry covers the chain, and
// the DETERMINISTIC address-derived color (lib token-meta) behind monograms —
// so a basket looks like itself in both places.

import { useEffect, useState } from 'react'
import { blockscoutIconUrl, coingeckoLogoUrl, logoSources } from '@app/lib/spectrum/token-art'
import { tokenVisual } from '@app/lib/spectrum/token-meta'

export function MicroLabel({ children, tone = 'faint' }: { children: React.ReactNode; tone?: 'faint' | 'dim' }) {
  return (
    <span
      className={`font-mono text-[10px] uppercase tracking-[0.18em] ${tone === 'faint' ? 'text-ink-faint' : 'text-ink-dim'}`}
    >
      {children}
    </span>
  )
}

/** Section head: micro-label · hairline rule running to the right edge (the
 *  site's section idiom) · optional right-aligned controls. */
export function SectionRule({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-3">
      <MicroLabel>{children}</MicroLabel>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-line" />
      {right}
    </div>
  )
}

export function AssetMark({
  address,
  symbol,
  chainId,
  size = 20,
}: {
  address: string
  symbol: string
  chainId: number
  size?: number
}) {
  const [idx, setIdx] = useState(0)
  const [asyncUrl, setAsyncUrl] = useState<string | null | undefined>(undefined)
  const vis = tokenVisual(symbol, address)

  const srcs = [...logoSources(address, chainId), ...(asyncUrl ? [asyncUrl] : [])]
  const src = srcs[idx] as string | undefined
  const initials = (symbol || '?').replace(/^\$/, '').slice(0, 2).toUpperCase()

  useEffect(() => {
    setIdx(0)
    setAsyncUrl(undefined)
  }, [address, chainId])

  // Static rungs exhausted → the async registries (Blockscout covers 4663,
  // Coingecko the rest); a miss settles into the deterministic monogram.
  useEffect(() => {
    if (src != null || asyncUrl !== undefined) return
    let stale = false
    void blockscoutIconUrl(address, chainId)
      .then((bs) => bs ?? coingeckoLogoUrl(address, chainId))
      .then((u) => {
        if (!stale) setAsyncUrl(u)
      })
    return () => {
      stale = true
    }
  }, [src, asyncUrl, address, chainId])

  if (src) {
    return (
      <img
        src={src}
        alt={symbol}
        onError={() => setIdx((i) => i + 1)}
        className="img-outline shrink-0 rounded-full bg-white/5 object-cover"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      aria-hidden
      className="img-outline grid shrink-0 place-items-center rounded-full font-display font-semibold"
      style={{
        width: size,
        height: size,
        background: `color-mix(in srgb, ${vis.color} 55%, #000)`,
        color: vis.ink,
        fontSize: Math.max(7, Math.round(size * 0.34)),
      }}
    >
      {initials}
    </span>
  )
}

/** Chain name as a quiet label on a row — never a filter, never an organising
 *  principle ("it's about the assets you want access to"). */
const CHAIN_LABEL: Record<number, string> = { 1: 'ethereum', 8453: 'base', 4663: 'robinhood' }
export function chainLabel(chainId: number): string {
  return CHAIN_LABEL[chainId] ?? `chain ${chainId}`
}

export function SpinnerArc({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" style={{ width: size, height: size }} className="spin-arc text-cyan" aria-label="refreshing">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.5" />
      <path d="M8 1.5 A 6.5 6.5 0 0 1 14.5 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** Signed, tone-colored figure (24h change, drift deltas). Teal up / alert
 *  down — the site's changeAccent mapping. */
export function SignedFigure({ value, suffix, dp = 1 }: { value: number; suffix: string; dp?: number }) {
  const tone = value >= 0 ? 'text-teal' : 'text-alert'
  return (
    <span className={`tnum ${tone}`}>
      {value > 0 ? '+' : ''}
      {value.toFixed(dp)}
      {suffix}
    </span>
  )
}
