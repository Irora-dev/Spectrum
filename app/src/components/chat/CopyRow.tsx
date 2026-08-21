// The chat's copyable link row + the cheer event, lifted out of Chat.tsx so
// other chat cards (BundleCard) reuse the REAL component rather than a
// lookalike. Same markup, same behavior: copy → teal tick + ghost thumbs-up.
import { useState } from 'react'

const GRADIENT = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

/** Confirmed small wins (a copy landed, a deploy confirmed) cheer the ghost
 *  from module-level blocks without prop-drilling the mascot handle. */
export const cheerSpecter = () => window.dispatchEvent(new Event('specter:cheer'))

/** A copyable link row (share / referral / bundle). */
export function CopyRow({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-xl border border-white/[0.12] bg-white/[0.04] p-1.5 pl-3">
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-dim">{url}</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(url).then(() => {
            setCopied(true)
            cheerSpecter()
            setTimeout(() => setCopied(false), 1600)
          })
        }}
        className="shrink-0 rounded-lg px-3 py-1.5 font-display text-[12px] font-bold text-void"
        style={{ background: copied ? 'var(--color-teal)' : GRADIENT }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
