import { useState } from 'react'
import { useActiveChainId } from '../lib/chain/active-chain'
import { INTERFACE_TAG_ADDRESS } from '../lib/config/operator'
import { useAnnouncement } from '../lib/spectrum/notes-social'

// ─────────────────────────────────────────────────────────────────────────────
// The operator's site banner — a zero-backend CMS (owner 2026-07-29): the
// announcement is a note authored by THIS SITE's configured fee wallet about
// THIS chain's factory (both topics pinned at read, so no other wallet can put
// words in the banner), published from /setup with one signature. Latest wins,
// "" or the note's own expiry clears. Dismissal is per-browser per-text.
// ─────────────────────────────────────────────────────────────────────────────

export function OperatorBanner() {
  const chainId = useActiveChainId()
  const { data } = useAnnouncement(chainId, INTERFACE_TAG_ADDRESS)
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem('spectrum:announce-dismissed')
    } catch {
      return null
    }
  })
  if (!data || dismissed === data.text) return null
  const warn = data.level === 'warn'
  return (
    <div
      role="status"
      className={`border-b px-4 py-2.5 ${warn ? 'border-amber/25 bg-amber/[0.07]' : 'border-cyan/20 bg-cyan/[0.05]'}`}
    >
      <div className="mx-auto flex max-w-[1000px] items-center justify-between gap-4 sm:px-2">
        <p className={`min-w-0 flex-1 text-sm leading-snug ${warn ? 'text-amber' : 'text-ink-dim'}`}>
          <span className="mr-2 font-mono text-[9px] uppercase tracking-[0.2em] opacity-70">from this site</span>
          {data.text}
        </p>
        <button
          type="button"
          aria-label="Dismiss announcement"
          onClick={() => {
            setDismissed(data.text)
            try {
              sessionStorage.setItem('spectrum:announce-dismissed', data.text)
            } catch {
              /* storage unavailable */
            }
          }}
          className="press shrink-0 rounded-md px-2 py-1 font-mono text-xs text-ink-faint hover:bg-white/8 hover:text-ink"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
