import { shortAddr } from '../lib/spectrum/format'
import { useCopy } from '../lib/use-copy'

// ── the one click-to-copy address ────────────────────────────────────────────
// QOL round 2026-08-05 #6: "copy-address affordances are inconsistent. Some
// surfaces let you copy a contract address, others just truncate it." Every
// truncated address should be the SAME control, and tapping it should put the
// FULL address on the clipboard, never the shortened text a reader can see.
//
// The behaviour is not written twice: it comes from `lib/use-copy`, extracted
// from the DocKit chip that already did this properly, and the glyph and pill
// metrics match that chip so all of it still reads as one control. What this
// adds is the part an address needs and a general copy chip has no prop for: a
// real accessible name ("Copy basket address"), because a screen reader
// otherwise announces nothing but a spelled-out hex fragment, plus a spoken
// confirmation to go with the visual one. (DocKit belongs to another lane this
// round, so CopyChip keeps its own button until someone folds the two together.)
function ClipboardGlyph({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}
function CheckGlyph({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function CopyAddress({
  address,
  what = 'address',
  size = 'sm',
  className = '',
}: {
  address: string | null | undefined
  /** Names what gets copied, for the accessible name: "Copy basket address". */
  what?: string
  /** xs = dense rows (a search hit, a card's identity block); sm = everywhere else. */
  size?: 'xs' | 'sm'
  /** Layout only (spacing, `shrink-0`) — the chip owns its own chrome. */
  className?: string
}) {
  const { copied, copy } = useCopy()
  // A summary row can reach us before its address does; render nothing rather
  // than an affordance that would copy an empty string.
  if (!address) return null
  const chrome = size === 'xs' ? 'h-5 gap-1 px-2 text-[10px]' : 'h-6 gap-1.5 px-2.5 text-[11px]'
  const glyph = size === 'xs' ? 'h-2.5 w-2.5' : 'h-3 w-3'
  return (
    <span className={`inline-flex items-center ${className}`}>
      <button
        type="button"
        onClick={() => void copy(address)}
        title={address}
        aria-label={`Copy ${what}`}
        className={`press inline-flex max-w-full items-center rounded-full border font-mono ${chrome} ${
          copied
            ? 'border-cyan/60 bg-cyan/10 text-cyan'
            : 'border-white/10 bg-white/[0.04] text-ink-dim hover:border-cyan/50 hover:text-ink'
        }`}
      >
        <span className="truncate">{copied ? 'Copied' : shortAddr(address)}</span>
        {copied ? <CheckGlyph className={`shrink-0 ${glyph}`} /> : <ClipboardGlyph className={`shrink-0 opacity-60 ${glyph}`} />}
      </button>
      {/* the flourish is otherwise visual only; say it once, politely */}
      <span role="status" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
    </span>
  )
}
