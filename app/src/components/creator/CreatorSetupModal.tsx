import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { ClaimHandle } from './ClaimHandle'

// ─────────────────────────────────────────────────────────────────────────────
// THE CREATOR SETUP CEREMONY (the owner live 2026-08-15: "this creator setup needs
// to pop up after you seed the basket in the same design as the seed pop up,
// make it beautiful; if we detect the user already has a creator page then we
// just prompt them to go visit the basket… on its own page or on the creator
// page"). SeedBasketModal's own shell — the gradient hairline, the eyebrow,
// the display headline — and the REAL ClaimHandle inside (the reuse law), so
// the claim behaves identically everywhere it appears. The has-name branch
// celebrates instead of asking twice.
// ─────────────────────────────────────────────────────────────────────────────

export function CreatorSetupModal({
  open,
  onClose,
  symbol,
  /** The viewer's claimed handle, when they have one — flips the celebration
   *  branch. null = no name yet, the claim branch renders. */
  handle,
  /** The creator page a claimed name owns (absent while unnamed). */
  creatorHref,
}: {
  open: boolean
  onClose: () => void
  symbol: string
  handle: string | null
  creatorHref: string | null
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-void/85 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={handle ? 'Your basket is live' : 'Claim your creator name'}
        onClick={(e) => e.stopPropagation()}
        className="search-pop relative my-8 w-full max-w-lg overflow-hidden rounded-3xl card-surface backdrop-blur-md"
      >
        <div aria-hidden className="h-1 w-full shrink-0" style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-teal">✓ ${showSymbol(symbol)} seeded</div>
              <h2 className="mt-1 font-display text-3xl font-bold tracking-tight text-ink">
                {handle ? 'You’re live.' : 'Claim your name'}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="press grid h-10 w-10 shrink-0 place-items-center rounded-lg text-ink-dim hover:bg-white/8 hover:text-ink"
            >
              ✕
            </button>
          </div>

          {handle ? (
            <>
              <p className="mt-3 text-base leading-relaxed text-ink-dim">
                ${showSymbol(symbol)} now shows on your creator page as <span className="text-ink">/{'creator'}/{handle}</span>.
                Watch it, share it, or keep building.
              </p>
              <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
                <button
                  type="button"
                  onClick={onClose}
                  className="spectral-btn press flex-1 rounded-xl py-3 text-center font-display text-sm font-bold uppercase tracking-[0.14em] text-void"
                >
                  View the basket →
                </button>
                {creatorHref && (
                  <Link
                    to={creatorHref}
                    onClick={onClose}
                    className="press flex-1 rounded-xl border border-white/12 py-3 text-center font-display text-sm font-bold uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-ink"
                  >
                    Your creator page →
                  </Link>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="mt-3 text-base leading-relaxed text-ink-dim">
                Your basket is trading. One last touch: turn your creator page from a wallet address into a
                name people can read and remember.
              </p>
              {/* the REAL claim — same registry, same verdicts, same tx as
                  everywhere else this offer appears */}
              <ClaimHandle className="mt-5" onClaimed={() => undefined} />
              <button type="button" onClick={onClose} className="mt-4 w-full text-center font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink">
                maybe later — the offer stays on this page
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
