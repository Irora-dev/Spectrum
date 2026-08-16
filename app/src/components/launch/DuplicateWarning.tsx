import { Link } from 'react-router'
import { showName, showSymbol } from '../../lib/spectrum/safe-copy'
import { basketHref } from '../../lib/spectrum/short-url'
import { useAllBaskets } from '../../lib/spectrum/hooks'
import {
  duplicateWarning,
  findDuplicates,
  type CandidateBasket,
} from '../../lib/spectrum/launch-duplicates'

// ─────────────────────────────────────────────────────────────────────────────
// "IS THIS ALREADY OUT THERE?" — the duplicate check before paying (the owner
// 2026-08-13, greenlit).
//
// A WARNING WITH A LINK, NEVER A BLOCK. Two creators arriving at the same three
// blue chips is not a mistake, and neither is shipping your own idea again for
// a different audience — but finding out AFTER the gas is spent is. So this
// says what already exists and hands over the door to it; the deploy button
// beside it is untouched.
//
// It costs no new network: useAllBaskets is already in cache on every surface
// that could host this, so this only re-reads rows the page has.
//
// And it does not overclaim. When a row's leg list is not demonstrably whole,
// the mix cannot be compared and the component says "no name or ticker match"
// rather than "no duplicate" — the difference between what was checked and what
// is true.
// ─────────────────────────────────────────────────────────────────────────────

export function DuplicateWarning({
  candidate,
  /** Show a quiet all-clear when nothing collides. Off by default: a launch
   *  flow does not need a green tick on every keystroke. */
  showAllClear = false,
  className = '',
}: {
  candidate: CandidateBasket
  showAllClear?: boolean
  className?: string
}) {
  const { data: all } = useAllBaskets()
  // No list = nothing was checked. Never an all-clear off an absent read.
  if (!all) return null

  const report = findDuplicates(candidate, all)
  const line = duplicateWarning(report)

  if (!line) {
    if (!showAllClear) return null
    return (
      <p className={`font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint ${className}`}>
        {report.mixCheckable
          ? 'nothing else on this network shares its name, ticker or mix'
          : 'no name or ticker match on this network'}
      </p>
    )
  }

  return (
    <div className={`rounded-xl border border-amber/35 bg-amber/[0.06] px-3.5 py-3 ${className}`}>
      <p className="font-mono text-[11px] leading-relaxed text-amber">{line}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {report.hits.slice(0, 3).map((h) => (
          <Link
            key={`${h.basket.chainId}:${h.basket.address}`}
            to={basketHref(h.basket)}
            title={`Open ${showName(h.basket.name)}`}
            className="press inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/12 px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim transition-colors hover:border-amber/50 hover:text-amber"
          >
            <span className="font-bold">${showSymbol(h.basket.symbol)}</span>
            <span className="truncate text-ink-faint">{showName(h.basket.name)}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
