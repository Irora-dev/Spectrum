import { Link } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { DEPLOY_ENABLED } from '../lib/config/features'

// "New version" entry point — opens the launch builder prefilled with this
// basket (`/launch?from=…`). A new version is a separate immutable deployment
// the creator anoints as successor via signed metadata (versioning.ts); baskets
// are never edited in place. Shown only to the basket's own deployer, and only
// when deploy is enabled on this build (a creator self-action).
export function VersionButton({
  basket,
  deployer,
  chainId,
  className = '',
  prominent = false,
}: {
  basket: string
  deployer: string | null
  chainId: number
  className?: string
  /** Headline styling (cyan fill + glow) — the Token page's version-strip row. */
  prominent?: boolean
}) {
  const { address } = useAccount()
  if (!DEPLOY_ENABLED) return null
  if (!address || !deployer || address.toLowerCase() !== deployer.toLowerCase()) return null
  // Prominent = the Token-page deployer pair (rides the constituent-icons row,
  // side by side with "Link previous version" — matched pills, owner 2026-07-07).
  const style = prominent
    ? 'h-9 rounded-full border border-cyan/50 bg-cyan/10 px-4 font-semibold text-cyan shadow-[0_0_18px_-6px_rgba(53,224,255,0.55)] hover:border-cyan hover:bg-cyan/20'
    : 'rounded-lg border border-white/12 px-3 py-1.5 text-ink-dim hover:border-cyan/50 hover:text-cyan'
  return (
    <Link
      to={`/launch?from=${basket}&chain=${chainId}`}
      className={`press inline-flex items-center justify-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] ${style} ${className}`}
    >
      ↻ New version
    </Link>
  )
}
