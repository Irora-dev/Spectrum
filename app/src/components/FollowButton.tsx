import { useFollows } from '../lib/spectrum/follows'

// Follow a creator — stored in THIS browser only (lib/spectrum/follows.ts): no
// server, no account, no cross-device sync. Purely a personal bookmark that powers
// the Explore "Following" filter; it implies nothing about the creator and is never
// surfaced to anyone else.
export function FollowButton({ deployer, className = '' }: { deployer: string | null; className?: string }) {
  const { isFollowing, toggle } = useFollows()
  if (!deployer) return null
  const following = isFollowing(deployer)
  return (
    <button
      type="button"
      aria-pressed={following}
      title="Saved in this browser only"
      onClick={() => toggle(deployer)}
      className={`press inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
        following
          ? 'border-cyan/50 bg-cyan/10 text-cyan'
          : 'border-white/15 text-ink-dim hover:border-white/35 hover:text-ink'
      } ${className}`}
    >
      {following ? '✓ Following' : '+ Follow'}
    </button>
  )
}
