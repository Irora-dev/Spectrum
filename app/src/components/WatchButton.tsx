import { useWatchlist } from '../lib/spectrum/watchlist'

// Watch a basket — stored in THIS browser only (lib/spectrum/watchlist.ts): no
// server, no account, no cross-device sync. The basket-side sibling of
// FollowButton (creators). Powers the Explore "Watching" filter; implies nothing
// about the basket and is never surfaced to anyone else.
//
// Two shapes: the default pill (matches FollowButton) and `icon` (a bare heart
// for dense surfaces like basket cards).
export function WatchButton({
  basket,
  chainId,
  variant = 'pill',
  className = '',
}: {
  basket: string | null
  chainId: number
  variant?: 'pill' | 'icon'
  className?: string
}) {
  const { isWatched, toggle } = useWatchlist()
  if (!basket) return null
  const on = isWatched(chainId, basket)
  const label = on ? 'Watching' : 'Watch'

  if (variant === 'icon') {
    return (
      <button
        type="button"
        aria-pressed={on}
        aria-label={on ? 'Watching, remove from watchlist' : 'Add to watchlist'}
        title="Saved in this browser only"
        onClick={() => toggle(chainId, basket)}
        className={`press grid h-8 w-8 place-items-center rounded-full border transition-colors ${
          on
            ? 'border-cyan/50 bg-cyan/10 text-cyan'
            : 'border-white/15 text-ink-faint hover:border-white/35 hover:text-ink'
        } ${className}`}
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
      </button>
    )
  }

  return (
    <button
      type="button"
      aria-pressed={on}
      title="Saved in this browser only"
      onClick={() => toggle(chainId, basket)}
      className={`press inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
        on
          ? 'border-cyan/50 bg-cyan/10 text-cyan'
          : 'border-white/15 text-ink-dim hover:border-white/35 hover:text-ink'
      } ${className}`}
    >
      <svg viewBox="0 0 24 24" className="h-3 w-3" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z" />
      </svg>
      {label}
    </button>
  )
}
