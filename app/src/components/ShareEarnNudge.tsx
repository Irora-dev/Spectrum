import { useState } from 'react'

// The site's gentle "share & earn" affordance (owner 2026-07-07): a one-line
// "your link earns ~5%" hook + Share-on-X / Copy-link, given a ref-carrying
// share link. Used on the swap-success overlay, the swap-complete receipt, and
// Portfolio holdings. A null/absent `share` renders NOTHING — the caller hides
// it that way (e.g. for the basket's own deployer, who has creator surfaces).
//
// Must stay outside any wrapping <a>/Link (it renders anchors + a button — both
// interactive, invalid nested inside an anchor).
export function ShareEarnNudge({
  share,
  className = '',
  center = false,
}: {
  share?: { url: string; xHref: string } | null
  className?: string
  /** Center the action buttons (modals / centered receipts) vs left (cards). */
  center?: boolean
}) {
  const [copied, setCopied] = useState(false)
  if (!share) return null
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(share.url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }
  const btn =
    'press inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan'
  return (
    <div className={className}>
      <p className="font-mono text-[10px] leading-relaxed text-teal/90">
        Your link earns ~5% of the fee on buys through it.{' '}
        <a href="/refer" className="underline underline-offset-2 hover:text-cyan">Refer &amp; earn</a>
      </p>
      <div className={`mt-2 flex gap-2 ${center ? 'justify-center' : ''}`}>
        <a href={share.xHref} target="_blank" rel="noreferrer" className={btn}>
          Share on X
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 17L17 7M7 7h10v10" />
          </svg>
        </a>
        <button type="button" onClick={() => void copy()} className={btn}>
          {copied ? 'Link copied' : 'Copy link'}
        </button>
      </div>
    </div>
  )
}
