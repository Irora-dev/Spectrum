import { useState } from 'react'
import { useAccount, useEnsName } from 'wagmi'
import { getStoredRef } from '../lib/spectrum/referral'
import { shortAddr } from '../lib/spectrum/format'
import { MAINNET_CHAIN_ID } from '../lib/chain/constants'

const DISMISS_KEY = 'spectrum:ref-banner-dismissed'

// Shown to a REFERRED visitor (owner 2026-07-07): a quiet, dismissible bar that
// discloses who referred them and that the referrer earns a fee slice, at no
// extra cost. Transparency (and the buyer-side §9 disclosure). Site-wide via
// Layout; self-hides when there's no ref or the ref is the connected wallet.
export function ReferredBanner() {
  const ref = getStoredRef()
  const { address } = useAccount()
  const { data: ensName } = useEnsName({ address: ref ?? undefined, chainId: MAINNET_CHAIN_ID })
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === ref?.toLowerCase()
    } catch {
      return false
    }
  })
  if (!ref || dismissed) return null
  // don't nag someone who's using their own link
  if (address && address.toLowerCase() === ref.toLowerCase()) return null

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, ref.toLowerCase())
    } catch {
      /* ignore */
    }
    setDismissed(true)
  }

  return (
    <div className="border-b border-violet/20 bg-violet/[0.06]">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2 sm:px-6">
        <span className="min-w-0 font-mono text-[11px] leading-relaxed text-ink-dim">
          Referred by <span className="text-ink">{ensName ?? shortAddr(ref)}</span> — they earn a slice of the
          protocol fee on your trades, at no extra cost to you.
        </span>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="press grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-white/8 hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  )
}
