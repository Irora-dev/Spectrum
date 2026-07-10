import { useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { BasketBento, type BentoItem } from './BasketBento'
import { squarify } from '../lib/treemap'
import type { Holding, NavPoint } from '../lib/spectrum/basket-data'
import { useNavHistory } from '../lib/spectrum/hooks'
import { computeReturns } from '../lib/spectrum/history'
import { tokenVisual } from '../lib/spectrum/token-meta'
import { formatNav, formatPct, shortAddr } from '../lib/spectrum/format'

// Celebratory, shareable launch card shown on the basket page right after a deploy
// (?deployed=1). Mini bento + a one-click "Share on X" (prefilled) and "Copy link".
// The same card is available to EVERYONE as ShareModal (the Token page's Share
// button) — holders share a basket with the identical surface deployers get,
// just with neutral copy ("Check out…" instead of "I launched…").
// Note: keep the share text neutral, no performance claims.

/** Prefilled X-intent + copy-link pair — the one share action set, both hosts. */
function ShareActions({
  xHref,
  shareUrl,
  sig,
  buyInk,
  subtle = false,
}: {
  xHref: string
  shareUrl: string
  sig: string
  buyInk: string
  /** Render the X button as an outline secondary (when another primary CTA leads). */
  subtle?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="flex flex-wrap gap-2.5">
      <a
        href={xHref}
        target="_blank"
        rel="noreferrer"
        className={
          subtle
            ? 'press inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-4 py-2.5 font-mono text-xs uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan'
            : 'inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 font-display text-sm font-bold uppercase tracking-wide transition-transform hover:scale-[1.02] active:scale-[0.96]'
        }
        style={subtle ? undefined : { background: sig, color: buyInk }}
      >
        Share on X
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 17L17 7M7 7h10v10" />
        </svg>
      </a>
      <button
        type="button"
        onClick={copy}
        className="press rounded-lg border border-white/15 px-4 py-2.5 font-mono text-xs uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan"
      >
        {copied ? 'Link copied' : 'Copy link'}
      </button>
    </div>
  )
}

// ── the share image (1200×630) ────────────────────────────────────────────────
// Drawn entirely on a canvas from data already on hand: name/ticker, price,
// return since creation, and the composition as a REAL bento grid (the same
// squarified-treemap layout the page renders, tiled in tokenVisual colors —
// no remote images, so rendering never trips CORS). The modal PREVIEWS this
// exact canvas; download/copy export it byte-for-byte.
function drawShareImage(
  canvas: HTMLCanvasElement,
  o: {
    symbol: string
    name: string
    addr: string
    sig: string
    priceUsd: number
    sincePct: number | null
    holdings: Holding[]
  },
): void {
  const W = 1200
  const H = 630
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const DISPLAY = '"Space Grotesk", "Inter", system-ui, sans-serif'
  const MONO = '"JetBrains Mono", ui-monospace, monospace'

  // surface + on-palette glow (screen-ish, mimicking the hero warp)
  ctx.fillStyle = '#0c0a14'
  ctx.fillRect(0, 0, W, H)
  const palette = [o.sig, ...o.holdings.slice(0, 3).map((h) => tokenVisual(h.symbol, h.asset).color)]
  ctx.globalCompositeOperation = 'lighter'
  const blobs: [number, number, number, number][] = [
    [W * 0.78, 90, 480, 0.35],
    [W * 0.15, H * 0.35, 380, 0.25],
    [W * 0.5, 60, 320, 0.2],
  ]
  blobs.forEach(([x, y, r, a], i) => {
    const c = palette[i % palette.length]
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, `${c}${Math.round(a * 255).toString(16).padStart(2, '0')}`)
    g.addColorStop(1, `${c}00`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
  })
  ctx.globalCompositeOperation = 'source-over'

  // top accent bar
  const bar = ctx.createLinearGradient(0, 0, W, 0)
  palette.forEach((c, i) => bar.addColorStop(palette.length === 1 ? 0 : i / (palette.length - 1), c))
  ctx.fillStyle = bar
  ctx.fillRect(0, 0, W, 10)

  // ticker pill
  ctx.font = `700 26px ${MONO}`
  const tick = `$${o.symbol}`
  const tw = ctx.measureText(tick).width
  ctx.fillStyle = 'rgba(255,255,255,0.1)'
  ctx.beginPath()
  ctx.roundRect(64, 56, tw + 40, 48, 24)
  ctx.fill()
  ctx.fillStyle = '#35e0ff'
  ctx.textBaseline = 'middle'
  ctx.fillText(tick, 84, 82)

  // name
  ctx.fillStyle = '#f4f0f4'
  ctx.font = `700 64px ${DISPLAY}`
  ctx.fillText(o.name.toUpperCase().slice(0, 24), 64, 168)

  // price (right-aligned)
  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(244,240,244,0.6)'
  ctx.font = `600 20px ${MONO}`
  ctx.fillText('PRICE', W - 64, 70)
  ctx.fillStyle = '#f4f0f4'
  ctx.font = `300 84px ${DISPLAY}`
  ctx.fillText(`$${formatNav(o.priceUsd)}`, W - 64, 148)
  ctx.textAlign = 'left'

  // return since creation chip
  if (o.sincePct != null) {
    const up = o.sincePct >= 0
    const col = up ? '#35e0ff' : '#ff4db8'
    const label = `${formatPct(o.sincePct)} since creation`
    ctx.font = `700 24px ${MONO}`
    const lw = ctx.measureText(label).width
    ctx.fillStyle = `${col}2b`
    ctx.beginPath()
    ctx.roundRect(64, 208, lw + 44, 50, 25)
    ctx.fill()
    ctx.fillStyle = col
    ctx.fillText(label, 86, 235)
  }

  // ── the bento: the page's squarified layout, tiled in brand colors ─────────
  const band = { x: 64, y: 296, w: W - 128, h: 268 }
  const remaining = [...o.holdings]
  const rects = squarify(
    o.holdings.map((h) => ({ ticker: h.symbol, weight: Math.max(h.targetWeightPct, 0.0001) })),
    band.w,
    band.h,
  )
  for (const r of rects) {
    const hi = remaining.findIndex((h) => h.symbol === r.ticker)
    const h = hi >= 0 ? remaining.splice(hi, 1)[0] : undefined
    if (!h) continue
    const vis = tokenVisual(h.symbol, h.asset)
    const pad = 4
    const tx = band.x + r.x + pad
    const ty = band.y + r.y + pad
    const tw2 = r.w - pad * 2
    const th = r.h - pad * 2
    if (tw2 <= 4 || th <= 4) continue
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(tx, ty, tw2, th, 14)
    ctx.clip()
    ctx.fillStyle = vis.color
    ctx.fillRect(tx, ty, tw2, th)
    // the DOM tiles' sheen: light top, shaded bottom
    const sheen = ctx.createLinearGradient(0, ty, 0, ty + th)
    sheen.addColorStop(0, 'rgba(255,255,255,0.16)')
    sheen.addColorStop(0.4, 'rgba(255,255,255,0)')
    sheen.addColorStop(1, 'rgba(0,0,0,0.2)')
    ctx.fillStyle = sheen
    ctx.fillRect(tx, ty, tw2, th)
    // symbol chip (white pill, black text) + weight. The % ALWAYS renders
    // (owner rule): beside the chip when the row fits, below it when the tile
    // is narrow, and alone when even the chip can't fit.
    const sym = h.symbol.replace(/^\$/, '').toUpperCase()
    const pct = `${Math.round(h.targetWeightPct)}%`
    const chipFont = tw2 > 120 ? 20 : 15
    ctx.font = `700 ${chipFont}px ${DISPLAY}`
    const sw = ctx.measureText(sym).width
    const chipW = sw + 20
    const chipFits = tw2 >= chipW + 20 && th >= 48
    if (chipFits) {
      ctx.fillStyle = 'rgba(255,255,255,0.92)'
      ctx.beginPath()
      ctx.roundRect(tx + 10, ty + 10, chipW, 30, 8)
      ctx.fill()
      ctx.fillStyle = '#0b0b12'
      ctx.fillText(sym, tx + 20, ty + 26)
    }
    const pctFont = tw2 > 120 ? 22 : 16
    ctx.font = `700 ${pctFont}px ${DISPLAY}`
    ctx.fillStyle = vis.ink
    const pctW = ctx.measureText(pct).width
    if (chipFits && tw2 >= chipW + pctW + 44) {
      // side by side on the top row
      ctx.textAlign = 'right'
      ctx.fillText(pct, tx + tw2 - 12, ty + 26)
      ctx.textAlign = 'left'
    } else if (chipFits && th >= 84) {
      // stacked under the chip
      ctx.fillText(pct, tx + 12, ty + 60)
    } else {
      // tiny tile: the % is the one fact that must survive
      ctx.textAlign = 'center'
      ctx.fillText(pct, tx + tw2 / 2, ty + th / 2)
      ctx.textAlign = 'left'
    }
    ctx.restore()
  }

  // footer
  ctx.fillStyle = 'rgba(244,240,244,0.45)'
  ctx.font = `600 20px ${MONO}`
  ctx.fillText('SPECTRUM · ONCHAIN BASKETS', 64, H - 34)
  ctx.textAlign = 'right'
  ctx.fillText(shortAddr(o.addr), W - 64, H - 34)
  ctx.textAlign = 'left'
}

/** Share popup for ANY viewer (Token page's Share button): the launch card's
 *  surface — sig-tinted panel, mini bento, X intent + copy + a downloadable
 *  share image (price + performance since creation) — with neutral copy. */
export function ShareModal({
  open,
  onClose,
  symbol,
  name,
  addr,
  chainId,
  sig,
  buyInk,
  holdings,
  navPerToken,
  ageHours,
  navSeries,
}: {
  open: boolean
  onClose: () => void
  symbol: string
  name: string
  addr: string
  chainId: number
  sig: string
  buyInk: string
  holdings: Holding[]
  navPerToken: number
  ageHours: number | null
  navSeries: NavPoint[]
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Return since creation, mirroring BasketStats exactly (same query key →
  // same cached history → the image never disagrees with the page).
  const DAY = 86400
  const ageSec = ageHours != null ? ageHours * 3600 : null
  const { data: hist } = useNavHistory({
    chainId,
    assets: holdings.map((h) => ({ address: h.asset, weight: h.liveWeightPct > 0 ? h.liveWeightPct : h.targetWeightPct })),
    navPerToken,
    ageSec,
    range: ageSec != null && ageSec <= 30 * DAY ? 'ALL' : '30D',
  })
  const returns = computeReturns(hist.length >= 2 ? hist : navSeries, ageSec)
  const sincePct = returns.find((r) => r.range === 'ALL')?.pct ?? null

  // The preview canvas IS the exported image: drawn once the modal opens
  // (fonts settled first), then download/copy read the same pixels back.
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [copiedImg, setCopiedImg] = useState(false)
  const [copiedEmbed, setCopiedEmbed] = useState(false)
  useEffect(() => {
    if (!open) return
    let stale = false
    void (async () => {
      try {
        await document.fonts?.ready
      } catch {
        /* draw with fallback fonts */
      }
      if (stale || !canvasRef.current) return
      drawShareImage(canvasRef.current, { symbol, name, addr, sig, priceUsd: navPerToken, sincePct, holdings })
    })()
    return () => {
      stale = true
    }
  }, [open, symbol, name, addr, sig, navPerToken, sincePct, holdings])

  if (!open) return null

  // Share & earn (owner 2026-07-07): a connected sharer's link carries their ?ref,
  // so sharing a basket you like earns you the interface slice on buys through it.
  const { address: viewer } = useAccount()
  const shareUrl = `${window.location.origin}/token?addr=${addr}&chain=${chainId}${viewer ? `&ref=${viewer}` : ''}`
  const text = `$${symbol}, ${name}: ${holdings.length} assets in one onchain basket token.`
  const xHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`
  // the iframe-able card (pages/Embed.tsx) — creators paste this on their own sites
  const embedCode = `<iframe src="${window.location.origin}/embed?addr=${addr}&chain=${chainId}${viewer ? `&ref=${viewer}` : ''}" width="420" height="560" style="border:0;border-radius:16px" title="$${symbol} on Spectrum"></iframe>`
  const copyEmbed = async () => {
    try {
      await navigator.clipboard.writeText(embedCode)
      setCopiedEmbed(true)
      window.setTimeout(() => setCopiedEmbed(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }

  const canvasBlob = () =>
    new Promise<Blob | null>((res) => {
      if (!canvasRef.current) return res(null)
      canvasRef.current.toBlob(res, 'image/png')
    })

  const downloadImage = async () => {
    const blob = await canvasBlob()
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${symbol}-spectrum.png`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  const copyImage = async () => {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': canvasBlob().then((b) => b ?? new Blob([], { type: 'image/png' })) }),
      ])
      setCopiedImg(true)
      window.setTimeout(() => setCopiedImg(false), 1600)
    } catch {
      /* clipboard images unsupported — download remains */
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-void/85 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Share $${symbol}`}
        onClick={(e) => e.stopPropagation()}
        className="search-pop relative w-full max-w-2xl overflow-hidden rounded-2xl border p-6 sm:p-8"
        style={{ borderColor: `${sig}55`, background: `linear-gradient(135deg, ${sig}1f, #0c0a14 55%)` }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute -top-24 left-1/2 h-44 w-[130%] -translate-x-1/2 opacity-25 blur-3xl"
          style={{ background: sig }}
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="press absolute right-2 top-2 z-10 grid h-9 w-9 place-items-center rounded-full text-ink-dim hover:bg-white/10 hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <div className="relative">
          <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-ink [text-shadow:0_1px_10px_rgba(0,0,0,0.7)]">
            Share this basket
          </div>
          <h2 className="mt-2 font-display text-3xl font-bold uppercase leading-tight tracking-tight text-ink [text-shadow:0_1px_10px_rgba(0,0,0,0.7)]">
            ${symbol}
          </h2>
          <p className="mt-1 max-w-lg text-sm leading-relaxed text-ink [text-shadow:0_1px_8px_rgba(0,0,0,0.6)]">
            {name} · {holdings.length} assets in one onchain basket token.
          </p>
          {/* WYSIWYG: this canvas IS the image download/copy exports */}
          <canvas
            ref={canvasRef}
            className="mt-5 w-full rounded-xl border border-white/10 shadow-[0_18px_50px_-20px_rgba(0,0,0,0.8)]"
            style={{ aspectRatio: '1200 / 630' }}
          />
          <div className="mt-6 flex flex-wrap items-center gap-2.5">
            <ShareActions xHref={xHref} shareUrl={shareUrl} sig={sig} buyInk={buyInk} />
            <button
              type="button"
              onClick={() => void copyImage()}
              className="press inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-4 py-2.5 font-mono text-xs uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15V5a2 2 0 012-2h8" />
              </svg>
              {copiedImg ? 'Image copied' : 'Copy image'}
            </button>
            <button
              type="button"
              onClick={() => void downloadImage()}
              className="press inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-4 py-2.5 font-mono text-xs uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <path d="M7 10l5 5 5-5" />
                <path d="M12 15V3" />
              </svg>
              Download image
            </button>
            <button
              type="button"
              onClick={() => void copyEmbed()}
              className="press inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-4 py-2.5 font-mono text-xs uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 18l6-6-6-6" />
                <path d="M8 6l-6 6 6 6" />
              </svg>
              {copiedEmbed ? 'Embed copied' : 'Copy embed'}
            </button>
          </div>
          {viewer && (
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-teal">
              Your link earns you ~5% of the fee on buys through it · <a href="/refer" className="underline underline-offset-2 hover:text-cyan">refer &amp; earn</a>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
export function LaunchBanner({
  symbol,
  name,
  addr,
  chainId,
  sig,
  buyInk,
  holdings,
  onShare,
}: {
  symbol: string
  name: string
  addr: string
  chainId: number
  sig: string
  buyInk: string
  holdings: Holding[]
  /** Open the full share-card modal (the drawn image) — the launch moment's
   *  primary action when provided (owner 2026-07-07). */
  onShare?: () => void
}) {
  const [dismissed, setDismissed] = useState(false)
  const { address: viewer } = useAccount()
  if (dismissed) return null

  // Share & earn (owner 2026-07-07): carry the creator's ?ref so buys through the
  // launch link also pay them the interface slice.
  const ref = viewer ? `&ref=${viewer}` : ''
  const shareUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/token?addr=${addr}&chain=${chainId}${ref}`
      : `/token?addr=${addr}&chain=${chainId}${ref}`
  const text = `I launched $${symbol}: ${holdings.length} tokens, one onchain basket.`
  const xHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`
  const bentoItems: BentoItem[] = holdings.map((h) => ({
    symbol: h.symbol,
    address: h.asset,
    weightPct: h.targetWeightPct,
    chainId,
  }))

  return (
    <div
      className="relative mb-4 overflow-hidden rounded-2xl border p-5"
      style={{ borderColor: `${sig}55`, background: `linear-gradient(135deg, ${sig}24, rgba(255,255,255,0.02) 60%)` }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -top-20 left-1/2 h-44 w-[130%] -translate-x-1/2 opacity-45 blur-3xl"
        style={{ background: sig }}
      />
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="press absolute right-2 top-2 z-10 grid h-9 w-9 place-items-center rounded-full text-ink-dim hover:bg-white/10 hover:text-ink"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>

      <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-2 rounded-full border border-teal/30 bg-teal/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-teal">
            <span className="h-1.5 w-1.5 rounded-full bg-teal" />
            Deployed · live
          </div>
          <h2 className="mt-3 font-display text-2xl font-bold uppercase leading-tight tracking-tight text-ink sm:text-3xl">
            ${symbol} is live
          </h2>
          <p className="mt-1.5 max-w-md text-sm leading-relaxed text-ink-dim">
            {name} · {holdings.length} assets in one onchain basket token.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            {onShare && (
              <button
                type="button"
                onClick={onShare}
                className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 font-display text-sm font-bold uppercase tracking-wide transition-transform hover:scale-[1.02] active:scale-[0.96]"
                style={{ background: sig, color: buyInk }}
              >
                Share your launch
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <path d="M3 15l5-5 4 4 3-3 6 6" />
                </svg>
              </button>
            )}
            <ShareActions xHref={xHref} shareUrl={shareUrl} sig={sig} buyInk={buyInk} subtle={!!onShare} />
          </div>
        </div>

        <div className="w-full shrink-0 sm:w-60">
          <BasketBento items={bentoItems} aspect={2} />
        </div>
      </div>
    </div>
  )
}
