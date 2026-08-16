import { useEffect, useRef, useState } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { basketHref } from '../lib/spectrum/short-url'

// ─────────────────────────────────────────────────────────────────────────────
// SHARE BASKET — the affordance that was missing (QOL round, owner 2026-08-05).
//
// The gap, in the owner's words: "everything has a short URL (/t/r/...) and OG
// cards are built, but there's no visible share affordance — the thing a creator
// does most with their own basket." All the plumbing already existed; the button
// did not, so the most common creator action had no surface.
//
// THE LINK COMES FROM basketHref (lib/spectrum/short-url.ts), never composed by
// hand here. That module owns the `SYMBOL-<8hex>` ref and the chain letter, and
// its whole reason to exist is that a minted link must keep resolving forever —
// a URL assembled in a component is the one that rots the day the shape moves.
//
// Three tiers, chosen by what the device can actually do:
//   · navigator.share → the OS share sheet. A phone's real answer, and where a
//     creator shares from in practice; the sheet is its own confirmation.
//   · clipboard       → copy, confirmed briefly in the label.
//   · neither         → render NOTHING. A self-host served over plain http on a
//     LAN address has no navigator.clipboard at all, and a button that silently
//     does nothing teaches people the site is broken. Absent beats stuck.
//
// Shaped as WatchButton's twin (same two variants, same pill and icon classes)
// because these two sit side by side on both hosts, and a share button that
// almost matched the watch button beside it would look like a bug.
// ─────────────────────────────────────────────────────────────────────────────

function ShareGlyph({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 15V4" />
      <path d="M8.5 7.5L12 4l3.5 3.5" />
      <path d="M5 12v6a2 2 0 002 2h10a2 2 0 002-2v-6" />
    </svg>
  )
}

/** The share core, address-agnostic: the capability ladder, the sheet/copy
 *  tiers and the copied-state live ONCE, here — a surface sharing something
 *  other than a basket (the thesis page) mounts this rather than growing a
 *  lookalike. ShareBasket below stays the basket-shaped wrapper its existing
 *  hosts already use. */
export function ShareAction({
  url,
  sheetTitle,
  variant = 'pill',
  className = '',
}: {
  /** The FULL url to share — composed by the caller's own href authority
   *  (basketHref, thesisHref), never assembled here. */
  url: string
  /** What the OS sheet and the accessible name call the thing being shared. */
  sheetTitle: string
  variant?: 'pill' | 'icon'
  className?: string
}) {
  // Capabilities read once, at mount: navigator.share is absent on most desktop
  // browsers and navigator.clipboard is absent on any insecure origin, and
  // neither of those appears part-way through a session.
  const [can] = useState(() => ({
    share: typeof navigator !== 'undefined' && typeof navigator.share === 'function',
    copy: typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function',
  }))
  const [copied, setCopied] = useState(false)
  const clearTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(clearTimer.current), [])

  if (!can.share && !can.copy) return null

  const titled = sheetTitle

  const doShare = async () => {
    if (can.share) {
      try {
        await navigator.share({ title: titled, url })
        return
      } catch (err) {
        // Dismissing the sheet lands here as AbortError. That is a COMPLETED
        // interaction, not a failure: quietly copying a link somebody just
        // declined to send would be the app arguing with them.
        if ((err as { name?: string } | null)?.name === 'AbortError') return
        // Anything else (no transient activation, an unsupported payload) is a
        // real miss, so the clipboard tier still gets its turn.
        if (!can.copy) return
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.clearTimeout(clearTimer.current)
      clearTimer.current = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // The clipboard can refuse on a permission or focus check. Nothing
      // visible changes and nothing throws — the label simply stays "Share".
    }
  }

  // The confirmation lives in a 10px label, which is invisible to a screen
  // reader; this announces it once, politely. `sr-only` is absolutely
  // positioned, so it costs the host layout nothing.
  const announcement = (
    <span className="sr-only" role="status">
      {copied ? 'Link copied' : ''}
    </span>
  )

  if (variant === 'icon')
    return (
      <>
        <button
          type="button"
          onClick={() => void doShare()}
          aria-label={`Share ${titled}`}
          title={copied ? 'Link copied' : 'Share'}
          className={`press grid h-8 w-8 place-items-center rounded-full border transition-colors ${
            copied
              ? 'border-cyan/50 bg-cyan/10 text-cyan'
              : 'border-white/15 text-ink-faint hover:border-white/35 hover:text-ink'
          } ${className}`}
        >
          <ShareGlyph className="h-4 w-4" />
        </button>
        {announcement}
      </>
    )

  return (
    <>
      <button
        type="button"
        onClick={() => void doShare()}
        aria-label={`Share ${titled}`}
        className={`press inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
          copied
            ? 'border-cyan/50 bg-cyan/10 text-cyan'
            : 'border-white/15 text-ink-dim hover:border-white/35 hover:text-ink'
        } ${className}`}
      >
        <ShareGlyph className="h-3.5 w-3.5" />
        {copied ? 'Link copied' : 'Share'}
      </button>
      {announcement}
    </>
  )
}

export function ShareBasket({
  address,
  symbol,
  chainId,
  name,
  variant = 'pill',
  className = '',
}: {
  address: string
  symbol: string
  chainId: number
  /** The basket's display name — used in the share sheet and in the button's
   *  accessible name; falls back to the ticker when a basket has none. */
  name?: string | null
  /** `pill` beside other actions, `icon` for dense card headers. The same two
   *  shapes WatchButton offers, so the pair needs no wrapper to line up. */
  variant?: 'pill' | 'icon'
  className?: string
}) {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return (
    <ShareAction
      url={`${origin}${basketHref({ symbol, address, chainId })}`}
      sheetTitle={name?.trim() || `$${showSymbol(symbol)}`}
      variant={variant}
      className={className}
    />
  )
}
