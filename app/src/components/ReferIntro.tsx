import { useState } from 'react'
import { refLinkFor } from '../lib/spectrum/referral'
import { InfoDot } from './InfoDot'

// ─────────────────────────────────────────────────────────────────────────────
// THE EARN INVITE, introduced properly (owner 2026-08-02 ~19:3x: "the fees and
// claims popup that appears should have a beautiful intro to the person's earn
// referral invite link"). Fees & claims is where someone already stands looking
// at money this wallet has earned — the one honest moment to mention there is
// another way to earn here.
//
// THE COPY FOLLOWS THE SCOPE FREEZE'S REPOSITIONING: "Earn, repositioned —
// refer someone to MANAGE A PORTFOLIO, not to build a basket." So the invite
// points at the portfolio flow and says portfolio, never basket.
//
// WHAT IT DELIBERATELY DOES NOT SAY: no rate, no projected earnings, no "earn
// X%". The screening rules hard-stop on operator-earnings projections, and the
// real split is a contracts fact this component has no business restating. It
// says what the link DOES; the Earn page owns the terms.
// ─────────────────────────────────────────────────────────────────────────────

export function ReferIntro({ handle, href = '/create' }: { handle: string; href?: string }) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const link = refLinkFor(handle, origin, href)
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // clipboard blocked (insecure origin, denied permission) — the field is
      // selectable, so the link is never trapped behind a button that failed
      setCopied(false)
    }
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      {/* one spectral hairline, the house signature for a money-adjacent beat */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
      />
      <p className="font-display text-[15px] font-bold leading-snug text-ink">
        Earn from the people you bring
      </p>
      {/* one line (the owner 2026-08-06 12:18) — the full mechanics ride the ⓘ */}
      <p className="mt-2 flex items-center gap-1.5 text-[12px] leading-relaxed text-ink-dim">
        Invite someone; earn a share of what they pay, for as long as they use it.
        <InfoDot>
          Your link invites someone to build and manage their own portfolio here. When they do,
          you earn a share of what they pay to use it, for as long as they keep using it.
        </InfoDot>
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Your invite link"
          className="h-10 min-w-0 flex-1 rounded-xl border border-white/12 bg-white/[0.03] px-3 font-mono text-[11px] text-ink-dim focus:border-cyan/50 focus:text-ink focus:outline-none"
        />
        <button
          type="button"
          onClick={copy}
          className="press inline-flex h-10 shrink-0 items-center rounded-xl border border-white/15 px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
        >
          {copied ? 'Copied ✓' : 'Copy link'}
        </button>
        <a
          href="/earn"
          className="press inline-flex h-10 shrink-0 items-center rounded-xl border border-white/15 px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-white/40 hover:text-ink"
        >
          How it works
        </a>
      </div>
    </div>
  )
}
